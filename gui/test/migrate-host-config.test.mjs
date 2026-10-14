import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CONFIG_ROOT } from './helpers.mjs'

/*
 * tools/migrate-host-config.mjs, only ever on temporary copies: lossless
 * (before/after sha256 of every moved file), a second run changes nothing, an
 * existing target is never overwritten, a move manifest's in-place files stay
 * byte for byte where they are, also in the state a delivered patch leaves
 * (applied without --index: the patch's new files untracked), and on a copy of
 * this tree every manifest entry is carried out and the configuration is found
 * in the host directory.
 */

const SCRIPT = path.join(CONFIG_ROOT, 'tools/migrate-host-config.mjs')
const SKIP_DIRS = new Set(['node_modules', '.git', '.browser', 'dist', 'issues', 'logs', 'cert', 'runtime', 'host-config', '__pycache__'])
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { encoding: 'utf8' })
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const write = async (file, text, mode = 0o644) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); await fs.chmod(file, mode) }
const ignored = (root, rel) => spawnSync('git', ['-C', root, 'check-ignore', '-q', '--no-index', '--', rel]).status === 0
const tracked = (root, rel) => git(root, 'ls-files', '--', rel).trim() !== ''

// The script's default host directory is <root>/host-config: the runner's setting is not passed on.
function migrate (root, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, DEVPANEL_HOST_CONFIG_DIR: '' } })
  let manifest = null
  try { manifest = JSON.parse(r.stdout) } catch { /* reported by the caller */ }
  return { code: r.status, manifest, output: r.stdout + r.stderr }
}

/** Every file under a directory (outside .git) with its sha256 and mode. */
async function manifest (dir) {
  const out = {}
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (e.name !== '.git') await walk(p) } else if (e.isFile()) out[path.relative(dir, p)] = `${sha(await fs.readFile(p))} ${((await fs.stat(p)).mode & 0o777).toString(8)}`
    }
  }
  await walk(dir)
  return out
}

export default async function (t) {
  const temps = []
  const temp = async (prefix) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); temps.push(d); return d }
  try {
    t.section('1. a synthetic checkout: dry run, refusals, lossless move, untracking, second run')
    {
      const root = await temp('devpanel-migrate-')
      git(root, 'init', '-q')
      await fs.copyFile(path.join(CONFIG_ROOT, '.gitignore'), path.join(root, '.gitignore'))
      await write(path.join(root, 'projects/a-project.yaml'), 'id: a-project\n')
      await write(path.join(root, 'projects/b-project.yaml'), 'id: b-project\n')
      await write(path.join(root, 'roster/person.yaml'), 'id: person\naccount: someone\n')
      await write(path.join(root, 'roster/catalogue.yaml'), 'id: catalogue\n')
      await write(path.join(root, 'tools/releases/site-targets.json'), '{"staging":{}}\n')
      await write(path.join(root, 'tools/releases/site.py'), 'print(1)\n', 0o755)
      await write(path.join(root, 'gui/live/reports/r.json'), '{}\n')
      await write(path.join(root, 'gui/live/reports/run.results'), 'ok\n', 0o755)
      await write(path.join(root, 'README.md'), 'readme\n')
      git(root, 'add', '-A')
      git(root, 'add', '-f', 'projects', 'roster', 'tools', 'gui')
      git(root, 'commit', '-q', '-m', 'fixture')
      const host = path.join(root, 'host-config')
      const moving = ['projects/a-project.yaml', 'projects/b-project.yaml', 'roster/person.yaml', 'tools/releases/site-targets.json', 'gui/live/reports/r.json', 'gui/live/reports/run.results']
      const before = await manifest(root)
      const index = () => git(root, 'ls-files', '-s')
      const indexBefore = index()

      const dry = migrate(root, '--dry-run')
      t.eq('a dry run succeeds and lists what would move', [dry.code, dry.manifest?.entries.map((e) => e.from).sort()], [0, [...moving].sort()], dry.output.slice(0, 300))
      t.ok('and changes nothing', JSON.stringify(await manifest(root)) === JSON.stringify(before) && index() === indexBefore)

      await write(path.join(host, 'projects/a-project.yaml'), 'id: something-else\n')
      const conflict = migrate(root)
      t.eq('a target with different bytes refuses the whole run', [conflict.code, conflict.manifest?.refused?.some((r) => r.includes('never overwritten'))], [2, true], conflict.output.slice(0, 300))
      t.eq('the existing target is not overwritten', await fs.readFile(path.join(host, 'projects/a-project.yaml'), 'utf8'), 'id: something-else\n')
      const afterConflict = await manifest(root)
      delete afterConflict['host-config/projects/a-project.yaml']
      t.ok('and nothing else changed, the index included', JSON.stringify(afterConflict) === JSON.stringify(before) && index() === indexBefore)
      await fs.rm(path.join(host, 'projects/a-project.yaml'))

      const notIgnored = migrate(root, '--to', path.join(root, 'kept-here'))
      t.eq('a target inside the checkout that Git does not ignore is refused', [notIgnored.code, notIgnored.manifest?.refused?.some((r) => r.includes('not ignored'))], [2, true])

      await write(path.join(host, 'projects/b-project.yaml'), 'id: b-project\n')
      const presentInode = (await fs.stat(path.join(host, 'projects/b-project.yaml'))).ino

      const run = migrate(root)
      t.eq('the migration succeeds', run.code, 0, run.output.slice(0, 400))
      t.eq('its manifest accounts for every file', run.manifest?.totals, { files: 6, copied: 5, alreadyPresent: 1, alreadyMoved: 0, excluded: 0, removed: 6 })
      const after = await manifest(host)
      t.ok('before/after sha256 and mode of every moved file match', moving.every((from) => {
        const entry = run.manifest.entries.find((e) => e.from === from)
        return entry && after[path.relative(host, entry.to)] === before[from] && entry.sha256 === before[from].split(' ')[0]
      }), JSON.stringify({ before, after }))
      t.eq('the executable bit is kept', after['live-reports/run.results'], before['gui/live/reports/run.results'])
      t.eq('an identical existing target is left as it was', [(await fs.stat(path.join(host, 'projects/b-project.yaml'))).ino, run.manifest?.entries.find((e) => e.from === 'projects/b-project.yaml')?.action], [presentInode, 'already-present'])
      const left = await manifest(root)
      t.ok('the originals are gone from the tree', moving.every((from) => !(from in left)))
      t.eq('the rest of the tree is untouched', ['roster/catalogue.yaml', 'tools/releases/site.py', 'README.md', '.gitignore'].map((f) => left[f]), ['roster/catalogue.yaml', 'tools/releases/site.py', 'README.md', '.gitignore'].map((f) => before[f]))
      t.eq('the originals are untracked, staged for the next commit', git(root, 'diff', '--cached', '--name-status').trim().split('\n').sort(), moving.map((f) => `D\t${f}`).sort())
      t.eq('git status shows nothing of host-config', git(root, 'status', '--porcelain', '--untracked-files=all').split('\n').filter((l) => l.includes('host-config')), [])

      const hostBefore = await manifest(host)
      const again = migrate(root)
      t.eq('a second run finds nothing to move', [again.code, again.manifest?.entries.length], [0, 0])
      t.ok('and changes nothing', JSON.stringify(await manifest(root)) === JSON.stringify(left) && JSON.stringify(await manifest(host)) === JSON.stringify(hostBefore))
    }

    t.section('1b. an original is never its own copy: links and aliases refuse the run before anything changes')
    {
      const base = await temp('devpanel-migrate-links-')
      const tree = path.join(base, 'tree')
      const source = path.join(tree, 'projects/a.yaml')
      await write(source, 'id: a\n')
      const digest = sha(await fs.readFile(source))
      const refused = async (name, run, words) => {
        t.eq(`${name}: refused`, [run.code, run.manifest?.refused?.some((r) => r.includes(words))], [2, true], run.output.slice(0, 400))
        t.eq(`${name}: the original is still there, unchanged`, await fs.readFile(source).then(sha, () => null), digest)
      }

      // auditor-1's reproduction: host/projects is a link to tree/projects.
      await fs.mkdir(path.join(base, 'alias'))
      await fs.symlink(path.join(tree, 'projects'), path.join(base, 'alias/projects'))
      await refused('a target category directory linked to its source', migrate(tree, '--to', path.join(base, 'alias')), 'symbolic link')

      await fs.mkdir(path.join(base, 'real-host'))
      await fs.symlink(path.join(base, 'real-host'), path.join(base, 'host-link'))
      await refused('a linked target directory', migrate(tree, '--to', path.join(base, 'host-link')), 'symbolic link')
      t.eq('and nothing was written through it', await fs.readdir(path.join(base, 'real-host')), [])

      const other = path.join(base, 'other')
      await write(path.join(other, 'b.yaml'), 'id: b\n')
      const linked = path.join(base, 'linked-tree')
      await write(path.join(linked, 'README.md'), 'readme\n')
      await fs.symlink(other, path.join(linked, 'projects'))
      const linkedRun = migrate(linked, '--to', path.join(base, 'linked-host'))
      t.eq('a linked source category directory: refused', [linkedRun.code, linkedRun.manifest?.refused?.some((r) => r.includes('symbolic link'))], [2, true], linkedRun.output.slice(0, 400))
      t.eq('and the file behind it is still there', await fs.readFile(path.join(other, 'b.yaml'), 'utf8'), 'id: b\n')

      // A link above --to: <link>/tree is the source tree itself, so its projects/ is the source's.
      await fs.symlink(base, path.join(base, 'up'))
      await refused('a target that is the source by real path', migrate(tree, '--to', path.join(base, 'up/tree')), 'same directory')

      const hard = path.join(base, 'hard')
      await fs.mkdir(path.join(hard, 'projects'), { recursive: true })
      await fs.link(source, path.join(hard, 'projects/a.yaml'))
      await refused('a target that is the same file (a hard link)', migrate(tree, '--to', hard), 'same file')
    }

    t.section('1c. a move manifest on a committed checkout: host:, root: and in-place entries')
    {
      const root = await temp('devpanel-manifest-')
      git(root, 'init', '-q')
      await fs.copyFile(path.join(CONFIG_ROOT, '.gitignore'), path.join(root, '.gitignore'))
      await write(path.join(root, 'docs/history/old.md'), 'a dated record\n')
      await write(path.join(root, 'tools/site/site.py'), 'print(1)\n', 0o755)
      await write(path.join(root, 'tools/host-move/files/CLAUDE.local.md'), '# local notes\n')
      await write(path.join(root, 'tools/host-move/files/roster/x.yaml'), 'id: x\n')
      await write(path.join(root, 'README.md'), 'readme\n')
      const entries = [
        { from: 'tools/host-move/files/CLAUDE.local.md', to: 'root:CLAUDE.local.md' },
        { from: 'tools/host-move/files/roster/x.yaml', to: 'host:roster/x.yaml' },
        { from: 'docs/history/old.md', to: 'host:docs/history/old.md' },
        { from: 'tools/site/site.py', to: 'in-place' },
        { from: 'tools/host-move/manifest.json', to: 'host:moved/host-move-manifest.json' }
      ]
      await write(path.join(root, 'tools/host-move/manifest.json'), JSON.stringify({ entries }, null, 2) + '\n')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'base')
      const host = path.join(root, 'host-config')
      // Refused manifests live under the git-ignored host-config/, so the checkout stays clean.
      const bad = async (name, list) => { await write(path.join(host, 'bad', name), JSON.stringify({ entries: list })); return path.join('host-config', 'bad', name) }
      await fs.symlink('README.md', path.join(root, 'link.md'))
      git(root, 'add', 'link.md')
      git(root, 'commit', '-q', '-m', 'link')
      const refusals = [
        ['a path that climbs out', await bad('up.json', [{ from: '../outside.md', to: 'host:x.md' }]), 'plain relative path'],
        ['an absolute target', await bad('abs.json', [{ from: 'README.md', to: 'host:/etc/x' }]), 'plain relative path'],
        ['a root: target Git does not ignore', await bad('root.json', [{ from: 'README.md', to: 'root:kept/README.md' }]), 'not ignored'],
        ['a source and a target that are both missing', await bad('missing.json', [{ from: 'nope.md', to: 'host:nope.md' }]), 'does not exist'],
        ['a source that is a symbolic link', await bad('link.json', [{ from: 'link.md', to: 'host:link.md' }]), 'symbolic link']
      ]
      const before = await manifest(root)
      const index = () => git(root, 'ls-files', '-s')
      const indexBefore = index()
      const unchanged = async () => JSON.stringify(await manifest(root)) === JSON.stringify(before) && index() === indexBefore

      const dry = migrate(root, '--dry-run')
      t.eq('a dry run lists every entry', [dry.code, dry.manifest?.entries.map((e) => e.from)], [0, entries.map((e) => e.from)], dry.output.slice(0, 300))
      t.ok('and changes nothing', await unchanged())
      for (const [label, file, words] of refusals) {
        const r = migrate(root, '--manifest', file)
        t.eq(`${label}: refused`, [r.code, r.manifest?.refused?.some((x) => x.includes(words))], [2, true], r.output.slice(0, 300))
        t.ok(`${label}: nothing changed, the index included`, await unchanged())
      }
      await write(path.join(host, 'roster/x.yaml'), 'id: something-else\n')
      const conflict = migrate(root)
      t.eq('a target with different bytes refuses the whole run', [conflict.code, conflict.manifest?.refused?.some((r) => r.includes('never overwritten'))], [2, true])
      t.eq('the target is not overwritten', await fs.readFile(path.join(host, 'roster/x.yaml'), 'utf8'), 'id: something-else\n')
      await fs.rm(path.join(host, 'roster/x.yaml'))
      t.ok('and nothing else changed', await unchanged())

      const run = migrate(root)
      t.eq('the move succeeds', run.code, 0, run.output.slice(0, 400))
      t.eq('its manifest accounts for every entry', run.manifest?.totals, { files: 5, copied: 4, alreadyPresent: 0, alreadyMoved: 0, excluded: 1, removed: 4 })
      const after = await manifest(host)
      t.eq('every moved file keeps its sha256 and mode', ['roster/x.yaml', 'docs/history/old.md', 'moved/host-move-manifest.json'].map((f) => after[f]),
        ['tools/host-move/files/roster/x.yaml', 'docs/history/old.md', 'tools/host-move/manifest.json'].map((f) => before[f]))
      t.eq('a root: target is in the checkout, byte for byte, and ignored', [(await manifest(root))['CLAUDE.local.md'], ignored(root, 'CLAUDE.local.md')], [before['tools/host-move/files/CLAUDE.local.md'], true])
      const left = await manifest(root)
      t.ok('the moved originals are gone from the tree', ['docs/history/old.md', 'tools/host-move/files/roster/x.yaml', 'tools/host-move/files/CLAUDE.local.md', 'tools/host-move/manifest.json'].every((f) => !(f in left)), Object.keys(left).join(' '))
      const inPlace = run.manifest.entries.find((e) => e.from === 'tools/site/site.py')
      t.eq('an in-place file stays where it is, byte for byte and mode', (await manifest(root))['tools/site/site.py'], before['tools/site/site.py'])
      t.eq('excluded through info/exclude, untracked, never removed', [inPlace?.action, inPlace?.removed ?? false, ignored(root, 'tools/site/site.py'), tracked(root, 'tools/site/site.py')], ['excluded', false, true, false])
      t.ok('the exclude is the repository\'s own, never a tracked file', (await fs.readFile(path.join(root, '.git/info/exclude'), 'utf8')).split('\n').includes('/tools/site/site.py') && !(await fs.readFile(path.join(root, '.gitignore'), 'utf8')).includes('site.py'))
      t.eq('the originals are untracked, staged for the next commit', git(root, 'diff', '--cached', '--name-status').trim().split('\n').sort(),
        ['D\tdocs/history/old.md', 'D\ttools/host-move/files/CLAUDE.local.md', 'D\ttools/host-move/files/roster/x.yaml', 'D\ttools/host-move/manifest.json', 'D\ttools/site/site.py'])
      t.eq('and nothing else shows in git status', git(root, 'status', '--porcelain', '--untracked-files=all').split('\n').filter((l) => l && !l.startsWith('D ')), [])

      const treeAfter = await manifest(root)
      const again = migrate(root)
      t.ok('a second run finds nothing to move and changes nothing', again.code === 0 && again.manifest.entries.length === 0 && JSON.stringify(await manifest(root)) === JSON.stringify(treeAfter) && JSON.stringify(await manifest(host)) === JSON.stringify(after))

      // A run that stopped after removing the originals but before the manifest: put it back and finish.
      await write(path.join(root, 'tools/host-move/manifest.json'), await fs.readFile(path.join(host, 'moved/host-move-manifest.json'), 'utf8'))
      const finish = migrate(root)
      t.eq('an interrupted run is finished by running it again', [finish.code, finish.manifest?.entries.map((e) => e.action)], [0, ['already-moved', 'already-moved', 'already-moved', 'excluded-untracked', 'already-present']], finish.output.slice(0, 300))
      t.ok('leaving the in-place file and every target as they were', JSON.stringify(await manifest(root)) === JSON.stringify(treeAfter) && JSON.stringify(await manifest(host)) === JSON.stringify(after))
    }

    t.section('1d. the delivered state: a patch applied without --index, its new files untracked')
    {
      const root = await temp('devpanel-delivered-')
      git(root, 'init', '-q')
      const gitignore = await fs.readFile(path.join(CONFIG_ROOT, '.gitignore'), 'utf8')
      await write(path.join(root, '.gitignore'), gitignore.replace('/CLAUDE.local.md\n', ''))
      await write(path.join(root, 'tools/site/site.py'), 'print(1)\n', 0o755)
      await write(path.join(root, 'tools/site/old-name.mjs'), 'export const old = 1\n')
      await write(path.join(root, 'README.md'), 'readme\n')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'base')
      // What delivery leaves: tracked files modified, new files untracked, nothing staged.
      await write(path.join(root, '.gitignore'), gitignore)
      await write(path.join(root, 'tools/site/old-name.mjs'), "import './new-name.mjs'\n")
      await write(path.join(root, 'tools/site/test_new.py'), 'print(2)\n')
      await write(path.join(root, 'tools/host-move/files/CLAUDE.local.md'), '# local notes\n')
      await write(path.join(root, 'tools/host-move/files/settings.json'), '{}\n')
      const entries = [
        { from: 'tools/host-move/files/CLAUDE.local.md', to: 'root:CLAUDE.local.md' },
        { from: 'tools/host-move/files/settings.json', to: 'host:settings.json' },
        { from: 'tools/site/site.py', to: 'in-place' },
        { from: 'tools/site/old-name.mjs', to: 'in-place' },
        { from: 'tools/site/test_new.py', to: 'in-place' },
        { from: 'tools/host-move/manifest.json', to: 'host:moved/host-move-manifest.json' }
      ]
      await write(path.join(root, 'tools/host-move/manifest.json'), JSON.stringify({ entries }, null, 2) + '\n')
      t.eq('nothing is staged, the new files are untracked', [git(root, 'diff', '--cached', '--name-only').trim(), tracked(root, 'tools/site/test_new.py'), tracked(root, 'tools/host-move/manifest.json')], ['', false, false])
      const before = await manifest(root)
      const host = path.join(root, 'host-config')

      const run = migrate(root)
      t.eq('the move succeeds', run.code, 0, run.output.slice(0, 400))
      const action = (from) => run.manifest?.entries.find((e) => e.from === from)
      t.eq('a new, untracked in-place file is only excluded', [action('tools/site/test_new.py')?.action, action('tools/site/test_new.py')?.removed ?? false], ['excluded-untracked', false])
      const after = await manifest(root)
      t.eq('it is still there, byte for byte, ignored and untracked', [after['tools/site/test_new.py'], ignored(root, 'tools/site/test_new.py'), tracked(root, 'tools/site/test_new.py')], [before['tools/site/test_new.py'], true, false])
      t.eq('a tracked in-place file modified by the patch keeps its working bytes, untracked', [after['tools/site/old-name.mjs'], action('tools/site/old-name.mjs')?.action, tracked(root, 'tools/site/old-name.mjs')], [before['tools/site/old-name.mjs'], 'excluded', false])
      t.eq('the carried files are copied and gone from the checkout', [(await manifest(host))['settings.json'], after['CLAUDE.local.md'], 'tools/host-move/files/settings.json' in after, 'tools/host-move/manifest.json' in after], [before['tools/host-move/files/settings.json'], before['tools/host-move/files/CLAUDE.local.md'], false, false])
      git(root, 'add', '-A')
      t.eq('a checkpoint (git add -A) then commits only the neutral change', git(root, 'diff', '--cached', '--name-status').trim().split('\n').sort(), ['D\ttools/site/old-name.mjs', 'D\ttools/site/site.py', 'M\t.gitignore'])
      const treeAfter = await manifest(root)
      const hostAfter = await manifest(host)
      const again = migrate(root)
      t.ok('a second run finds nothing to move and changes nothing', again.code === 0 && again.manifest.entries.length === 0 && JSON.stringify(await manifest(root)) === JSON.stringify(treeAfter) && JSON.stringify(await manifest(host)) === JSON.stringify(hostAfter))
    }

    t.section('2. a copy of this tree: every manifest entry carried out, the configuration found in the host directory')
    {
      // Copied by walking the filesystem, so a rebuilt candidate without Git works too.
      const copy = await temp('devpanel-migrate-tree-')
      // A worktree's .git is a file naming another Git directory: never copied, or
      // the copy's commits would land there. Only regular files are copied.
      const walk = async (rel) => {
        for (const name of await fs.readdir(path.join(CONFIG_ROOT, rel))) {
          if (SKIP_DIRS.has(name)) continue
          const r = path.join(rel, name)
          const stat = await fs.lstat(path.join(CONFIG_ROOT, r))
          if (stat.isDirectory()) { await fs.mkdir(path.join(copy, r), { recursive: true }); await walk(r) } else if (stat.isFile()) await fs.copyFile(path.join(CONFIG_ROOT, r), path.join(copy, r))
        }
      }
      await walk('')
      const projects = (await fs.readdir(path.join(copy, 'projects')).catch(() => [])).filter((n) => n.endsWith('.yaml'))
      const shipped = await fs.readFile(path.join(copy, 'tools/host-move/manifest.json'), 'utf8').then(JSON.parse, () => null)
      if (!projects.length && !shipped) t.skip('a copy of this tree', 'this checkout holds no projects/*.yaml and no move manifest: there is nothing to move')
      else {
        git(copy, 'init', '-q')
        git(copy, 'add', '-A')
        git(copy, 'add', '-f', '--', ...['projects', 'tools/releases', 'gui/live/reports'].filter((d) => fsSync.existsSync(path.join(copy, d))))
        git(copy, 'commit', '-q', '-m', 'copy')
        const before = await manifest(copy)
        const host = await temp('devpanel-migrate-host-')
        const run = migrate(copy, '--to', host)
        t.eq('the move succeeds', run.code, 0, run.output.slice(0, 400))
        const after = await manifest(host)
        const moved = run.manifest.entries.filter((e) => !e.inPlace)
        const kept = await Promise.all(moved.map(async (e) => before[e.from]?.split(' ')[0] === e.sha256 && sha(await fs.readFile(e.to)) === e.sha256))
        t.ok('every moved file keeps its sha256', moved.length > 0 && kept.every(Boolean), `${run.manifest.entries.length} files: ${JSON.stringify(run.manifest.totals)}; differing: ${moved.filter((e, i) => !kept[i]).map((e) => e.from).join(' ')}`)
        t.eq('every project file moved', run.manifest.entries.filter((e) => e.category === 'projects').length, projects.length)
        if (shipped) {
          const treeNow = await manifest(copy)
          const leftovers = shipped.entries.filter((e) => e.to !== 'in-place' && e.from in treeNow).map((e) => e.from)
          t.eq('no moved source is left in the copy', leftovers, [])
          const inPlace = shipped.entries.filter((e) => e.to === 'in-place').map((e) => e.from)
          t.ok('every in-place file is still there, untracked and ignored', inPlace.every((f) => treeNow[f] === before[f] && !tracked(copy, f) && ignored(copy, f)), inPlace.filter((f) => !(treeNow[f] === before[f] && !tracked(copy, f) && ignored(copy, f))).join(' '))
          t.eq('nothing of the manifest is left', await fs.access(path.join(copy, 'tools/host-move')).then(() => true, () => false), false)
        }
        const treeAfter = await manifest(copy)
        const again = migrate(copy, '--to', host)
        t.ok('a second run is a no-op', again.code === 0 && again.manifest.entries.length === 0 && JSON.stringify(await manifest(copy)) === JSON.stringify(treeAfter) && JSON.stringify(await manifest(host)) === JSON.stringify(after))

        const check = spawnSync(process.execPath, [path.join(CONFIG_ROOT, 'gui/server/config/check.mjs')], { encoding: 'utf8', env: { ...process.env, DEVPANEL_CONFIG_ROOT: copy, DEVPANEL_HOST_CONFIG_DIR: host } })
        const plain = check.stdout.replace(/\x1b\[[0-9;]*m/g, '')
        t.eq('config:check passes with the setting pointed at the moved directory (its settings and roster included)', check.status, 0, (plain + check.stderr).split('\n').slice(0, 3).join(' | '))
        t.ok('and finds every project there', plain.includes(`projects ${projects.length} (tree 0, host ${projects.length})`), plain.split('\n')[1])
      }
    }
  } finally {
    await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
  }
}

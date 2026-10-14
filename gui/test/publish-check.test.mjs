import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { CONFIG_ROOT } from './helpers.mjs'

export const name = 'publish check — the tracked tree against the installation\'s own denylist, nothing to find without one'

const SCRIPT = path.join(CONFIG_ROOT, 'tools/publish-check.mjs')
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { encoding: 'utf8' })
const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text) }
const check = (root, ...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, DEVPANEL_HOST_CONFIG_DIR: '' } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-publish-'))
  try {
    git(root, 'init', '-q')
    await write(path.join(root, '.gitignore'), '/host-config/\n/ignored.md\n')
    await write(path.join(root, 'README.md'), 'A neutral tree.\n')
    await write(path.join(root, 'docs/notes.md'), 'one line\nthe ACME-Internal host is here\n')
    await write(path.join(root, 'tools/acme-internal.py'), 'print(1)\n')
    await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 0x61, 0x63, 0x6d, 0x65, 0x2d, 0x69, 0x6e, 0x74, 0x65, 0x72, 0x6e, 0x61, 0x6c]))
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'tree')
    await write(path.join(root, 'new.md'), 'acme-internal, not yet committed\n')
    await write(path.join(root, 'ignored.md'), 'acme-internal, ignored\n')

    t.section('1. without a denylist there is nothing to look for')
    const none = check(root)
    t.eq('it passes, saying so', [none.code, /nothing to check/.test(none.out)], [0, true], none.out + none.err)

    t.section('2. the host-config denylist: contents and paths, case-insensitive; what a commit would hold')
    await write(path.join(root, 'host-config/publish-denylist.txt'), '# this installation\n\nacme-internal\n')
    const found = check(root)
    t.eq('matches exit 1', found.code, 1, found.err)
    const lines = found.out.trim().split('\n').sort()
    t.eq('a line of a tracked file, a tracked path and an untracked file Git would add', lines, ['docs/notes.md:2: the ACME-Internal host is here', 'new.md:1: acme-internal, not yet committed', 'tools/acme-internal.py: the path'])
    t.ok('an ignored file and a binary file are not read', !found.out.includes('ignored.md') && !found.out.includes('blob.bin'))
    t.ok('the denylist itself is ignored, never part of the tree', !found.out.includes('publish-denylist'))

    t.section('3. --denylist names another file; an invalid expression is an error')
    await write(path.join(root, 'host-config/other.txt'), 'neutral-word-that-is-absent\n')
    const clean = check(root, '--denylist', path.join(root, 'host-config/other.txt'))
    t.eq('nothing found: exit 0', clean.code, 0, clean.out)
    await write(path.join(root, 'host-config/bad.txt'), 'unclosed(\n')
    t.eq('an invalid expression exits 2', check(root, '--denylist', path.join(root, 'host-config/bad.txt')).code, 2)
    t.eq('a named denylist that does not exist exits 2', check(root, '--denylist', path.join(root, 'host-config/nope.txt')).code, 2)

    t.section('4. after the untracking a move does, the name is gone')
    git(root, 'rm', '--cached', '-q', 'tools/acme-internal.py', 'docs/notes.md')
    await fs.rm(path.join(root, 'new.md'))
    // Kept on disk and excluded the way the move does it: in the repository's own
    // info/exclude, never in a tracked .gitignore, which would name them again.
    await fs.appendFile(path.join(root, '.git/info/exclude'), '/tools/acme-internal.py\n/docs/notes.md\n')
    const after = check(root)
    t.eq('exit 0', [after.code, after.out.trim().split('\n').at(-1)], [0, `nothing in ${root} matches ${path.join(root, 'host-config/publish-denylist.txt')}`], after.out)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

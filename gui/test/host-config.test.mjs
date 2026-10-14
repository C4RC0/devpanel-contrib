import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { CONFIG_ROOT, sandbox } from './helpers.mjs'
import { loadConfig, resolvePlaybook } from '../server/config/load.mjs'
import { hostConfigDir, discover, liveReportsDir, HOST_CONFIG_ENV } from '../server/config/host-config.mjs'
import { releaseEnvironment } from '../server/runtime/release.mjs'
import { hostSettings } from '../server/config/host-settings.mjs'

/*
 * Installation-specific configuration (docs/host-config.md): one setting
 * resolves one host directory for projects, roster, release targets and live
 * reports; the in-tree files keep working; on the same file name the host file
 * wins and the in-tree one is reported as shadowed.
 */

const has = (cmd) => { try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true } catch { return false } }
const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text) }
const project = (id, notes) => YAML.stringify({ id, notes, workspace: { base: 'working-tree' } })
const rosterEntry = (id, title) => YAML.stringify({ id, title, harness: 'claude', model: 'claude-opus-5-5', efforts: ['low'], verification: { status: 'unverified' } })

export default async function (t) {
  const temps = []
  const temp = async (prefix) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); temps.push(d); return d }
  const runnerHostDir = process.env[HOST_CONFIG_ENV]
  try {
    t.section('0. no suite reads this checkout\'s own host configuration (test/run.mjs)')
    {
      // The runner points the setting at an empty directory of its own, so a suite
      // that loads the checkout's configuration gets the tracked catalogue only:
      // no host projects, no host roster, no host settings, and not the carried
      // settings of a host move still pending in the checkout.
      t.ok('the runner sets an absolute host-config directory', Boolean(runnerHostDir) && path.isAbsolute(runnerHostDir), runnerHostDir)
      t.ok('it is not the checkout\'s host-config/', runnerHostDir !== path.join(CONFIG_ROOT, 'host-config'))
      t.eq('and it is empty', await fs.readdir(runnerHostDir).catch((e) => e.code), [])
      const checkout = await loadConfig({ root: CONFIG_ROOT })
      t.eq('the checkout\'s configuration is read with it', [checkout.hostDir, checkout.sources.projects.host, checkout.sources.roster.host], [runnerHostDir, 0, 0])
      const implicit = hostSettings()
      t.eq('settings read without a directory are the neutral defaults, never a carried file', [implicit.file, implicit.pending, implicit.proxyLogin.usersDir, implicit.seatGuidance.projects], [null, false, null, []])
      const projects = process.env.DEVPANEL_PROJECTS_DIR
      t.eq('and the projects root is the runner\'s own, holding only the panel\'s empty project', [path.dirname(projects) === os.tmpdir() || projects.startsWith(os.tmpdir()), await fs.readdir(projects), await fs.readdir(path.join(projects, 'devpanel-project'))], [true, ['devpanel-project'], []])
    }
    // The sections below test the default host directory itself.
    delete process.env[HOST_CONFIG_ENV]

    t.section('1. the setting: unset, relative, absolute, empty')
    {
      t.eq('unset: <config root>/host-config', hostConfigDir({ root: '/r', env: {} }), '/r/host-config')
      t.eq('relative: against the config root', hostConfigDir({ root: '/r', env: { [HOST_CONFIG_ENV]: 'host-data' } }), '/r/host-data')
      t.eq('absolute: as is', hostConfigDir({ root: '/r', env: { [HOST_CONFIG_ENV]: '/etc/devpanel' } }), '/etc/devpanel')
      t.eq('empty: unset', hostConfigDir({ root: '/r', env: { [HOST_CONFIG_ENV]: '' } }), '/r/host-config')
    }

    t.section('2. in-tree only: today\'s files, nothing else (the setting unset or its directory empty)')
    {
      const root = await sandbox()
      await write(path.join(root, 'projects/tree-project.yaml'), project('tree-project', 'in tree'))
      await write(path.join(root, 'tools/releases/site-targets.json'), '{}')
      await write(path.join(root, 'gui/live/reports/r.json'), '{}')
      const hostDir = path.join(root, 'host-config')
      const cfg = await loadConfig({ root })
      t.eq('the host directory is <root>/host-config', cfg.hostDir, hostDir)
      t.eq('no errors', cfg.errors, [])
      t.eq('the project is found in the tree', cfg.projects.get('tree-project')?.file, path.join(root, 'projects/tree-project.yaml'))
      t.ok('the roster is the in-tree catalogue', cfg.roster.size > 0 && cfg.sources.roster.host === 0, JSON.stringify(cfg.sources))
      t.eq('release targets are found in the tree', (await discover('releases', { root })).map((f) => f.file), [path.join(root, 'tools/releases/site-targets.json')])
      t.eq('live reports are found in the tree', (await discover('live-reports', { root })).map((f) => f.file), [path.join(root, 'gui/live/reports/r.json')])
      t.eq('reports are written in the tree', await liveReportsDir({ hostDir, tree: path.join(root, 'gui/live/reports') }), path.join(root, 'gui/live/reports'))
      await fs.mkdir(hostDir)
      const empty = await loadConfig({ root })
      t.eq('an empty host directory changes nothing', [[...empty.projects.keys()], empty.roster.size, empty.shadowed], [[...cfg.projects.keys()], cfg.roster.size, []])
    }

    t.section('3. host directory only: every category is discovered there')
    {
      const root = await sandbox()
      const hostDir = await temp('devpanel-host-')
      await write(path.join(hostDir, 'projects/host-project.yaml'), project('host-project', 'in host-config'))
      await write(path.join(hostDir, 'roster/host-model.yaml'), rosterEntry('host-model', 'Host only'))
      await write(path.join(hostDir, 'releases/site-targets.json'), '{}')
      await write(path.join(hostDir, 'live-reports/r.json'), '{}')
      const cfg = await loadConfig({ root, hostDir })
      t.eq('no errors', cfg.errors, [])
      t.eq('the project is found in host-config', cfg.projects.get('host-project')?.file, path.join(hostDir, 'projects/host-project.yaml'))
      t.eq('the host roster entry is added to the catalogue', [cfg.roster.get('host-model')?.file, cfg.sources.roster.host], [path.join(hostDir, 'roster/host-model.yaml'), 1])
      t.eq('release targets are found in host-config', (await discover('releases', { root, hostDir })).map((f) => f.file), [path.join(hostDir, 'releases/site-targets.json')])
      t.eq('live reports are found in host-config', (await discover('live-reports', { root, hostDir })).map((f) => f.file), [path.join(hostDir, 'live-reports/r.json')])
      t.eq('reports are written in host-config', await liveReportsDir({ hostDir, tree: path.join(root, 'gui/live/reports') }), path.join(hostDir, 'live-reports'))
    }

    t.section('4. both present: the union by file name, the host file wins and the in-tree one is reported')
    {
      const root = await sandbox()
      const hostDir = await temp('devpanel-host-')
      await write(path.join(root, 'projects/both-project.yaml'), project('both-project', 'in tree'))
      await write(path.join(hostDir, 'projects/both-project.yaml'), project('both-project', 'in host-config'))
      await write(path.join(root, 'projects/tree-project.yaml'), project('tree-project', 'in tree'))
      const opus = YAML.parse(await fs.readFile(path.join(root, 'roster/opus-5-5.yaml'), 'utf8'))
      await write(path.join(hostDir, 'roster/opus-5-5.yaml'), YAML.stringify({ ...opus, title: 'Host title' }))
      for (const [dir, text] of [[path.join(root, 'tools/releases'), '{"tree":1}'], [path.join(hostDir, 'releases'), '{"host":1}']]) await write(path.join(dir, 'site-targets.json'), text)
      for (const [dir, name] of [[path.join(root, 'gui/live/reports'), 'a.json'], [path.join(hostDir, 'live-reports'), 'a.json'], [path.join(hostDir, 'live-reports'), 'b.json']]) await write(path.join(dir, name), name)
      const cfg = await loadConfig({ root, hostDir })
      t.eq('no errors', cfg.errors, [])
      t.eq('the host project wins', cfg.projects.get('both-project')?.notes, 'in host-config')
      t.ok('an in-tree project without a host twin still loads', cfg.projects.has('tree-project'))
      t.eq('the host roster entry wins', cfg.roster.get('opus-5-5')?.title, 'Host title')
      t.eq('shadowed in-tree files are reported', cfg.shadowed.map((s) => [s.category, s.name, s.tree]).sort(), [['projects', 'both-project.yaml', path.join(root, 'projects/both-project.yaml')], ['roster', 'opus-5-5.yaml', path.join(root, 'roster/opus-5-5.yaml')]])
      t.eq('the host release targets win', (await discover('releases', { root, hostDir })).map((f) => [f.file, f.shadows]), [[path.join(hostDir, 'releases/site-targets.json'), path.join(root, 'tools/releases/site-targets.json')]])
      t.eq('live reports are the union', (await discover('live-reports', { root, hostDir })).map((f) => f.source), ['host', 'host'])
      await write(path.join(hostDir, 'roster/opus-again.yaml'), YAML.stringify(opus))
      t.ok('one id under two file names is still an error', (await loadConfig({ root, hostDir })).errors.some((e) => /duplicate roster id "opus-5-5"/.test(e.message)))
    }

    t.section('5. moving a file unchanged keeps its configuration group')
    {
      const root = await sandbox()
      const text = project('moved-project', 'same bytes')
      await write(path.join(root, 'projects/moved-project.yaml'), text)
      const before = await resolvePlaybook('analysis', { root, projectId: 'moved-project' })
      await fs.rm(path.join(root, 'projects/moved-project.yaml'))
      await write(path.join(root, 'host-config/projects/moved-project.yaml'), text)
      const after = await resolvePlaybook('analysis', { root, projectId: 'moved-project' })
      t.ok('both resolve', before.ok && after.ok, JSON.stringify([before.errors, after.errors]))
      t.eq('the configHash is the same', after.resolved?.configHash, before.resolved?.configHash)
    }

    t.section('6. a config root that is not the default and a relative setting: one directory for all four categories')
    {
      const root = await sandbox()
      const env = { [HOST_CONFIG_ENV]: 'host-data' }
      const hostDir = hostConfigDir({ root, env })
      t.eq('the setting resolves against the config root', hostDir, path.join(root, 'host-data'))
      await write(path.join(hostDir, 'projects/one-project.yaml'), project('one-project', 'one directory'))
      await write(path.join(hostDir, 'roster/one-model.yaml'), rosterEntry('one-model', 'One'))
      await write(path.join(hostDir, 'releases/example-targets.json'), '{}')
      await write(path.join(hostDir, 'live-reports/r.json'), '{}')
      const cfg = await loadConfig({ root, hostDir })
      t.ok('projects and roster are read there', cfg.projects.get('one-project')?.file.startsWith(hostDir + '/') && cfg.roster.get('one-model')?.file.startsWith(hostDir + '/'))
      t.eq('release targets are read there', (await discover('releases', { root, hostDir })).map((f) => f.file), [path.join(hostDir, 'releases/example-targets.json')])
      t.eq('live reports are written there', await liveReportsDir({ hostDir, tree: path.join(root, 'gui/live/reports') }), path.join(hostDir, 'live-reports'))
      const releaseEnv = releaseEnvironment({ hostDir, runId: 'r', archive: 'a', sha256: 's', environment: 'staging', stateDir: 'd', startedAt: 't' })
      t.eq('the release runner hands the procedures that absolute directory', releaseEnv[HOST_CONFIG_ENV], hostDir)
      if (!has('python3')) t.skip('the standalone release procedure finds the same targets', 'python3 is not installed')
      else {
        const found = execFileSync('python3', ['-I', '-B', '-c', 'import os, sys; sys.path.insert(0, sys.argv[1]); import host_targets; print(host_targets.targets_file("example", os.environ))', path.join(CONFIG_ROOT, 'tools/releases')],
          { encoding: 'utf8', env: { PATH: process.env.PATH, DEVPANEL_CONFIG_ROOT: root, [HOST_CONFIG_ENV]: 'host-data' } }).trim()
        t.eq('the standalone release procedure finds the same targets', found, path.join(hostDir, 'releases/example-targets.json'))
        const empty = execFileSync('python3', ['-I', '-B', '-c', 'import os, sys; sys.path.insert(0, sys.argv[1]); import host_targets; print(host_targets.host_config_dir(os.environ))', path.join(CONFIG_ROOT, 'tools/releases')],
          { encoding: 'utf8', env: { PATH: process.env.PATH, DEVPANEL_CONFIG_ROOT: root, [HOST_CONFIG_ENV]: '' } }).trim()
        t.eq('an empty setting is unset there too', empty, hostConfigDir({ root, env: { [HOST_CONFIG_ENV]: '' } }))
      }
    }

    t.section('7. the examples load and use reserved names')
    {
      const root = await sandbox()
      const examples = path.join(CONFIG_ROOT, 'examples/host-config')
      const cfg = await loadConfig({ root, hostDir: examples })
      t.eq('the example project and roster entry load without errors', [cfg.errors, cfg.projects.has('example-project'), cfg.roster.get('example-account-opus-5-5')?.account], [[], true, 'example'])
      t.ok('the example project resolves', (await resolvePlaybook('analysis', { config: cfg, projectId: 'example-project' })).ok)
      const targets = JSON.parse(await fs.readFile(path.join(examples, 'releases/example-targets.json'), 'utf8'))
      const keys = ['host', 'project', 'stateRoot', 'service', 'serviceUser', 'companions', 'node', 'nodeMajor', 'observeSeconds', 'readinessSeconds', 'builderSeconds', 'fullTests']
      t.ok('the example targets carry every key the procedures read', Object.values(targets).every((target) => keys.every((k) => k in target)))
      const text = (await Promise.all((await fs.readdir(examples, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => fs.readFile(path.join(e.parentPath ?? e.path, e.name), 'utf8')))).join('\n')
      const names = [...text.matchAll(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:invalid|example|com|net|org|io|de|eu|uk)\b/g)].map((m) => m[0])
      t.ok('host names are reserved .invalid / .example ones', names.length > 0 && names.every((n) => /\.(?:invalid|example)$/.test(n)), names.filter((n) => !/\.(?:invalid|example)$/.test(n)).join(' '))
      const addresses = [...text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)].map((m) => m[0])
      t.ok('addresses are the 192.0.2.0/24 documentation range', addresses.every((a) => a.startsWith('192.0.2.')), addresses.join(' '))
      const settings = hostSettings({ root, hostDir: examples })
      t.eq('the example settings are valid and read as written', [settings.file, settings.projectActions.headerMarkers, settings.testDrive.confinement.user, settings.seatGuidance.projects], [path.join(examples, 'settings.json'), ['DEVPANEL', 'EDITOR'], 'app', ['devpanel-project']])
    }

    t.section('8. the release procedures\' shared lookup and its tests')
    if (!has('python3')) t.skip('tools/releases/test_host_targets.py', 'python3 is not installed')
    else {
      let output = ''
      let code = 0
      try { output = execFileSync('python3', ['-B', path.join(CONFIG_ROOT, 'tools/releases/test_host_targets.py')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (error) { code = error.status; output = `${error.stdout}${error.stderr}` }
      t.eq('test_host_targets.py passes', code, 0, output.trim().split('\n').slice(-3).join(' '))
    }

    t.section('9. install-on-osx.sh needs an explicit source and keeps the Mac\'s own configuration')
    {
      const script = await fs.readFile(path.join(CONFIG_ROOT, 'install-on-osx.sh'), 'utf8')
      t.ok('DEVPANEL_SOURCE has no default', /^SOURCE="\$\{DEVPANEL_SOURCE:-\}"$/m.test(script) && /\[\[ -n "\$SOURCE" \]\] \|\| die/.test(script))
      const block = /rsync -a --delete \\\n([\s\S]*?)"\$SOURCE" "\$DEST\/"/.exec(script)?.[1] ?? ''
      const excludes = [...block.matchAll(/--exclude\s+('[^']*'|\S+)/g)].map((m) => m[1].replace(/^'|'$/g, ''))
      t.ok('it excludes the configuration, issues and token data', ['/projects/', '/host-config/', '/issues/', '/.devpanel-token'].every((e) => excludes.includes(e)), JSON.stringify(excludes))
      if (!has('rsync')) t.skip('repeated syncs preserve a local project yaml', 'rsync is not installed')
      else {
        const source = await temp('devpanel-osx-src-')
        const dest = await temp('devpanel-osx-dest-')
        await write(path.join(source, 'projects/server-project.yaml'), 'id: server-project\n')
        await write(path.join(source, 'host-config/projects/server-project.yaml'), 'id: server-project\n')
        await write(path.join(source, 'README.md'), 'source\n')
        await write(path.join(dest, 'projects/mac-project.yaml'), 'id: mac-project\n')
        await write(path.join(dest, 'host-config/projects/mac-project.yaml'), 'id: mac-project\n')
        await write(path.join(dest, 'issues/mac-project/x'), 'x\n')
        for (let i = 0; i < 2; i++) execFileSync('rsync', ['-a', '--delete', ...excludes.flatMap((e) => ['--exclude', e]), source + '/', dest + '/'])
        const exists = (p) => fs.access(path.join(dest, p)).then(() => true, () => false)
        t.eq('the Mac keeps its own project yaml, host-config and issues after two syncs', [await exists('projects/mac-project.yaml'), await exists('host-config/projects/mac-project.yaml'), await exists('issues/mac-project/x')], [true, true, true])
        t.eq('and never receives the server\'s', [await exists('projects/server-project.yaml'), await exists('host-config/projects/server-project.yaml'), await exists('README.md')], [false, false, true])
      }
    }
  } finally {
    if (runnerHostDir === undefined) delete process.env[HOST_CONFIG_ENV]; else process.env[HOST_CONFIG_ENV] = runnerHostDir
    await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
  }
}

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { freezeHostGuidance, hostGuidanceBrief, INLINE_MAX } from '../server/runtime/host-guidance.mjs'
import { HOST_CONFIG_ENV } from '../server/config/host-config.mjs'
import { startRun } from '../server/runtime/launch.mjs'
import { applyFence, fenceArgs, fencedCommand } from '../../harness/fence.mjs'
import { runProcess } from '../server/runtime/process.mjs'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'

export const name = 'seat guidance — an installation\'s notes frozen into the run\'s evidence, named in every prompt, nothing by default'

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text) }

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }
  const runnerHostDir = process.env[HOST_CONFIG_ENV]
  // A config root with its notes, and a host-config directory naming the project.
  const fixture = async (projects = ['app-project']) => {
    const root = await temp('devpanel-guidance-root-')
    const hostDir = path.join(root, 'host-config')
    await write(path.join(root, 'CLAUDE.local.md'), '# Local notes\nGUIDANCE-MARKER: the staging host is staging.example.invalid\n')
    await write(path.join(hostDir, 'docs/a.md'), 'installation doc\n')
    await write(path.join(hostDir, 'docs/history/b.md'), 'a dated record\n')
    await write(path.join(hostDir, 'settings.json'), JSON.stringify({ seatGuidance: { projects } }))
    return { root, hostDir }
  }
  try {
    t.section('1. frozen at run start into the run\'s evidence, with a manifest; links are never followed')
    {
      const { root, hostDir } = await fixture()
      const outside = await temp('devpanel-guidance-outside-')
      await write(path.join(outside, 'secret'), 'SECRET\n')
      await fs.symlink(path.join(outside, 'secret'), path.join(hostDir, 'docs/link.md'))
      const issuePath = await temp('devpanel-guidance-issue-')
      const record = await freezeHostGuidance({ issuePath, runId: 'r1', project: 'app-project', root, hostDir })
      const dir = path.join(issuePath, 'runs', 'r1', 'evidence', 'host-guidance')
      t.eq('the record names the frozen directory and what is in it', record, { dir, files: 3, bytes: record?.bytes, skipped: 1 })
      const manifest = JSON.parse(await fs.readFile(path.join(dir, 'host-guidance.json'), 'utf8'))
      t.eq('every file is listed with its sha256', manifest.files.map((f) => f.path), ['CLAUDE.local.md', 'docs/a.md', 'docs/history/b.md'])
      t.ok('and the copies are byte for byte', (await Promise.all(manifest.files.map(async (f) => sha(await fs.readFile(path.join(dir, f.path))) === f.sha256))).every(Boolean))
      t.eq('the link is skipped and listed, its target never read', [manifest.skipped, await fs.access(path.join(dir, 'docs/link.md')).then(() => true, () => false)], [[{ path: 'docs/link.md', reason: 'a symbolic link' }], false])
      await write(path.join(root, 'CLAUDE.local.md'), 'changed after the start\n')
      t.eq('a second call returns the frozen record and copies nothing again', await freezeHostGuidance({ issuePath, runId: 'r1', project: 'app-project', root, hostDir }), record)
      t.ok('the frozen notes are the ones of the run\'s start', (await fs.readFile(path.join(dir, 'CLAUDE.local.md'), 'utf8')).includes('GUIDANCE-MARKER'))
    }

    t.section('2. the neutral default exposes nothing')
    {
      const { root, hostDir } = await fixture()
      const issuePath = await temp('devpanel-guidance-issue-')
      t.eq('a project the settings do not name: nothing', await freezeHostGuidance({ issuePath, runId: 'r1', project: 'other-project', root, hostDir }), null)
      await fs.rm(path.join(hostDir, 'settings.json'))
      t.eq('no settings: nothing', await freezeHostGuidance({ issuePath, runId: 'r2', project: 'app-project', root, hostDir }), null)
      t.eq('and no directory is made', await fs.readdir(path.join(issuePath, 'runs')).catch((e) => e.code), 'ENOENT')
      t.eq('no record, no prompt block', await hostGuidanceBrief(undefined), null)
    }

    t.section('3. the prompt block: the directory, and CLAUDE.local.md inline up to 32 KB')
    {
      const { root, hostDir } = await fixture()
      const issuePath = await temp('devpanel-guidance-issue-')
      const record = await freezeHostGuidance({ issuePath, runId: 'r1', project: 'app-project', root, hostDir })
      const brief = await hostGuidanceBrief(record)
      t.ok('it names the frozen directory', brief.includes(record.dir))
      t.ok('and carries the notes verbatim', brief.includes('GUIDANCE-MARKER: the staging host is staging.example.invalid'))
      await write(path.join(root, 'CLAUDE.local.md'), 'x'.repeat(INLINE_MAX + 1))
      const big = await freezeHostGuidance({ issuePath, runId: 'r2', project: 'app-project', root, hostDir })
      const pointer = await hostGuidanceBrief(big)
      t.ok('larger notes are pointed to, not inlined', !pointer.includes('x'.repeat(100)) && /CLAUDE\.local\.md is \d+ KB; read it there/.test(pointer), pointer)
    }

    t.section('4. while a host move is pending, the carried notes and settings stand in')
    {
      const root = await temp('devpanel-guidance-pending-')
      await write(path.join(root, 'tools/host-move/files/CLAUDE.local.md'), 'CARRIED-NOTES\n')
      await write(path.join(root, 'tools/host-move/files/settings.json'), JSON.stringify({ seatGuidance: { projects: ['app-project'] } }))
      await write(path.join(root, 'tools/host-move/files/docs/a.md'), 'carried doc\n')
      await write(path.join(root, 'tools/host-move/manifest.json'), JSON.stringify({ entries: [
        { from: 'tools/host-move/files/CLAUDE.local.md', to: 'root:CLAUDE.local.md' },
        { from: 'tools/host-move/files/settings.json', to: 'host:settings.json' },
        { from: 'tools/host-move/files/docs/a.md', to: 'host:docs/a.md' }
      ] }))
      const issuePath = await temp('devpanel-guidance-issue-')
      // The default host directory only; the runner's explicit setting turns this off.
      t.eq('under an explicit host-config setting, nothing carried is read', await freezeHostGuidance({ issuePath, runId: 'r0', project: 'app-project', root }), null)
      delete process.env[HOST_CONFIG_ENV]
      try {
        const record = await freezeHostGuidance({ issuePath, runId: 'r1', project: 'app-project', root })
        t.eq('the default directory: the carried copies are frozen', [record?.files, (await fs.readFile(path.join(issuePath, 'runs/r1/evidence/host-guidance/CLAUDE.local.md'), 'utf8')), (await fs.readFile(path.join(issuePath, 'runs/r1/evidence/host-guidance/docs/a.md'), 'utf8'))], [2, 'CARRIED-NOTES\n', 'carried doc\n'])
      } finally { process.env[HOST_CONFIG_ENV] = runnerHostDir }
    }

    t.section('5. a run of a named project: every seat prompt carries the notes')
    {
      const prompts = []
      const base = scriptFor()
      const f = await engineFixture({ script: (turn) => { prompts.push(turn.prompt); return base(turn) } })
      const hostDir = await temp('devpanel-guidance-hostcfg-')
      await write(path.join(f.configRoot, 'CLAUDE.local.md'), 'GUIDANCE-MARKER for the engine\n')
      await write(path.join(hostDir, 'settings.json'), JSON.stringify({ seatGuidance: { projects: ['devpanel-project'] } }))
      process.env[HOST_CONFIG_ENV] = hostDir
      let engine
      try {
        engine = await startRun({ playbookId: f.playbookId, issue: { ...f.issue, project: 'devpanel-project' }, issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery })
        await engine.drive()
      } finally { process.env[HOST_CONFIG_ENV] = runnerHostDir }
      t.eq('the run records what was frozen', [engine.run.hostGuidance?.files, engine.run.hostGuidance?.dir], [1, path.join(f.issuePath, 'runs', engine.runId, 'evidence', 'host-guidance')])
      t.ok('every seat turn was given the notes', prompts.length > 2 && prompts.every((p) => p.includes('GUIDANCE-MARKER for the engine')), `${prompts.filter((p) => !p.includes('GUIDANCE-MARKER')).length} of ${prompts.length} without`)
      t.ok('the frozen copy is inside the run\'s evidence, which every seat may read', await fs.readFile(path.join(engine.run.hostGuidance.dir, 'CLAUDE.local.md'), 'utf8').then((s) => s.includes('GUIDANCE-MARKER'), () => false))

      const g = await engineFixture()
      let plain
      try {
        plain = await startRun({ playbookId: g.playbookId, issue: { ...g.issue, project: 'devpanel-project' }, issuePath: g.issuePath, projectPath: g.projectPath, harnesses: g.harnesses, stepStore: g.stepStore, workspaceProvider: g.workspaceProvider, configRoot: g.configRoot, probe: g.probe, clock: g.clock, deliveryProvider: g.delivery })
        await plain.drive()
      } finally { process.env[HOST_CONFIG_ENV] = runnerHostDir }
      t.eq('without host settings a run records and exposes nothing', [plain.run.hostGuidance, await fs.access(path.join(g.issuePath, 'runs', plain.runId, 'evidence', 'host-guidance')).then(() => true, () => false)], [undefined, false])
    }

    t.section('6. a seat reads the frozen notes from inside its fence')
    {
      const probeDir = await temp('devpanel-guidance-fence-')
      let missing = null
      try {
        const wrapped = fencedCommand({ command: '/bin/true', args: [], fence: await fenceArgs({ cwd: probeDir, writable: [probeDir] }) })
        const r = await runProcess({ command: wrapped.command, args: wrapped.args, env: { PATH: '/usr/bin:/bin' }, stdin: '' })
        if (r.code !== 0) missing = `bubblewrap failed: ${r.stderr.trim().slice(0, 120)}`
      } catch (error) { missing = error.code === 'ENOENT' ? 'bubblewrap or setpriv absent' : error.message }
      if (missing) t.skip('a seat reads the frozen notes inside a proved fence', missing)
      else {
        const { root, hostDir } = await fixture()
        const issuePath = await temp('devpanel-guidance-issue-')
        const record = await freezeHostGuidance({ issuePath, runId: 'r1', project: 'app-project', root, hostDir })
        const worktree = path.join(issuePath, 'runs', 'worktree'), scratch = path.join(issuePath, 'runs', 'r1', 'scratch')
        await fs.mkdir(worktree, { recursive: true }); await fs.mkdir(scratch, { recursive: true })
        // As the engine builds a seat's fence: the worktree and scratch writable, the run's evidence read-only.
        const fence = await applyFence({ spec: { cwd: worktree, writable: [worktree, scratch], readOnly: [path.join(issuePath, 'runs', 'r1', 'evidence')] }, manifest: {} })
        if (!fence.applied) t.skip('a seat reads the frozen notes inside a proved fence', fence.reason)
        else {
          const w = fence.wrap('/bin/sh', ['-c', `cat ${path.join(record.dir, 'CLAUDE.local.md')}; (echo x > ${path.join(record.dir, 'forged')}) 2>/dev/null && echo GUIDANCE-WRITABLE || echo guidance-read-only`])
          const r = await runProcess({ command: w.command, args: w.args, env: { PATH: '/usr/bin:/bin', HOME: os.homedir() }, stdin: '' })
          t.ok('the notes are readable inside the fence', r.stdout.includes('GUIDANCE-MARKER'), r.stdout + r.stderr)
          t.ok('and read-only', r.stdout.includes('guidance-read-only'), r.stdout)
        }
      }
    }
  } finally {
    if (runnerHostDir === undefined) delete process.env[HOST_CONFIG_ENV]; else process.env[HOST_CONFIG_ENV] = runnerHostDir
    await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
  }
}

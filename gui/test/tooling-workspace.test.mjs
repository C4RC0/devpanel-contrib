import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import YAML from 'yaml'

import { loadConfig, resolvePlaybook } from '../server/config/load.mjs'
import { gitWorktreeProvider, startRun, worktreeDiffDelivery } from '../server/runtime/launch.mjs'
import { baselineOf, fingerprint, workspaceProjection } from '../server/runtime/fingerprint.mjs'
import { ensureMountPoint } from '../server/runtime/tooling-mounts.mjs'
import { renderToolingCommand } from '../server/runtime/tooling-commands.mjs'
import { CONFIG_ROOT, sandbox, errorMatching } from './helpers.mjs'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'

export const name = 'seat tooling — project configuration, snapshot and patch exclusion, refused turns, prompts'

const run = promisify(execFile)
const NL = String.fromCharCode(10)
const temps = []
const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }
const exists = (p) => fs.lstat(p).then(() => true, () => false)

async function toolDir () {
  const dir = await temp('devpanel-tooling-src-')
  await fs.writeFile(path.join(dir, 'tool.js'), 'module.exports = 1\n')
  return dir
}

const start = (f) => startRun({
  playbookId: f.playbookId,
  issue: { project: 'devpanel-project', id: f.issue.id, name: f.issue.name, openedOn: f.issue.openedOn, path: f.issuePath },
  issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
})

const writeProject = (configRoot, tooling) => fs.mkdir(path.join(configRoot, 'projects'), { recursive: true })
  .then(() => fs.writeFile(path.join(configRoot, 'projects', 'devpanel-project.yaml'), YAML.stringify({ id: 'devpanel-project', workspace: { tooling } })))

export default async function (t) {
  try {
    t.section('1. the tracked catalogue loads; without a project there is no tooling')
    {
      const root = await sandbox()
      const catalogue = await loadConfig({ root })
      t.eq('it loads without errors', catalogue.errors, [])
      const plain = await resolvePlaybook('plan-and-implement', { root })
      t.eq('without a project there is no tooling in the snapshot', [plain.resolved.workspace.tooling.mounts, plain.resolved.workspace.tooling.commands], [undefined, undefined])
    }

    t.section('2. a project declares mounts and commands; a missing source is recorded, not an error (AC1a, AC1b, AC2a)')
    {
      const source = await toolDir()
      const root = await sandbox()
      const commands = [{ id: 'unit', cwd: 'gui', run: 'node test/run.mjs <suite>' }]
      await writeProject(root, { mounts: [{ target: 'gui/node_modules', source }], commands })
      const r = await resolvePlaybook('implementation', { root, projectId: 'devpanel-project' })
      t.ok('it resolves', r.ok, JSON.stringify(r.errors))
      t.eq('the snapshot carries the resolved mount', r.resolved.workspace.tooling.mounts, [{ target: 'gui/node_modules', source, sourceReal: source }])
      t.eq('and the commands', r.resolved.workspace.tooling.commands, commands)
      await writeProject(root, { mounts: [{ target: 'gui/node_modules', source: path.join(source, 'gone'), provisional: true }] })
      const gone = await resolvePlaybook('implementation', { root, projectId: 'devpanel-project' })
      t.ok('a missing source still resolves', gone.ok, JSON.stringify(gone.errors))
      t.eq('recorded as missing, naming the path', [gone.resolved.workspace.tooling.mounts[0].missing, gone.resolved.workspace.tooling.mounts[0].source], [true, path.join(source, 'gone')])
      await writeProject(root, { mounts: [{ target: '../escape', source }] })
      t.ok('a target outside the worktree is a configuration error', errorMatching(await loadConfig({ root }), /must be a normalised path relative to the worktree/))
      await writeProject(root, { mounts: [{ target: 'x', source: os.homedir() }] })
      t.ok('a forbidden source is refused at resolution', errorMatching(await resolvePlaybook('implementation', { root, projectId: 'devpanel-project' }), /which no seat may read/))
      await fs.rm(path.join(root, 'projects'), { recursive: true })
      await fs.appendFile(path.join(root, 'playbooks', 'implementation.yaml'), `workspace:${NL}  tooling:${NL}    mounts:${NL}      - target: x${NL}        source: ${source}${NL}`)
      t.ok('a playbook may not declare mounts', errorMatching(await loadConfig({ root }), /workspace\.tooling\.mounts is a project setting/))
    }

    t.section('3. the working-tree reading and the patch leave a mount target out (AC1c)')
    {
      const projectPath = await temp('devpanel-tooling-proj-')
      await run('git', ['-C', projectPath, 'init', '-q', '-b', 'main'])
      await run('git', ['-C', projectPath, 'config', 'user.email', 't@example.invalid'])
      await run('git', ['-C', projectPath, 'config', 'user.name', 'T'])
      await fs.writeFile(path.join(projectPath, 'source.txt'), 'original' + NL)
      await run('git', ['-C', projectPath, 'add', '-A'])
      await run('git', ['-C', projectPath, 'commit', '-qm', 'base'])
      // Untracked and not ignored: a working-tree snapshot would take both.
      await fs.mkdir(path.join(projectPath, 'tools', 'prettier'), { recursive: true })
      await fs.writeFile(path.join(projectPath, 'tools', 'prettier', 'installed.js'), 'tooling\n')
      await fs.writeFile(path.join(projectPath, 'notes.txt'), 'untracked source\n')
      const ws = await gitWorktreeProvider.create({ projectPath, runId: 'tooling-1', root: await temp('devpanel-tooling-ws-'),
        policy: { base: 'working-tree', tooling: { mounts: [{ target: 'tools/prettier', source: '/unused' }] } } })
      try {
        t.eq('the worktree records its mount targets', ws.toolingMounts, ['tools/prettier'])
        t.eq('the tooling at the target is not in the snapshot', await exists(path.join(ws.path, 'tools', 'prettier', 'installed.js')), false)
        t.eq('the rest of the working tree is', await fs.readFile(path.join(ws.path, 'notes.txt'), 'utf8'), 'untracked source\n')
        const baseline = await baselineOf(ws.path, { projection: workspaceProjection(ws) })
        await ensureMountPoint(ws.path, 'tools/prettier')
        await fs.writeFile(path.join(ws.path, 'tools', 'prettier', 'written.js'), 'what an unfenced turn left there\n')
        await fs.writeFile(path.join(ws.path, 'source.txt'), 'changed' + NL)
        const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline, projection: workspaceProjection(ws) })
        t.ok('the fingerprint holds the change and not the target', fp.entries.some((e) => e.path === 'source.txt') && !fp.entries.some((e) => e.path.startsWith('tools/')))
        for (const given of [fp, null]) {
          const runDir = await temp('devpanel-tooling-run-')
          await fs.mkdir(path.join(runDir, 'artifacts'))
          const receipt = await worktreeDiffDelivery.deliver({ action: 'worktree-diff', revision: fp.fingerprint, fingerprint: given, baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, workspace: ws, runDir })
          const patch = await fs.readFile(path.join(runDir, receipt.artifactRef), 'utf8')
          const how = given ? 'with the engine\'s fingerprint' : 'recomputed by delivery'
          t.ok(`the patch carries the change (${how})`, patch.includes('+changed'))
          t.ok(`and nothing under the target (${how})`, !patch.includes('tools/prettier'), patch)
          t.eq(`reconstruction verifies (${how})`, receipt.reconstruction.verified, true, receipt.reconstruction.detail)
        }
      } finally { await gitWorktreeProvider.release({ projectPath, path: ws.path }) }
    }

    t.section('3b. a mount target .gitignore already ignores does not break the working-tree snapshot')
    {
      // The real case: devpanel's own gui/node_modules is ignored, and `git add`
      // without --force fails when an exclude pathspec names an ignored path.
      const projectPath = await temp('devpanel-tooling-ignored-')
      await run('git', ['-C', projectPath, 'init', '-q', '-b', 'main'])
      await run('git', ['-C', projectPath, 'config', 'user.email', 't@example.invalid'])
      await run('git', ['-C', projectPath, 'config', 'user.name', 'T'])
      await fs.writeFile(path.join(projectPath, '.gitignore'), 'gui/node_modules' + NL)
      await fs.writeFile(path.join(projectPath, 'source.txt'), 'original' + NL)
      await run('git', ['-C', projectPath, 'add', '-A'])
      await run('git', ['-C', projectPath, 'commit', '-qm', 'base'])
      await fs.mkdir(path.join(projectPath, 'gui', 'node_modules', 'yaml'), { recursive: true })
      await fs.writeFile(path.join(projectPath, 'gui', 'node_modules', 'yaml', 'index.js'), 'installed' + NL)
      await fs.writeFile(path.join(projectPath, 'notes.txt'), 'untracked source' + NL)
      const ws = await gitWorktreeProvider.create({ projectPath, runId: 'tooling-ignored', root: await temp('devpanel-tooling-ws-'),
        policy: { base: 'working-tree', tooling: { mounts: [{ target: 'gui/node_modules', source: '/unused' }] } } })
      try {
        t.eq('provisioning succeeds and records the target', ws.toolingMounts, ['gui/node_modules'])
        t.eq('the ignored target is not in the snapshot', await exists(path.join(ws.path, 'gui', 'node_modules', 'yaml', 'index.js')), false)
        t.eq('the untracked source is', await fs.readFile(path.join(ws.path, 'notes.txt'), 'utf8'), 'untracked source' + NL)
      } finally { await gitWorktreeProvider.release({ projectPath, path: ws.path }) }
    }

    t.section('4. a missing mount source refuses the seat turn, naming it (AC1b)')
    {
      const turns = []
      const script = scriptFor()
      const f = await engineFixture({ script: (turn) => { turns.push(turn); return script(turn) } })
      const source = await toolDir()
      await writeProject(f.configRoot, { mounts: [{ target: 'tools/fake', source }] })
      // Resolved present, gone by the time a seat would use it.
      const engine = await start(f)
      await fs.rm(source, { recursive: true })
      await engine.drive().catch(() => {})
      t.eq('the run fails as an environment fault', engine.run.failure?.class, 'environment', JSON.stringify(engine.run.failure))
      t.ok('naming the source and the project file', engine.run.failure?.message.includes(source) && engine.run.failure.message.includes('projects/devpanel-project.yaml'), engine.run.failure?.message)
      t.ok('no seat with tools was invoked', !turns.some((tn) => tn.stepId === 'implement' || tn.stepId.startsWith('audit')))
      // The runner's DEVPANEL_FENCE=off binds nothing, so nothing may look mounted (P3-1, P3-2).
      t.eq('and no empty mount point was made in the worktree', await exists(path.join(engine.run.workspace.path, 'tools', 'fake')), false)
    }

    t.section('5. without the fence (the runner\'s DEVPANEL_FENCE=off) every seat is given the same commands, unwrapped and labelled unconfined (P2-2, P2-3, P2-4)')
    {
      const turns = []
      const script = scriptFor()
      const f = await engineFixture({ script: (turn) => { turns.push(turn); return script(turn) } })
      const commands = [{ id: 'unit', run: 'node test/run.mjs <suite>', description: 'unit suites' }, { id: 'fmt', cwd: 'docs', run: "prettier --check '<files>'", provisional: true }]
      await writeProject(f.configRoot, { commands })
      const engine = await start(f)
      await engine.drive()
      const worktree = engine.run.workspace.path
      const lines = commands.map((c) => renderToolingCommand(c, worktree, { offline: false }))
      const author = turns.find((tn) => tn.stepId === 'implement')
      const audit = turns.find((tn) => tn.stepId.startsWith('audit'))
      const brief = turns.find((tn) => tn.stepId.startsWith('brief'))
      for (const [label, turn] of [['the author', author], ['the audit', audit], ['the coordinator\'s brief', brief]]) {
        t.ok(`${label} is given every command exactly as rendered, without the wrapper`, Boolean(turn) && lines.every((l) => turn.prompt.includes(l)), turn?.prompt.slice(-1500))
        t.ok(`${label} is told they run unconfined, and why`, Boolean(turn) && turn.prompt.includes('UNCONFINED') && turn.prompt.includes('DEVPANEL_FENCE=off'))
        t.ok(`${label} never sees the Linux wrapper or a claim of no network`, Boolean(turn) && !turn.prompt.includes('/run/devpanel/tooling/offline') && !turn.prompt.includes('have no network') && !turn.prompt.includes('network isolation'))
        t.ok(`${label} is told "could not run" needs the quoted attempt`, Boolean(turn) && turn.prompt.includes('could not run'))
      }
      const step = engine.run.steps.find((s) => s.stepId === 'implement')
      t.eq('the author\'s step records its commands as unconfined (run evidence)', step?.tooling, { commands: 'unconfined', ids: ['unit', 'fmt'], reason: 'the seat fence is switched off (DEVPANEL_FENCE=off)' })
      const confirm = turns.find((tn) => tn.stepId === 'confirm')
      if (confirm) t.ok('so is the closure confirmation', lines.every((l) => confirm.prompt.includes(l)))
    }
  } finally {
    await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
  }
}

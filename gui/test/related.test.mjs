import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { engineFixture, scriptFor } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'

const exec = promisify(execFile)
const git = async (dir, ...args) => (await exec('git', ['-C', dir, ...args])).stdout

export const name = 'Phase 2 — related projects are read-only run-start snapshots'

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }

  // A related project shaped like the framework: source, an ignored secret, build output.
  const lib = await temp('rel-lib-')
  await git(lib, 'init', '-q', '-b', 'main'); await git(lib, 'config', 'user.email', 't@t'); await git(lib, 'config', 'user.name', 'T')
  await fs.writeFile(path.join(lib, '.gitignore'), 'secrets/\nbuild/\n')
  await fs.mkdir(path.join(lib, 'docs')); await fs.writeFile(path.join(lib, 'docs', 'guide.md'), '# guide\n')
  await git(lib, 'add', '-A'); await git(lib, 'commit', '-qm', 'lib')
  await fs.mkdir(path.join(lib, 'secrets')); await fs.writeFile(path.join(lib, 'secrets', 'token'), 'SECRET')
  await fs.mkdir(path.join(lib, 'build')); await fs.writeFile(path.join(lib, 'build', 'out.js'), 'generated')
  await fs.writeFile(path.join(lib, 'notes.md'), 'untracked, not ignored\n')
  const projectsDir = await temp('rel-projects-')
  await fs.symlink(lib, path.join(projectsDir, 'lib-project'))

  const seen = []
  const f = await engineFixture({ playbook: 'implementation', script: async (turn) => { seen.push(turn); return scriptFor()(turn) } })
  await fs.mkdir(path.join(f.configRoot, 'projects'), { recursive: true })
  await fs.writeFile(path.join(f.configRoot, 'projects', 'devpanel-project.yaml'),
    'id: devpanel-project\nworkspace:\n  base: working-tree\n  related:\n    - project: lib-project\n      reason: the framework it composes\n')

  const saved = { dir: process.env.DEVPANEL_PROJECTS_DIR, fence: process.env.DEVPANEL_FENCE }
  process.env.DEVPANEL_PROJECTS_DIR = projectsDir
  try {
    const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
    const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: 'devpanel-project' })
    t.eq('the related list reaches the resolved workspace', resolved.resolved.workspace.related?.[0]?.project, 'lib-project')
    const engine = await startRun({ expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
      configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions })

    t.section('1. the snapshot carries what the project carries, nothing else')
    const related = engine.run.workspace.related?.[0]
    t.ok('a snapshot was taken', Boolean(related?.snapshot), JSON.stringify(related))
    const has = (rel) => fs.lstat(path.join(related.snapshot, rel)).then(() => true, () => false)
    t.ok('tracked source is there', await has('docs/guide.md'))
    t.ok('an untracked, not ignored file is there', await has('notes.md'))
    t.ok('the ignored secret is not', !(await has('secrets/token')))
    t.ok('ignored build output is not', !(await has('build/out.js')))
    t.ok('no history travels with it', !(await has('.git')))
    t.eq('files are read-only', ((await fs.stat(path.join(related.snapshot, 'docs/guide.md'))).mode & 0o222), 0)
    t.eq('the source revision is recorded', related.head, (await git(lib, 'rev-parse', 'HEAD')).trim())

    t.section('2. seats are told about it and the fence mounts it read-only')
    delete process.env.DEVPANEL_FENCE
    const spec = await engine.fenceSpec({ coordinationOnly: false, tooling: { writesCode: true, allowedRoots: [] }, scratchDir: engine.run.workspace.scratchPath })
    t.ok('the snapshot is a read-only mount', spec.readOnly.includes(related.snapshot) && !spec.writable.includes(related.snapshot))
    await engine.drive()
    const implement = seen.find((s) => s.stepId === 'implement')
    t.ok('the implementer is told it is read-only and not the candidate', /Related projects, read-only snapshots/.test(implement?.prompt ?? '') && implement.prompt.includes(related.snapshot))
    t.ok('the candidate does not contain it', !(await fs.lstat(path.join(engine.run.workspace.path, 'lib-project')).then(() => true, () => false)))

    t.section('3. release removes it')
    await releaseWorkspace(engine)
    t.ok('the snapshot is gone with the workspace', !(await fs.lstat(related.snapshot).then(() => true, () => false)))
  } finally {
    for (const [k, v] of [['DEVPANEL_PROJECTS_DIR', saved.dir], ['DEVPANEL_FENCE', saved.fence]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
  }
}

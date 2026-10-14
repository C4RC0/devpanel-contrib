import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { engineFixture, scriptFor, blocking } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { runProcess } from '../server/runtime/process.mjs'
import * as claude from '../../harness/claude.mjs'
import { READ_TOOLS } from '../../harness/claude.mjs'
import { assertScratchOutsideWorktree } from '../../harness/shared.mjs'
import { fenceArgs, fencedCommand } from '../../harness/fence.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RECORDER = path.join(HERE, 'fakes', 'cli', 'env-recorder.mjs')
const PANEL = path.resolve(HERE, '..', '..')

export const name = 'Phase 1 — triage reads the run\'s snapshot inside the fence, in its own session'

const json = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null

function script () {
  return async (turn) => {
    const { stepId, round, prompt } = turn
    if (stepId === 'triage') return json({ fit: true, reasoning: 'Fits.', acceptanceCriteria: [{ id: 'AC1', statement: 'Works' }], suggestion: { action: 'continue', reason: 'go' }, autonomy: { verdict: 'autonomous', reason: 'one run' },
      facts: [{ claim: 'source.txt exists', evidence: 'source.txt:1' }] })
    if (stepId.startsWith('brief')) return json({ targetRole: 'implementer', prompt: `BRIEF-${round}`, windowDecision: 'keep' })
    if (stepId === 'implement') return json({ summary: 'Implemented', basedOnRevision: revision(prompt) })
    if (stepId.startsWith('audit-')) return json({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [] })
    if (stepId === 'confirm') return json({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revision(prompt) })
    return scriptFor()(turn)
  }
}

async function run ({ fence = true, isolation = null } = {}) {
  const saved = process.env.DEVPANEL_FENCE
  if (fence) delete process.env.DEVPANEL_FENCE; else process.env.DEVPANEL_FENCE = 'off'
  const calls = []
  const f = await engineFixture({ playbook: 'implementation', script: script() })
  const original = f.harnesses.fake.invoke
  f.harnesses.fake.invoke = (options) => { calls.push({ stepId: options.meta?.stepId, role: options.meta?.role, options }); return original(options) }
  const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } }, ...(isolation ? { isolation } : {}) }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: 'devpanel-project' })
  const engine = await startRun({ expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions })
  try { await engine.drive() } finally { if (saved === undefined) delete process.env.DEVPANEL_FENCE; else process.env.DEVPANEL_FENCE = saved }
  return { f, engine, calls, resolved: resolved.resolved }
}

export default async function (t) {
  t.section('1. the triage step declares read access; nothing else does')
  {
    const { resolved } = await run({ fence: false })
    const steps = resolved.phases.flatMap((p) => p.step ? [p.step] : (p.loop?.steps ?? []))
    t.eq('triage is `access: read`', steps.find((s) => s.id === 'triage')?.access, 'read')
    t.eq('no other step is', steps.filter((s) => s.access === 'read').map((s) => s.id), ['triage'])
    const pai = await resolvePlaybook('plan-and-implement', { root: resolved.strategy.dir.replace(/strategy-templates.*$/, '') })
    const paiSteps = pai.resolved.phases.flatMap((p) => p.step ? [p.step] : (p.loop?.steps ?? []))
    t.eq('plan-and-implement triage too', paiSteps.find((s) => s.id === 'triage')?.access, 'read')
  }

  t.section('2. with the fence on, triage is invoked as a reading turn')
  {
    const { engine, calls } = await run({ fence: true })
    t.eq('the run completes', engine.run.status, 'completed', engine.run.blockedReason)
    const triage = calls.find((c) => c.stepId === 'triage').options
    t.eq('read-only tools requested', triage.readOnlyTools, true)
    t.eq('still a coordination turn (tool-free if the fence is not proved)', triage.supervisorOnly, true)
    t.eq('it starts in the worktree', triage.cwd, engine.run.workspace.path)
    t.ok('the worktree is mounted read-only, nothing of it writable', triage.fence?.readOnly?.includes(engine.run.workspace.path) && !triage.fence?.writable?.includes(engine.run.workspace.path))
    t.eq('with its own CLI home', triage.cliHome.endsWith('cli-homes/coordinator-read'), true)
    t.eq('and its own (new) session', triage.session, null)
    t.ok('the prompt names the snapshot and the facts field', /Source snapshot for this triage \(read-only\)/.test(triage.prompt) && /facts/.test(triage.instructions))
    t.ok('the tooling is read-only and offline', triage.tooling?.writesCode === false && triage.tooling?.networkAccess === false)
    const brief = calls.filter((c) => c.role === 'coordinator' && c.stepId !== 'triage' && c.stepId !== 'confirm').map((c) => c.options)
    t.ok('later coordinator turns are not reading turns', brief.every((o) => !o.readOnlyTools && o.cwd !== engine.run.workspace.path))
    // `access: checks`: the confirmation reads the run's check logs and
    // evidence, never the source, in the coordinator's own session.
    const confirm = calls.find((c) => c.stepId === 'confirm').options
    t.ok('the confirmation reads the check logs only', confirm.readOnlyTools === true && confirm.cwd !== engine.run.workspace.path &&
      confirm.fence?.readOnly?.some((p) => p.endsWith('/checks')) && !confirm.fence?.readOnly?.includes(engine.run.workspace.path), JSON.stringify(confirm.fence?.readOnly))
    t.ok('in the main session and home', !confirm.cliHome.endsWith('-read') && (!confirm.session || confirm.session.id !== engine.run.participants.coordinator.readSession?.id))
    const coordinatorCwd = brief[0]?.cwd
    t.eq('in the coordinator\'s own working directory, where its session lives', confirm.cwd, coordinatorCwd)
    t.ok('writing only to a scratch of its own beside it', confirm.scratchDir !== confirm.cwd && path.dirname(confirm.scratchDir) === path.dirname(confirm.cwd) &&
      JSON.stringify(confirm.fence?.writable) === JSON.stringify([confirm.scratchDir]) && confirm.fence?.readOnly?.includes(confirm.cwd), JSON.stringify({ cwd: confirm.cwd, scratch: confirm.scratchDir, fence: confirm.fence }))
    // The helper the Claude (:367) and Codex (:253) adapters call for a
    // read-only turn; it refused the confirmation when cwd was its scratch.
    const paths = await assertScratchOutsideWorktree(confirm.cwd, confirm.scratchDir).then(() => 'accepted', (e) => e.message)
    t.eq('the adapters\' scratch-outside-cwd check accepts these paths', paths, 'accepted')
    t.ok('and do not resume the triage session', brief.every((o) => !o.session || o.session?.id !== engine.run.participants.coordinator.readSession?.id))
    t.ok('the triage session is kept apart', Boolean(engine.run.participants.coordinator.readSession))

    // The real Claude adapter, given exactly what the engine passed (only the
    // CLI is a fake that records its arguments), inside a real fence.
    const unavailable = await realAdapterUnavailable()
    if (unavailable) t.skip('the real Claude adapter launches the confirmation with read tools inside a proved fence', unavailable)
    else {
      const proved = await viaClaude(confirm)
      t.ok('the real Claude adapter launches it inside a proved fence', !proved.error && proved.result?.diagnostics?.fence?.namespace === 1, proved.error?.message ?? JSON.stringify(proved.result?.diagnostics?.fence))
      t.eq('with read tools only', argAfter(proved.record?.argv, '--tools'), READ_TOOLS.join(','))
      const sandboxed = JSON.parse(argAfter(proved.record?.argv, '--settings') ?? '{}').sandbox?.filesystem
      t.ok('its shell may write only the turn\'s scratch', JSON.stringify(sandboxed?.allowWrite) === JSON.stringify([await fs.realpath(confirm.scratchDir)]) && sandboxed?.denyWrite?.includes(confirm.cwd), JSON.stringify(sandboxed))
      process.env.DEVPANEL_FENCE_UNPROVED = 'run'
      let unproved
      try { unproved = await viaClaude({ ...confirm, fence: { ...confirm.fence, canaries: [confirm.cwd] } }) } finally { delete process.env.DEVPANEL_FENCE_UNPROVED }
      t.ok('with the fence unproved (DEVPANEL_FENCE_UNPROVED=run) it runs as namespace 0', !unproved.error && unproved.result?.diagnostics?.fence?.namespace === 0, unproved.error?.message)
      t.eq('and tool-free, as before', argAfter(unproved.record?.argv, '--tools'), '')
    }
    await releaseWorkspace(engine)
  }

  t.section('3. with the fence off, triage stays tool-free exactly as before')
  {
    const { engine, calls } = await run({ fence: false })
    const triage = calls.find((c) => c.stepId === 'triage').options
    t.eq('no read tools', triage.readOnlyTools, false)
    t.ok('in its scratch directory', triage.cwd !== engine.run.workspace.path)
    t.ok('with the tool-free instructions', /Tools are disabled/.test(triage.instructions))
    const confirm = calls.find((c) => c.stepId === 'confirm').options
    t.ok('the confirmation is tool-free too, in its usual working directory and scratch', confirm.readOnlyTools === false && confirm.supervisorOnly === true && confirm.scratchDir === confirm.cwd && confirm.fence === null,
      JSON.stringify({ readOnlyTools: confirm.readOnlyTools, cwd: confirm.cwd, scratch: confirm.scratchDir }))
    await releaseWorkspace(engine)
  }

  t.section('4. in place, with the fence on, the confirmation stays tool-free exactly as before')
  {
    const { engine, calls } = await run({ fence: true, isolation: 'in-place' })
    t.eq('the run is in place', engine.run.workspace?.isolation, 'in-place')
    const confirm = calls.find((c) => c.stepId === 'confirm')?.options
    t.ok('no read tools, in its usual working directory and scratch', confirm?.readOnlyTools === false && confirm?.supervisorOnly === true && confirm?.scratchDir === confirm?.cwd,
      JSON.stringify({ readOnlyTools: confirm?.readOnlyTools, cwd: confirm?.cwd, scratch: confirm?.scratchDir }))
    await releaseWorkspace(engine)
  }
}

const argAfter = (argv = [], flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }

/** Why the real adapter cannot be launched in a fence here, or null. */
async function realAdapterUnavailable () {
  // claude.mjs makes its runtime temp under /tmp before anything else.
  const temp = await fs.mkdtemp('/tmp/dpc-').catch((e) => ({ error: e }))
  if (temp.error) return `the Claude adapter's runtime temp cannot be made here (${temp.error.code})`
  await fs.rm(temp, { recursive: true, force: true })
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'confirm-fence-'))
  try {
    const wrapped = fencedCommand({ command: '/bin/true', args: [], fence: await fenceArgs({ cwd: dir, writable: [dir] }) })
    const r = await runProcess({ command: wrapped.command, args: wrapped.args, env: { PATH: '/usr/bin:/bin' }, stdin: '' })
    if (r.code !== 0) return `bubblewrap failed: ${r.stderr.trim().slice(0, 120)}`
    // Whether this host can fence any Claude turn at all (its manifest binds
    // more than a bare fence): an ordinary worker turn, as in fence.test.mjs.
    const worktree = path.join(dir, 'worktree'), scratch = path.join(dir, 'scratch'), ledger = path.join(dir, 'ledger')
    for (const d of [worktree, scratch, ledger]) await fs.mkdir(d)
    const plain = await viaClaude({ model: 'm', cwd: worktree, scratchDir: scratch, ledgerDir: ledger, prompt: 'hi', hygiene: true,
      tooling: { writesCode: true, allowLiveCheckout: false, liveCheckout: null, allowedRoots: [scratch] }, fence: { cwd: worktree, writable: [worktree, scratch], readOnly: [], entries: [], panelRoot: PANEL } })
    return plain.result?.diagnostics?.fence?.namespace === 1 ? null : `this host cannot fence a Claude turn: ${(plain.error?.message ?? JSON.stringify(plain.result?.diagnostics?.fence)).slice(0, 200)}`
  } catch (error) {
    return error.code === 'ENOENT' ? 'bubblewrap or setpriv absent' : error.message
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

/** Invoke the real Claude adapter with the engine's options; the CLI records its argv. */
async function viaClaude (options) {
  const log = path.join(options.scratchDir, `argv-${Date.now()}.jsonl`)
  const saved = { DEVPANEL_CLAUDE_BIN: process.env.DEVPANEL_CLAUDE_BIN, DEVPANEL_ENV_RECORDER: process.env.DEVPANEL_ENV_RECORDER, DEVPANEL_CHILD_ENV_PASS: process.env.DEVPANEL_CHILD_ENV_PASS }
  Object.assign(process.env, { DEVPANEL_CLAUDE_BIN: RECORDER, DEVPANEL_ENV_RECORDER: log, DEVPANEL_CHILD_ENV_PASS: 'DEVPANEL_ENV_RECORDER' })
  try {
    // The fake CLI and node's packages live in the panel checkout: granted read-only for this test only.
    const fence = { ...options.fence, readOnly: [...options.fence.readOnly, path.dirname(RECORDER), path.join(PANEL, 'gui', 'node_modules')] }
    const result = await claude.invoke({ ...options, session: null, cliHome: null, fence }).catch((error) => ({ error }))
    const record = (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l)).pop() ?? null
    return result?.error ? { error: result.error, record } : { result, record }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}

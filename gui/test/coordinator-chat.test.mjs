import fs from 'node:fs/promises'
import path from 'node:path'

import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { readRun } from '../server/runtime/store.mjs'
import { instructionsFor, chatView, instructionRefusal, recordInstruction, askCoordinator, readChat, chatFile, coordinatorRole } from '../server/runtime/coordinator-chat.mjs'
import { engineFixture, scriptFor, pausingStrategy } from './fakes/fixture.mjs'

const launch = (f) => startRun({
  playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
  issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
})

export default async (t) => {
  t.section('1. which instructions a coordinator turn is still owed')
  {
    const entries = [
      { id: 'i1', kind: 'instruction', at: '2026-10-03T10:00:00Z', actor: 'op', text: 'one' },
      { id: 'q1', kind: 'question', at: '2026-10-03T10:01:00Z', actor: 'op', text: 'why?' },
      { id: 'i2', kind: 'instruction', at: '2026-10-03T10:02:00Z', actor: 'op', text: 'two' }
    ]
    const steps = [{ number: 3, stepId: 'brief', instructions: ['i1'] }, { number: 4, stepId: 'triage', instructions: ['i2'], instructionScope: 'read' }]
    t.eq('the main session is owed what no main-scope step carried', instructionsFor(entries, steps).map((e) => e.id), ['i2'])
    t.eq('the read session keeps its own account', instructionsFor(entries, steps, { scope: 'read' }).map((e) => e.id), ['i1'])
    t.eq('a fresh session is given every instruction', instructionsFor(entries, steps, { freshSession: true }).map((e) => e.id), ['i1', 'i2'])
    t.eq('questions are never delivered', instructionsFor(entries, []).map((e) => e.id), ['i1', 'i2'])
    const view = chatView(entries, steps, { asking: new Set(['q1']) })
    t.eq('a carried instruction reads as delivered, naming its step', [view[0].delivery, view[0].carriedBy[0]?.step], ['delivered', 3])
    t.eq('a question in flight reads as asking', view[1].state, 'asking')
    t.eq('the same question after a restart reads as interrupted', chatView(entries, steps)[1].state, 'interrupted')
    t.eq('a completed run takes no instructions', typeof instructionRefusal({ status: 'completed' }), 'string')
    t.eq('a paused or failed one does', [instructionRefusal({ status: 'paused' }), instructionRefusal({ status: 'failed' })], [null, null])
  }

  t.section('2. an instruction given while the run waits is delivered in the next coordinator turn, once')
  {
    const f = await engineFixture({ script: scriptFor({ needsInput: 'Which branch?' }) })
    await pausingStrategy(f.configRoot, { rounds: false })
    const engine = await launch(f)
    await engine.drive()
    t.eq('the run paused after triage', engine.run.status, 'paused')
    t.eq('the fixture has a coordinator seat', coordinatorRole(engine.snapshot), 'coordinator')

    let refused = null
    try { await recordInstruction({ issuePath: f.issuePath, runId: engine.runId, run: engine.run, text: '  ', actor: 'op' }) } catch (error) { refused = error }
    t.eq('an empty instruction is refused', refused?.status, 400)
    const instruction = await recordInstruction({ issuePath: f.issuePath, runId: engine.runId, run: engine.run, text: 'Keep the public API unchanged.', actor: 'Alice' })
    t.ok('it is on disk beside the run', (await fs.readFile(chatFile(f.issuePath, engine.runId), 'utf8')).includes(instruction.id))
    const stepsBefore = (await readRun(f.issuePath, engine.runId)).steps.length
    t.eq('recording it does not touch the run record', engine.run.steps.length, stepsBefore)

    await engine.answer({ pauseId: engine.run.pause.id, text: 'main', actor: 'Alice' })
    const seen = []
    engine.harnesses = { fake: { ...f.fake, invoke: async (a) => { seen.push(a); return f.fake.invoke(a) } } }
    const done = await engine.drive()
    t.eq('the run completes', `${done.status}/${done.outcome}`, 'completed/resolved', done.blockedReason)
    const coordinatorTurns = seen.filter((a) => a.meta.role === 'coordinator')
    const first = coordinatorTurns[0]
    t.ok('the next coordinator turn carries it verbatim, last', first?.prompt.includes('## Operator instructions') && first.prompt.includes('Keep the public API unchanged.'), first?.prompt.slice(-800))
    t.ok('worker turns do not', seen.filter((a) => a.meta.role !== 'coordinator').every((a) => !a.prompt.includes('Keep the public API unchanged.')))
    t.ok('later coordinator turns on the same session do not repeat it', coordinatorTurns.slice(1).every((a) => !a.prompt.includes('Keep the public API unchanged.')), coordinatorTurns.length)
    const carrier = done.steps.find((s) => s.instructions?.includes(instruction.id))
    t.ok('the step that carried it records so', Boolean(carrier) && carrier.role === 'coordinator', JSON.stringify(done.steps.map((s) => [s.stepId, s.instructions])))
    t.eq('…in the main session scope', carrier?.instructionScope, 'main')
    const view = chatView(await readChat(f.issuePath, engine.runId), done.steps)
    t.eq('the chat shows it delivered in that step', view[0].carriedBy.map((c) => c.step), [carrier?.number])
    let late = null
    try { await recordInstruction({ issuePath: f.issuePath, runId: engine.runId, run: done, text: 'too late', actor: 'op' }) } catch (error) { late = error }
    t.eq('the completed run refuses another', late?.status, 409)
    await releaseWorkspace(engine)
  }

  t.section('3. a question is answered in a fork of the coordinator session and changes nothing')
  {
    const f = await engineFixture({ script: scriptFor({ needsInput: 'Which branch?' }) })
    await pausingStrategy(f.configRoot, { rounds: false })
    const engine = await launch(f)
    await engine.drive()
    const before = JSON.stringify(await readRun(f.issuePath, engine.runId))
    const calls = []
    const fake = { invoke: async (a) => { calls.push(a); return { session: { id: 'forked' }, response: 'Because triage needs the branch.', usage: { costUsd: 0.01 }, outcome: 'completed' } } }
    const events = []
    const harness = engine.participantSpec('coordinator').model.harness
    const { question, answer } = await askCoordinator(engine, { text: 'Why did you stop?', actor: 'Alice', harnesses: { [harness]: fake }, emit: (e) => events.push(e) })
    const call = calls[0]
    t.eq('one invocation, forking the coordinator session', [calls.length, call?.fork, call?.session?.id], [1, true, engine.run.participants.coordinator.session.id])
    t.eq('tool-free', call?.supervisorOnly, true)
    t.ok('the prompt says it is a side question and where the run stands', /side question/.test(call?.prompt) && /Run status now: paused/.test(call?.prompt) && call.prompt.includes('Why did you stop?'))
    t.eq('the answer is recorded against the question', [answer.replyTo, answer.status, answer.text, answer.costUsd], [question.id, 'answered', 'Because triage needs the branch.', 0.01])
    t.eq('question and answer were announced', events.filter((e) => e.type === 'chat').length, 2)
    t.eq('the run record is byte-for-byte unchanged', JSON.stringify(await readRun(f.issuePath, engine.runId)), before)

    const failing = { invoke: async () => { throw Object.assign(new Error('claude exited 1'), { kind: 'runtime-error' }) } }
    const failed = await askCoordinator(engine, { text: 'Again?', actor: 'Alice', harnesses: { [harness]: failing } })
    t.eq('a runtime failure is recorded as an unanswered question, not thrown', failed.answer.status, 'failed')

    let refused = null
    const fresh = { ...engine, run: { ...engine.run, participants: { ...engine.run.participants, coordinator: { ...engine.run.participants.coordinator, session: null, readSession: null } } }, participantSpec: (r) => engine.participantSpec(r) }
    try { await askCoordinator(fresh, { text: 'Hello?', actor: 'op', harnesses: { [harness]: fake } }) } catch (error) { refused = error }
    t.eq('without a session there is nothing to ask', refused?.status, 409)
    t.eq('…and nothing was recorded for it', (await readChat(f.issuePath, engine.runId)).filter((e) => e.text === 'Hello?').length, 0)
    await releaseWorkspace(engine)
  }

  t.section('4. the adapters fork rather than resume')
  {
    const claude = await fs.readFile(path.resolve(import.meta.dirname, '../../harness/claude.mjs'), 'utf8')
    const codex = await fs.readFile(path.resolve(import.meta.dirname, '../../harness/codex.mjs'), 'utf8')
    t.ok('claude: --fork-session under a new id', claude.includes("'--fork-session', '--session-id', sessionId"))
    t.ok('claude: thinking summaries requested', claude.includes('showThinkingSummaries: true'))
    t.ok('codex: exec fork', claude && codex.includes("fork ? 'fork' : 'resume'"))
    t.ok('codex: reasoning summaries requested', codex.includes('model_reasoning_summary="detailed"'))
  }
}

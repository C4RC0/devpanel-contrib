import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { parseSupervisorResponse } from '../server/supervisor-response.mjs'

const wait = async (test) => { const end = Date.now() + 4000; while (!test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }

/*
 * The supervisor's side of the conversation: a side question answered in a fork
 * of its session, the reasoning of a working call as live output, and the
 * questions it records for the operator with ask_operator.
 */
export default async function (t) {
  t.section('1. ask_operator is part of the action vocabulary')
  {
    const ok = (action) => { try { parseSupervisorResponse(JSON.stringify({ message: 'm', action })); return true } catch { return false } }
    t.ok('a bare question', ok({ type: 'ask_operator', question: 'Accept the residual risk?' }))
    t.ok('with its issue and closed options', ok({ type: 'ask_operator', question: 'Accept?', project: 'p', issueId: 'i', options: ['accept', 'reject'] }))
    t.ok('an empty question is refused', !ok({ type: 'ask_operator', question: ' ' }))
    t.ok('an issue without its project is refused', !ok({ type: 'ask_operator', question: 'q', issueId: 'i' }))
    t.ok('more than six options is refused', !ok({ type: 'ask_operator', question: 'q', options: ['1', '2', '3', '4', '5', '6', '7'] }))
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-supervisor-chat-'))
  const invocations = []
  const events = []
  let script = []
  const models = async () => [{ id: 'test-model', title: 'Test model', harness: 'claude', model: 'wire-model', defaultEffort: 'high', verification: { status: 'verified' } }]
  const adapter = { invoke: async (args) => {
    invocations.push(args)
    args.observe?.onOutput?.('stdout', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: args.fork ? 'weighing the side question' : 'weighing the queue' }] } }) + '\n')
    if (args.fork) return { session: { id: 'forked-copy' }, response: 'Because the queue is empty.', usage: { costUsd: 0.02 } }
    const event = JSON.parse(args.prompt).event
    const action = script.shift()?.(event) ?? null
    return { session: args.session ?? { id: 'persistent-session' }, response: JSON.stringify({ message: 'Supervisor reply', action }), usage: { costUsd: 0.01 } }
  } }
  const tools = { projects: async () => [{ id: 'one-project' }], playbooks: async () => [], listIssues: async () => [] }
  const agent = await createTopSupervisor({ dir, models, adapter, tools, emit: (e) => events.push(e), pollMs: 20 })
  try {
    t.section('2. a side question needs a session')
    let refused = null
    try { await agent.ask('Why?') } catch (error) { refused = error }
    t.eq('refused before the supervisor has one', refused?.status, 409)

    script = [() => ({ type: 'ask_operator', question: 'Accept the pre-existing failure as residual risk?', project: 'one-project', issueId: 'issue-1', options: ['accept', 'reject'] })]
    await agent.start({ model: 'test-model', projects: ['one-project'], message: 'Coordinate' })
    await wait(() => agent.get().status === 'active' && invocations.length >= 2)

    t.section('3. the charter has the supervisor decide, and reserves only what is irreversible')
    const charter = invocations[0].instructions ?? ''
    t.ok('it decides technical routes itself', /Decide for yourself/.test(charter) && /is yours/.test(charter))
    t.ok('shared staging needs no further authorization', /Shared staging is yours to deploy/.test(charter) && /no further authorization for staging/.test(charter))
    t.ok('production and irreversible steps stay reserved', /never deploy production without an explicit operator instruction/.test(charter) && /anything else irreversible/.test(charter))
    t.ok('an open question does not stop unrelated work', /keep doing everything that does not depend on it/.test(charter))

    t.section('3b. the working call streams its reasoning')
    const first = invocations[0]
    const live = await agent.live(first.meta.invocationId)
    t.ok('its output was kept under the invocation id', live.entries.some((e) => e.text.includes('weighing the queue')), JSON.stringify(live.entries).slice(0, 300))
    t.ok('and announced as a live event', events.some((e) => e.type === 'live' && e.invocationId === first.meta.invocationId))
    t.eq('an invalid invocation id is refused', await agent.live('../x').then(() => 'read', (e) => e.status), 400)

    t.section('4. ask_operator records an open question; an answer reaches the supervisor as an event')
    const open = agent.questions()
    t.eq('one open question, with its issue and options', [open.length, open[0]?.issueId, open[0]?.options], [1, 'issue-1', ['accept', 'reject']])
    t.ok('announced', events.some((e) => e.type === 'question'))
    let wrong = null
    try { await agent.answerQuestion(open[0].id, { answer: 'maybe', actor: 'Alice' }) } catch (error) { wrong = error }
    t.eq('a closed question takes only one of its options', wrong?.status, 422)
    let anonymous = null
    try { await agent.answerQuestion(open[0].id, { answer: 'accept' }) } catch (error) { anonymous = error }
    t.eq('an anonymous answer is refused', anonymous?.status, 400)
    const callsBefore = invocations.length
    await agent.answerQuestion(open[0].id, { answer: 'accept', actor: 'Alice' })
    await wait(() => invocations.length > callsBefore)
    const delivered = JSON.parse(invocations.at(-1).prompt).event
    t.eq('the supervisor is woken with the answer', [delivered.type, delivered.questionId, delivered.answer, delivered.actor], ['operator-answer', open[0].id, 'accept', 'Alice'])
    t.eq('the question is no longer open', agent.questions().length, 0)
    let twice = null
    try { await agent.answerQuestion(open[0].id, { answer: 'reject', actor: 'Alice' }) } catch (error) { twice = error }
    t.eq('and cannot be answered twice', twice?.status, 409)
    await wait(() => agent.get().status === 'active')

    t.section('5. a side question is answered in a fork and changes nothing')
    const calls = agent.get().calls
    const session = agent.get().session
    await agent.ask('Why did you ask about the risk?')
    await wait(() => !agent.get().asking)
    const fork = invocations.find((i) => i.fork)
    t.eq('one forked invocation of the working session', [invocations.filter((i) => i.fork).length, fork?.session?.id], [1, 'persistent-session'])
    t.eq('tool-free', fork?.supervisorOnly, true)
    t.eq('the session it works from is unchanged', agent.get().session, session)
    t.eq('not a call of its own (maxCalls)', agent.get().calls, calls)
    const side = agent.get().messages.filter((m) => m.side)
    t.eq('question and answer are in the chat, marked side', side.map((m) => m.side), ['question', 'answer'])
    t.eq('the answer is the copy\'s reply', side[1]?.text, 'Because the queue is empty.')
    t.ok('its reasoning was kept too', (await agent.live(fork.meta.invocationId)).entries.some((e) => e.text.includes('weighing the side question')))
    t.eq('nothing was queued for the supervisor', agent.get().queue.length, 0)
    t.ok('the side conversation is not in a new session\'s history', !JSON.stringify(agent.get().messages.filter((m) => !m.side)).includes('Why did you ask about the risk?'))
    const ledger = (await fs.readFile(path.join(dir, 'ledger.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    t.ok('the call is on the spending ledger, marked side', ledger.some((l) => l.id === fork.meta.invocationId && l.meta?.side === true), JSON.stringify(ledger.slice(-2)))
  } finally {
    await agent.stop(); await agent.shutdown()
  }
}

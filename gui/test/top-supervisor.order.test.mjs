import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTopSupervisor } from '../server/top-supervisor.mjs'

export const name = 'top supervisor — an action\'s result reaches the very next call'

const wait = async (test) => { const end = Date.now() + 4000; while (!test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }

// An operator message that arrives while a call is in flight must not be
// delivered in place of that call's tool result: the model would read its own
// result one call late, and every later result after it.
export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-supervisor-order-'))
  const events = []
  let release = null
  const script = [() => ({ type: 'list_issues', project: 'one-project' }), () => null, () => null]
  const adapter = { invoke: async (args) => {
    const event = JSON.parse(args.prompt).event
    events.push(event)
    if (events.length === 1) await new Promise((resolve) => { release = resolve })
    return { session: { id: 's' }, response: JSON.stringify({ message: 'ok', action: script.shift()?.(event) ?? null }), usage: { costUsd: 0 } }
  } }
  const models = async () => [{ id: 'test-model', title: 'Test', model: 'wire', verification: { status: 'verified' } }]
  const tools = { projects: async () => [{ id: 'one-project' }], playbooks: async () => [], listIssues: async () => [{ id: 'issue' }] }
  const agent = await createTopSupervisor({ dir, models, adapter, tools, pollMs: 20 })
  await agent.start({ model: 'test-model', projects: ['one-project'], message: 'Mission', limits: { maxCalls: 10 } })
  await wait(() => release)
  await agent.chat('Operator note while the call is in flight')
  release()
  await wait(() => events.length >= 3)
  t.eq('the first call carries the mission', events[0].type, 'user')
  t.eq('the second carries the result of the action the first chose', [events[1].type, events[1].action?.type], ['tool-result', 'list_issues'])
  t.eq('the operator note follows it', [events[2].type, events[2].text], ['user', 'Operator note while the call is in flight'])
  await agent.stop()
  await fs.rm(dir, { recursive: true, force: true })
}

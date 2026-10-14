import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createModelOracle, promptFor } from '../server/decisions/model-oracle.mjs'
import { createAdvisor } from '../server/decisions/advisor.mjs'

export const name = 'assess with any roster model — the provider\'s questions, answered through a CLI'

const questions = {
  gate: { type: 'choice', instructions: 'What next?', criteria: { continue: 'work on it', 'close-issue': 'close it', 'needs-input': 'ask' } },
  priority: { type: 'choice', instructions: 'Order?', criteria: { urgent: 'a', high: 'b', normal: 'c', low: 'd' } }
}
const state = { project: 'p', issue: { title: 'Broken export' }, reports: [{ text: 'Export fails with 500.' }] }
const model = { id: 'opus-5-5', title: 'Opus', harness: 'fake', model: 'claude-opus-5-5', efforts: ['low', 'high'], defaultEffort: 'high', verification: { status: 'verified' } }

function fakeAdapter (response, calls = []) {
  return async () => ({
    invoke: async (args) => { calls.push(args); return { outcome: 'completed', response, usage: { costUsd: 0.0123, tokens: 900 } } }
  })
}

export default async function (t) {
  t.section('the prompt carries the questions and the issue')
  const prompt = promptFor({ state, questions })
  t.ok('every question id is in it', prompt.includes('"gate"') && prompt.includes('"priority"'))
  t.ok('the issue is in it', prompt.includes('Export fails with 500.'))
  t.ok('the reply format is stated', prompt.includes('{"answers"'))

  t.section('a model reply becomes provider-shaped answers')
  const calls = []
  const reply = 'Here you go:\n```json\n{"answers":{"gate":{"type":"choice","choice":"close-issue","probabilities":{"continue":0.9,"close-issue":0.2,"needs-input":0.1},"confidence":0.93},' +
    '"priority":{"type":"choice","choice":"high","probabilities":{"urgent":0.1,"high":0.7,"normal":0.2,"low":0}}}}\n```'
  const oracle = createModelOracle({ model, effort: 'low', loadAdapter: fakeAdapter(reply, calls) })
  t.eq('it is named by model and effort', [oracle.id, oracle.model], ['model:opus-5-5', 'opus-5-5@low'])
  const answer = await oracle.ask({ state, questions })
  t.eq('the choice follows the distribution, not the label', answer.answers.gate.choice, 'continue')
  t.ok('probabilities are rescaled to sum to one', Math.abs(Object.values(answer.answers.gate.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-9)
  t.eq('a missing confidence is the top probability', answer.answers.priority.confidence, 0.7)
  t.eq('the cost is what the CLI reported', answer.costUsd, 0.0123)
  t.eq('asked tool-free, at the chosen effort', [calls[0].supervisorOnly, calls[0].effort, calls[0].model], [true, 'low', 'claude-opus-5-5'])

  t.section('a reply without answers is a contract violation')
  let failure = null
  try { await createModelOracle({ model, loadAdapter: fakeAdapter('I think it should be closed.') }).ask({ state, questions }) } catch (error) { failure = error }
  t.eq('classified, charged', [failure?.class, failure?.charged], ['contract-violation', 'yes'])

  t.section('through the advisor: same ledger, threshold and record as the provider')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assess-'))
  const ledgerCalls = []
  const ledger = { reserve: async (x) => ledgerCalls.push(['reserve', x]), settle: async (x) => ledgerCalls.push(['settle', x]), release: async (x) => ledgerCalls.push(['release', x]) }
  const advisor = createAdvisor({
    spending: () => ({ ledger }),
    loadProvider: async () => ({ id: 'jev', model: 'jev-1', threshold: 0.9 }),
    createModelAsker: (m, effort) => createModelOracle({ model: m, effort, loadAdapter: fakeAdapter(reply) })
  })
  const record = await advisor.askModel({ dir, purpose: 'triage-pregate', state, questions, model, effort: 'low' })
  t.eq('recorded as answered by that model', [record.status, record.provider, record.model], ['answered', 'model:opus-5-5', 'opus-5-5@low'])
  t.eq('the provider\'s threshold decides confidence', [record.decisions.gate.confident, record.decisions.priority.confident], [true, false])
  t.eq('its cost is recorded', record.costUsd, 0.0123)
  t.eq('reserved, then settled at that cost', ledgerCalls.map(([k, x]) => [k, x.costUsd ?? x.maxCostUsd]), [['reserve', 1], ['settle', 0.0123]])
  const again = await advisor.askModel({ dir, purpose: 'triage-pregate', state, questions, model, effort: 'low' })
  t.eq('the same question to the same model is read back, not asked again', [again.replayed, ledgerCalls.length], [true, 2])
  const other = await advisor.askModel({ dir, purpose: 'triage-pregate', state, questions, model, effort: 'high' })
  t.eq('another effort is another question', [other.replayed ?? false, other.model], [false, 'opus-5-5@high'])

  const held = createAdvisor({ spending: () => ({ ledger }), availability: () => ({ check: async () => ({ exhaustedUntil: 'x' }) }), loadProvider: async () => null })
  t.eq('a model on hold is not asked', (await held.askModel({ dir, purpose: 'triage-pregate', state, questions, model })).skipped, 'held')
  await fs.rm(dir, { recursive: true, force: true })

  t.section('a long option list: the model names only what it thinks possible')
  const many = { duplicateOf: { type: 'choice', instructions: 'Same as?', criteria: Object.fromEntries([['none', 'none'], ...Array.from({ length: 45 }, (_, i) => [`2026-09-${String(i % 28 + 1).padStart(2, '0')}-issue-${i}`, `issue ${i}`])]) } }
  const short = '{"answers":{"duplicateOf":{"type":"choice","choice":"none","probabilities":{"none":0.95,"2026-09-03-issue-2":0.05},"confidence":0.95}}}'
  const sparse = await createModelOracle({ model, loadAdapter: fakeAdapter(short) }).ask({ state, questions: many })
  t.eq('the omitted options are filled in as 0', Object.keys(sparse.answers.duplicateOf.probabilities).length, 46)
  t.eq('and the answer stands', [sparse.answers.duplicateOf.choice, sparse.answers.duplicateOf.probabilities['2026-09-10-issue-9']], ['none', 0])
  let invented = null
  try { await createModelOracle({ model, loadAdapter: fakeAdapter('{"answers":{"duplicateOf":{"type":"choice","choice":"none","probabilities":{"none":0.5,"made-up-issue":0.5}}}}') }).ask({ state, questions: many }) } catch (error) { invented = error }
  t.eq('an option never offered is still refused', invented?.class, 'contract-violation')

  t.section('a failed assessment is asked again only when asked for on purpose')
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'assess-retry-'))
  let reply2 = 'no json here'
  const flaky = createAdvisor({ spending: () => ({ ledger }), loadProvider: async () => ({ id: 'jev', threshold: 0.9 }),
    createModelAsker: (m, effort) => createModelOracle({ model: m, effort, loadAdapter: async () => ({ invoke: async () => ({ outcome: 'completed', response: reply2, usage: { costUsd: 0, tokens: 10 } }) }) }) })
  const failedFirst = await flaky.askModel({ dir: dir2, purpose: 'triage-pregate', state, questions, model })
  t.eq('the first ask failed and was recorded', failedFirst.status, 'unavailable')
  reply2 = reply
  t.eq('a plain replay reads the failure back, asking nothing', (await flaky.askModel({ dir: dir2, purpose: 'triage-pregate', state, questions, model })).status, 'unavailable')
  const retried = await flaky.askModel({ dir: dir2, purpose: 'triage-pregate', state, questions, model, retryUnavailable: true })
  t.eq('asked on purpose, it is asked again', [retried.status, retried.replayed], ['answered', false])
  t.ok('the failure is kept beside it', (await fs.readdir(dir2)).some((n) => n.includes('.failed-')))
  const answeredAgain = await flaky.askModel({ dir: dir2, purpose: 'triage-pregate', state, questions, model, retryUnavailable: true })
  t.eq('an answered assessment is never asked twice', answeredAgain.replayed, true)
  await fs.rm(dir2, { recursive: true, force: true })
}

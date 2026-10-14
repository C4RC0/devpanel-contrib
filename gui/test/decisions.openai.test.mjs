import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createOpenAIOracle, toOpenAIQuestions, fromOpenAIAnswers } from '../server/decisions/openai.mjs'
import { createJevOracle } from '../server/decisions/jev.mjs'
import { createDecisions, loadDecisionProvider, activeDecisionProviderId } from '../server/decisions/index.mjs'
import { oracleFor, createAdvisor, decisionProviderStatus, decisionAvailabilityId } from '../server/decisions/advisor.mjs'
import { createAvailabilityStore } from '../server/runtime/failure.mjs'
import { createLedger } from '../server/runtime/ledger.mjs'
import { fakeFetch } from './fakes/decision-oracle.mjs'
import { CONFIG_ROOT } from './helpers.mjs'

export const name = 'advisory decisions — the OpenAI Decisions API as a second provider, chosen by configuration'

const temps = []
const temp = async () => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-openai-decisions-')); temps.push(d); return d }
const throwsWith = async (fn) => { try { await fn(); return null } catch (e) { return e } }

const KEY = 'sk-test-openai-0123456789SECRET'
const QUESTIONS = {
  action: { type: 'choice', instructions: 'What should happen next?', criteria: { continue: 'Worth a full run', 'close-issue': 'Nothing to do' } },
  severity: { type: 'score', instructions: 'How severe?', criteria: ['Cosmetic', { what: 'Degraded', examples: ['slow page'] }, { what: 'Blocking' }] },
  duplicate: { type: 'noul', instructions: 'Is this a duplicate?' },
  outage: { type: 'noul', instructions: 'Is everyone locked out?', criteria: { true: 'Nobody can log in', false: 'Some can' } }
}

const baseConfig = (over = {}) => ({
  id: 'openai',
  kind: 'openai',
  endpoint: 'https://api.example.invalid/v1/decisions',
  model: 'gpt-6-luna',
  credentialRef: 'file:~/.config/openai/key',
  threshold: 0.9,
  timeoutMs: 5000,
  retries: 2,
  maxWaitMs: 5000,
  pricing: { inputUsdPerMillionTokens: 0.10, outputUsdPerMillionTokens: 0 },
  maxCallCostUsd: 0.01,
  maxStateChars: 1000,
  ...over
})

async function home () {
  const dir = await temp()
  await fs.mkdir(path.join(dir, '.config', 'openai'), { recursive: true })
  await fs.writeFile(path.join(dir, '.config', 'openai', 'key'), KEY + '\n', { mode: 0o600 })
  return dir
}

/** A well-formed OpenAI answer list for QUESTIONS. */
const openaiAnswers = (over = {}) => [
  { type: 'choice', name: 'action', choice: 'continue', probabilities: [{ value: 'continue', probability: 0.94 }, { value: 'close-issue', probability: 0.06 }], confidence: 0.94, ...over.action },
  { type: 'score', name: 'severity', score: 1.9, probabilities: [{ value: 0, label: '0', probability: 0.02 }, { value: 1, label: '1', probability: 0.06 }, { value: 2, label: '2', probability: 0.92 }], confidence: 0.92, ...over.severity },
  { type: 'predicate', name: 'duplicate', probability: 0.03, ...over.duplicate },
  { type: 'predicate', name: 'outage', probability: 0.97, ...over.outage }
]
const ok = (body = {}) => ({ status: 200, body: { answers: openaiAnswers(), ...body } })

export default async function (t) {
  t.section('1. the request: devpanel questions translated to the OpenAI shape, Bearer key read at call time')
  {
    const h = await home()
    const { fetch, requests } = fakeFetch([ok({ usage: { input_tokens: 300 } })])
    const result = await createOpenAIOracle({ config: baseConfig(), fetch, home: h, root: CONFIG_ROOT }).ask({ state: { issue: 'login fails' }, questions: QUESTIONS })
    const req = requests[0]
    t.eq('one POST to the configured endpoint with the key from the file', [requests.length, req.method, req.url, req.headers.authorization], [1, 'POST', 'https://api.example.invalid/v1/decisions', `Bearer ${KEY}`])
    t.eq('the documented body: model, input, questions', Object.keys(req.body).sort(), ['input', 'model', 'questions'])
    t.eq('state that is not a string is sent JSON-stringified as input', [req.body.model, req.body.input], ['gpt-6-luna', '{"issue":"login fails"}'])
    const byName = Object.fromEntries(req.body.questions.map((q) => [q.name, q]))
    t.eq('questions are an array, id → name', req.body.questions.map((q) => q.name), ['action', 'severity', 'duplicate', 'outage'])
    t.eq('choice → choices [{ value, description }]', byName.action, { type: 'choice', name: 'action', instructions: 'What should happen next?', choices: [{ value: 'continue', description: 'Worth a full run' }, { value: 'close-issue', description: 'Nothing to do' }] })
    t.eq('score → levels [{ label, description }], { what } levels by their what', byName.severity.levels, [{ label: '0', description: 'Cosmetic' }, { label: '1', description: 'Degraded {"examples":["slow page"]}' }, { label: '2', description: 'Blocking' }])
    t.eq('noul without criteria → a bare predicate', byName.duplicate, { type: 'predicate', name: 'duplicate', instructions: 'Is this a duplicate?' })
    t.eq('noul with criteria → a predicate with true/false meanings in the instructions', byName.outage, { type: 'predicate', name: 'outage', instructions: 'Is everyone locked out?\n\nTrue means: Nobody can log in\nFalse means: Some can' })
    t.eq('a string state is sent as it is', toOpenAIQuestions({ a: { type: 'noul', instructions: 'x' } }), [{ type: 'predicate', name: 'a', instructions: 'x' }])

    t.section('2. the answers: translated back to devpanel\'s shape and checked')
    t.eq('choice probabilities array → map keyed by value', result.answers.action, { type: 'choice', choice: 'continue', probabilities: { continue: 0.94, 'close-issue': 0.06 }, confidence: 0.94 })
    t.eq('score probabilities array → map keyed by String(index)', result.answers.severity, { type: 'score', score: 1.9, probabilities: { 0: 0.02, 1: 0.06, 2: 0.92 }, confidence: 0.92 })
    t.eq('predicate probability → noul', [result.answers.duplicate, result.answers.outage], [{ type: 'noul', noul: 0.03 }, { type: 'noul', noul: 0.97 }])
    t.eq('the result has Jev\'s shape; the model is the one asked when not echoed', [result.model, result.attempts, result.usage, typeof result.latencyMs], ['gpt-6-luna', 1, { input_tokens: 300 }, 'number'])

    const record = await createDecisions({ oracle: createOpenAIOracle({ config: baseConfig(), fetch: fakeFetch([ok({ usage: { input_tokens: 300 } })]).fetch, home: h, root: CONFIG_ROOT }), config: baseConfig() })
      .ask({ dir: await temp(), purpose: 'test', state: 's', questions: QUESTIONS })
    t.eq('interpret reads them unchanged', [record.decisions.action.value, record.decisions.severity.value, record.decisions.outage.value, record.decisions.duplicate.value], ['continue', 2, true, false])
    t.eq('reported input tokens are priced at $0.10 per million', record.costUsd, 300 * 0.10 / 1e6)
  }

  t.section('3. a missing usage does not break the ask: cost null, the ledger keeps it unpriced')
  {
    const h = await home()
    const dir = await temp()
    const ledger = createLedger({ file: path.join(dir, 'ledger.jsonl') }); await ledger.load()
    const oracle = createOpenAIOracle({ config: baseConfig(), fetch: fakeFetch([ok()]).fetch, home: h, root: CONFIG_ROOT })
    const record = await createDecisions({ oracle, config: baseConfig(), ledger }).ask({ dir, purpose: 'test', state: 's', questions: QUESTIONS })
    t.eq('answered, usage null, cost null', [record.status, record.usage, record.costUsd], ['answered', null, null])
    const lines = (await fs.readFile(path.join(dir, 'ledger.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    const settle = lines.find((l) => l.kind === 'settle')
    t.eq('settled at the reserved ceiling, recorded as cost unknown', [settle?.costUsdMicros, settle?.meta?.costKnown], [10000, false])
  }

  t.section('4. distributions: the same tolerance as checkAnswers, unknown options are violations')
  {
    const h = await home()
    const ask = (answers) => createOpenAIOracle({ config: baseConfig(), fetch: fakeFetch([{ status: 200, body: { answers } }]).fetch, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: QUESTIONS })
    const near = await ask(openaiAnswers({ action: { probabilities: [{ value: 'continue', probability: 0.94 }, { value: 'close-issue', probability: 0.055 }] } }))
    t.eq('a sum of 0.995 is within tolerance and accepted as given', near.answers.action.probabilities, { continue: 0.94, 'close-issue': 0.055 })
    const far = await throwsWith(() => ask(openaiAnswers({ action: { probabilities: [{ value: 'continue', probability: 0.8 }, { value: 'close-issue', probability: 0.1 }] } })))
    t.ok('a sum of 0.9 is a contract violation, charged', far?.class === 'contract-violation' && far.charged === 'yes' && /sum to/.test(far.message), far?.message)
    const unknown = await throwsWith(() => ask(openaiAnswers({ action: { choice: 'delete-repo', probabilities: [{ value: 'delete-repo', probability: 1 }] } })))
    t.ok('an answer naming an option never offered is a contract violation', unknown?.class === 'contract-violation' && /never offered|not one of the options/.test(unknown.message), unknown?.message)
    const level = await throwsWith(() => ask(openaiAnswers({ severity: { probabilities: [{ value: 0, probability: 0.5 }, { value: 7, probability: 0.5 }] } })))
    t.ok('a level index never offered is a contract violation', level?.class === 'contract-violation' && /never offered 7/.test(level.message), level?.message)
    const missing = await throwsWith(() => ask(openaiAnswers().slice(0, 3)))
    t.ok('a missing answer is a contract violation', missing?.class === 'contract-violation' && /"outage" is missing/.test(missing.message), missing?.message)
    t.ok('a body without an answers array is not the documented shape', /documented shape/.test(fromOpenAIAnswers({ answers: {} }).violation ?? ''))
    t.ok('an unknown answer type is refused', /type must be predicate, choice or score/.test(fromOpenAIAnswers({ answers: [{ name: 'a', type: 'text' }] }).violation ?? ''))
    const typed = await throwsWith(() => ask(openaiAnswers({ duplicate: { type: 'text' } })))
    t.eq('and through ask it is a charged contract violation', [typed?.class, typed?.charged], ['contract-violation', 'yes'])
    t.ok('a name answered twice is refused', /answered twice/.test(fromOpenAIAnswers({ answers: [{ name: 'a', type: 'predicate', probability: 1 }, { name: 'a', type: 'predicate', probability: 1 }] }).violation ?? ''))
  }

  t.section('4b. an untrusted body can only end in a charged contract violation, never a raw TypeError')
  {
    const h = await home()
    const q = { ok: { type: 'noul', instructions: 'x' }, pick: { type: 'choice', instructions: 'y', criteria: { a: 'A', b: 'B' } } }
    const good = { type: 'choice', name: 'pick', choice: 'a', probabilities: [{ value: 'a', probability: 1 }, { value: 'b', probability: 0 }], confidence: 1 }
    const hostile = { toString: null, valueOf: null }
    const bodies = {
      'a type with no string conversion': { answers: [{ name: 'ok', type: hostile, probability: 1 }, good] },
      'a name that is not a string': { answers: [{ name: hostile, type: 'predicate', probability: 1 }, good] },
      'a value with no string conversion': { answers: [{ name: 'ok', type: 'predicate', probability: 1 }, { ...good, probabilities: [{ value: hostile, probability: 1 }] }] },
      'a chosen value that is an object': { answers: [{ name: 'ok', type: 'predicate', probability: 1 }, { ...good, choice: hostile }] },
      'probabilities that are not an array': { answers: [{ name: 'ok', type: 'predicate', probability: 1 }, { ...good, probabilities: { a: 1, b: 0 } }] },
      'a probability that is a string': { answers: [{ name: 'ok', type: 'predicate', probability: '1' }, good] },
      'an answer that is not an object': { answers: ['ok', good] },
      'answers that are an object': { answers: { ok: 1 } },
      'a body that is an array': [1, 2]
    }
    for (const [label, body] of Object.entries(bodies)) {
      // JSON cannot carry an object without toString, so the parsed body is handed over directly.
      const fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' })
      const oracle = createOpenAIOracle({ config: baseConfig(), fetch, home: h, root: CONFIG_ROOT })
      const realParse = JSON.parse
      JSON.parse = (text, ...rest) => (text === '{}' ? body : realParse(text, ...rest))
      let e
      try { e = await throwsWith(() => oracle.ask({ state: 's', questions: q })) } finally { JSON.parse = realParse }
      t.eq(`${label}: contract-violation DecisionError, charged`, [e?.name, e?.class, e?.charged], ['DecisionError', 'contract-violation', 'yes'])
    }
    const record = await createDecisions({ oracle: createOpenAIOracle({ config: baseConfig(), fetch: fakeFetch([{ status: 200, body: { answers: [{ name: 'ok', type: 'text', probability: 1 }] } }]).fetch, home: h, root: CONFIG_ROOT }), config: baseConfig() })
      .ask({ dir: await temp(), purpose: 'test', state: 's', questions: q })
    t.eq('the recorder publishes it as unavailable, not a thrown bug', [record.status, record.failure?.class], ['unavailable', 'contract-violation'])
    const odd = await createOpenAIOracle({ config: baseConfig(), fetch: fakeFetch([{ status: 200, body: { answers: [{ name: 'ok', type: 'predicate', probability: 1 }, good], usage: { input_tokens: 12, details: { x: 1 }, note: 'n' } } }]).fetch, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: q })
    t.eq('usage keeps only its numeric fields', odd.usage, { input_tokens: 12 })
  }

  t.section('4c. names like __proto__ stay own properties, in both directions')
  {
    const h = await home()
    const proto = Object.fromEntries([['__proto__', { type: 'noul', instructions: 'Is it?' }]])
    const one = fakeFetch([{ status: 200, body: { answers: [{ type: 'predicate', name: '__proto__', probability: 0.9 }] } }])
    const r = await createOpenAIOracle({ config: baseConfig(), fetch: one.fetch, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: proto })
    t.eq('a question with id __proto__ is sent by that name', one.requests[0].body.questions.map((x) => x.name), ['__proto__'])
    t.eq('and its answer comes back as an own property', [Object.hasOwn(r.answers, '__proto__'), r.answers.__proto__?.noul, JSON.stringify(r.answers)], [true, 0.9, '{"__proto__":{"type":"noul","noul":0.9}}'])

    const q = { ok: { type: 'noul', instructions: 'x' } }
    const extra = await throwsWith(() => createOpenAIOracle({ config: baseConfig(), fetch: fakeFetch([{ status: 200, body: { answers: [{ type: 'predicate', name: 'ok', probability: 1 }, { type: 'predicate', name: '__proto__', probability: 1 }] } }]).fetch, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: q }))
    t.ok('an unsolicited answer named __proto__ is a question that was not asked', extra?.class === 'contract-violation' && /"__proto__" is for a question that was not asked/.test(extra.message), extra?.message)

    const choice = { pick: { type: 'choice', instructions: 'which?', criteria: Object.fromEntries([['__proto__', 'the odd one'], ['other', 'the plain one']]) } }
    const two = fakeFetch([{ status: 200, body: { answers: [{ type: 'choice', name: 'pick', choice: '__proto__', probabilities: [{ value: '__proto__', probability: 0.95 }, { value: 'other', probability: 0.05 }], confidence: 0.95 }] } }])
    const c = await createOpenAIOracle({ config: baseConfig(), fetch: two.fetch, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: choice })
    t.eq('an option named __proto__ is offered by that value', two.requests[0].body.questions[0].choices.map((x) => x.value), ['__proto__', 'other'])
    t.eq('and keeps its probability', [Object.hasOwn(c.answers.pick.probabilities, '__proto__'), c.answers.pick.probabilities.__proto__, c.answers.pick.choice], [true, 0.95, '__proto__'])
  }

  t.section('5. HTTP failures: the same classes, retries and scrubbing as Jev (shared http.mjs)')
  {
    const h = await home()
    const waits = []
    const sleep = async (ms) => { waits.push(ms) }
    const client = (responses) => { const f = fakeFetch(responses); return { f, oracle: createOpenAIOracle({ config: baseConfig(), fetch: f.fetch, sleep, home: h, root: CONFIG_ROOT }) } }

    const limited = client([{ status: 429, headers: { 'retry-after': '2' } }, ok()])
    const r = await limited.oracle.ask({ state: 's', questions: QUESTIONS })
    t.eq('a 429 honours retry-after, then succeeds, counting both attempts', [waits, r.attempts], [[2000], 2])
    waits.length = 0
    const longWait = client([{ status: 429, headers: { 'retry-after': '60' } }])
    const l = await throwsWith(() => longWait.oracle.ask({ state: 's', questions: QUESTIONS }))
    t.eq('a retry-after past maxWaitMs is rate-limit now, not charged, carrying the wait', [l?.class, l?.charged, l?.retryAfterMs, waits.length], ['rate-limit', 'no', 60000, 0])

    const refused = client([{ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}` } } }])
    const a = await throwsWith(() => refused.oracle.ask({ state: 's', questions: QUESTIONS }))
    t.eq('a 401 is auth, not charged, never retried', [a?.class, a?.charged, refused.f.requests.length], ['auth', 'no', 1])
    t.ok('the echoed key is scrubbed from the message', !a.message.includes(KEY) && a.message.includes('[credential]'), a.message)

    const notJson = await throwsWith(() => client([{ status: 200, body: '<html>gateway</html>' }]).oracle.ask({ state: 's', questions: QUESTIONS }))
    t.eq('a non-JSON body is a contract violation, charged', [notJson?.class, notJson?.charged], ['contract-violation', 'yes'])

    const server = await throwsWith(() => client([{ status: 500 }, { status: 503 }, { status: 502 }]).oracle.ask({ state: 's', questions: QUESTIONS }))
    t.eq('5xx after retries is transient, charge unknown, three attempts', [server?.class, server?.charged, server?.attempts], ['transient', 'unknown', 3])
    const net = await throwsWith(() => client([0, 1, 2].map(() => ({ throw: new TypeError(`connect failed with ${KEY}`) }))).oracle.ask({ state: 's', questions: QUESTIONS }))
    t.ok('a network error naming the key is scrubbed too', net?.class === 'transient' && !net.message.includes(KEY), net?.message)
    const echoed = await throwsWith(() => client([{ status: 200, body: { answers: [{ type: 'choice', name: 'action', choice: KEY, probabilities: [{ value: KEY, probability: 1 }], confidence: 1 }] } }]).oracle.ask({ state: 's', questions: QUESTIONS }))
    t.ok('and a contract violation quoting the key', echoed?.class === 'contract-violation' && !echoed.message.includes(KEY), echoed?.message)

    const none = fakeFetch([])
    const noKey = await throwsWith(() => createOpenAIOracle({ config: baseConfig({ credentialRef: 'file:~/.config/nowhere/key' }), fetch: none.fetch, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: QUESTIONS }))
    t.eq('no key file is configuration, not charged, nothing sent', [noKey?.class, noKey?.charged, none.requests.length], ['configuration', 'no', 0])
    const big = await throwsWith(() => createOpenAIOracle({ config: baseConfig(), fetch: none.fetch, home: h, root: CONFIG_ROOT }).ask({ state: 'x'.repeat(1001), questions: QUESTIONS }))
    t.eq('maxStateChars applies before sending', [big?.class, none.requests.length], ['invalid-question', 0])
    const bad = await throwsWith(() => createOpenAIOracle({ config: baseConfig(), fetch: none.fetch, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: { a: { type: 'choice', instructions: 'x', criteria: {} } } }))
    t.eq('a malformed question is invalid-question', bad?.class, 'invalid-question')
    const controller = new AbortController()
    const pending = createOpenAIOracle({ config: baseConfig(), fetch: fakeFetch([{ hang: true }]).fetch, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: QUESTIONS, signal: controller.signal })
    controller.abort()
    t.eq('the caller\'s signal cancels', (await throwsWith(() => pending))?.class, 'cancelled')
    const hung = await throwsWith(() => createOpenAIOracle({ config: baseConfig({ timeoutMs: 100, retries: 0 }), fetch: fakeFetch([{ hang: true }]).fetch, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: QUESTIONS }))
    t.eq('no response within timeoutMs is a timeout', [hung?.class, hung?.charged], ['timeout', 'unknown'])
  }

  t.section('6. selection: decisions/active.yaml names one provider; Jev when nothing selects')
  {
    const root = await temp()
    await fs.cp(path.join(CONFIG_ROOT, 'schemas'), path.join(root, 'schemas'), { recursive: true })
    await fs.cp(path.join(CONFIG_ROOT, 'decisions'), path.join(root, 'decisions'), { recursive: true })
    t.eq('the shipped configuration selects nothing, so Jev is active', [(await activeDecisionProviderId({ root })).id, (await loadDecisionProvider({ root })).id], ['jev', 'jev'])
    t.eq('a provider without kind is a Jev client', (await loadDecisionProvider({ root })).kind, 'jev')
    const openai = await loadDecisionProvider({ id: 'openai', root: CONFIG_ROOT })
    t.eq('decisions/openai.yaml validates with the agreed values', [openai.kind, openai.model, openai.credentialRef.startsWith('file:'), openai.pricing], ['openai', 'gpt-6-luna', true, { inputUsdPerMillionTokens: 0.10, outputUsdPerMillionTokens: 0 }])
    await fs.writeFile(path.join(root, 'decisions', 'active.yaml'), 'provider: openai\n')
    t.eq('provider: openai makes OpenAI the one active provider', (await loadDecisionProvider({ root })).id, 'openai')
    await fs.writeFile(path.join(root, 'decisions', 'active.yaml'), '# nothing selected\n')
    t.eq('a file that selects nothing leaves Jev', (await loadDecisionProvider({ root })).id, 'jev')
    await fs.writeFile(path.join(root, 'decisions', 'active.yaml'), 'provider: [jev, openai]\n')
    const two = await throwsWith(() => loadDecisionProvider({ root }))
    t.ok('naming more than one provider is refused', /must hold only "provider: <id>"/.test(two?.message ?? ''), two?.message)
    await fs.writeFile(path.join(root, 'decisions', 'active.yaml'), 'provider: openai\n')
    await fs.rm(path.join(root, 'decisions', 'openai.yaml'))
    const gone = await throwsWith(() => loadDecisionProvider({ root }))
    t.ok('a selected provider whose file is missing throws, never falls back to Jev', gone?.provider === 'openai' && /does not exist/.test(gone.message), gone?.message)
    const status = await decisionProviderStatus({ loadProvider: () => loadDecisionProvider({ root }), store: createAvailabilityStore(path.join(root, 'a.json')) })
    t.eq('and the availability page shows it under decision:openai, unconfigured', [status[0].id, status[0].state, /does not exist/.test(status[0].error)], ['decision:openai', 'unconfigured', true])
  }

  t.section('7. the advisor picks the client from the provider\'s kind; the page holds, clears and tests OpenAI like Jev')
  {
    t.ok('kind openai → the OpenAI client', oracleFor(baseConfig(), { fetch: fakeFetch([]).fetch }).model === 'gpt-6-luna')
    const h = await home()
    const viaJev = fakeFetch([{ status: 200, body: { model: 'jev-1', answers: { ok: { type: 'noul', noul: 0.99 } } } }])
    await oracleFor({ ...baseConfig({ id: 'jev', kind: undefined }) }, { fetch: viaJev.fetch, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: { ok: { type: 'noul', instructions: 'x' } } })
      .catch(() => null)
    t.ok('no kind → the Jev client (Jev\'s body has state, not input)', viaJev.requests[0] && 'state' in viaJev.requests[0].body && !('input' in viaJev.requests[0].body))
    t.ok('an unknown kind is refused', /unknown kind/.test((await throwsWith(() => oracleFor({ id: 'x', kind: 'other' })))?.message ?? ''))

    const dir = await temp()
    const store = createAvailabilityStore(path.join(dir, 'a.json'))
    const ledger = createLedger({ file: path.join(dir, 'ledger.jsonl') }); await ledger.load()
    const id = decisionAvailabilityId('openai')
    const q = { ok: { type: 'noul', instructions: 'x' } }
    const config = { ...baseConfig(), hash: 'h1' }
    const replies = [{ status: 401, body: 'bad key' }, { status: 200, body: { answers: [{ type: 'predicate', name: 'ok', probability: 0.99 }] } }]
    const f = fakeFetch(replies)
    const advisor = createAdvisor({ spending: () => ({ ledger }), availability: () => store, loadProvider: async () => config, createOracle: (c) => oracleFor(c, { fetch: f.fetch, home: h, root: CONFIG_ROOT }) })
    const refused = await advisor.ask({ dir, purpose: 'probe', state: 'a', questions: q })
    const hold = await store.check(id)
    t.eq('a 401 from OpenAI is recorded unavailable and holds decision:openai', [refused.failure?.class, /key refused/.test(hold?.reason ?? '')], ['auth', true])
    t.eq('while held, nothing is asked', [(await advisor.ask({ dir, purpose: 'probe', state: 'b', questions: q })).skipped, f.requests.length], ['held', 1])
    await store.clear(id)
    const answered = await advisor.ask({ dir, purpose: 'probe', state: 'c', questions: q })
    t.eq('cleared, the next ask (the Test button\'s probe) is answered', [answered.status, answered.provider], ['answered', 'openai'])

    const noKey = createAdvisor({ spending: () => ({ ledger }), availability: () => store, loadProvider: async () => ({ ...config, credentialRef: 'file:~/.config/nowhere/key' }), createOracle: (c) => oracleFor(c, { fetch: fakeFetch([]).fetch, home: h, root: CONFIG_ROOT }) })
    const probe = await noKey.ask({ dir, purpose: 'probe', state: 'd', questions: q })
    t.eq('with no key file a probe is a recorded configuration failure, not a crash', [probe.status, probe.failure?.class, noKey.lastOutcome().failure?.class], ['unavailable', 'configuration', 'configuration'])
    const status = await decisionProviderStatus({ loadProvider: async () => ({ ...config, credentialRef: `file:${path.join(dir, 'no-such-key')}` }), store, advisors: [noKey] })
    t.eq('and the page row is decision:openai with an unusable key', [status[0].id, status[0].kind, status[0].credential.ok, status[0].state, /not readable \(ENOENT\)/.test(status[0].credential.error)], [id, 'openai', false, 'unconfigured', true])
  }

  t.section('8. Jev is unchanged by the shared client')
  {
    t.eq('createJevOracle still exports and builds an oracle', typeof createJevOracle({ config: { ...baseConfig(), id: 'jev', kind: undefined } }).ask, 'function')
  }

  await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
}

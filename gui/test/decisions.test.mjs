import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { validateQuestions, checkAnswers, interpret, QuestionError } from '../server/decisions/questions.mjs'
import { createJevOracle, readCredential, retryAfterMs, DecisionError } from '../server/decisions/jev.mjs'
import { createDecisions, loadDecisionProvider, confidentAnswer, costOf, canonical } from '../server/decisions/index.mjs'
import { createLedger } from '../server/runtime/ledger.mjs'
import { fakeOracle, fakeFetch, answersFor } from './fakes/decision-oracle.mjs'
import { CONFIG_ROOT } from './helpers.mjs'

export const name = 'advisory decisions — typed questions, checked answers, recorded before acted on'

const temps = []
const temp = async () => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-decisions-')); temps.push(d); return d }

const KEY = 'apik_test_0123456789abcdefSECRET'
const QUESTIONS = {
  action: { type: 'choice', instructions: 'What should happen to this issue next?', criteria: { continue: 'Worth a full run', 'close-issue': 'Nothing to do', 'needs-input': 'Too vague to act on' } },
  severity: { type: 'score', instructions: 'How severe is the reported problem?', criteria: ['Cosmetic', 'Degraded with a workaround', 'Blocking'] },
  duplicate: { type: 'noul', instructions: 'Does this describe the same defect as the other issue?' }
}

const baseConfig = (over = {}) => ({
  id: 'jev',
  endpoint: 'https://api.example.invalid/v1/systemone',
  model: 'jev-latest',
  credentialRef: 'file:~/.config/typesafe/key',
  threshold: 0.9,
  timeoutMs: 5000,
  retries: 2,
  maxWaitMs: 5000,
  pricing: { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 },
  maxCallCostUsd: 0.01,
  maxStateChars: 1000,
  ...over
})

/** A home directory holding the key the way the service user's does: with a trailing newline. */
async function home () {
  const dir = await temp()
  await fs.mkdir(path.join(dir, '.config', 'typesafe'), { recursive: true })
  await fs.writeFile(path.join(dir, '.config', 'typesafe', 'key'), KEY + '\n', { mode: 0o600 })
  return dir
}

const throwsWith = async (fn) => { try { await fn(); return null } catch (e) { return e } }
const ok = (questions = QUESTIONS, pick = {}, confidence = 0.95) => ({ status: 200, body: { model: 'jev-1.13.0', answers: answersFor(questions, pick, confidence), usage: { input_tokens: 280, output_tokens: 20 } } })

export default async function (t) {
  t.section('1. a question is checked before it is sent: a malformed one is our bug, not a provider failure')
  {
    t.eq('a well-formed set passes unchanged', validateQuestions(QUESTIONS), QUESTIONS)
    const refuse = (q) => { try { validateQuestions(q); return null } catch (e) { return e instanceof QuestionError ? e.message : `WRONG ERROR ${e.message}` } }
    t.ok('no questions at all is refused', /at least one/.test(refuse({}) ?? ''))
    t.ok('an unknown type is refused', /type must be one of/.test(refuse({ a: { type: 'text', instructions: 'x' } }) ?? ''))
    t.ok('instructions are required — the id never reaches the model', /instructions are required/.test(refuse({ a: { type: 'noul' } }) ?? ''))
    t.ok('a choice needs two options', /at least 2 options/.test(refuse({ a: { type: 'choice', instructions: 'x', criteria: { only: 'one' } } }) ?? ''))
    const many = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, 'd']))
    t.ok('and at most 255', /at most 255/.test(refuse({ a: { type: 'choice', instructions: 'x', criteria: many } }) ?? ''))
    t.ok('an option needs a description', /needs a description/.test(refuse({ a: { type: 'choice', instructions: 'x', criteria: { a: 'd', b: '' } } }) ?? ''))
    t.ok('a score needs an ordered array of two levels', /ordered array/.test(refuse({ a: { type: 'score', instructions: 'x', criteria: ['one'] } }) ?? ''))
    t.eq('a level may be an object with "what"', refuse({ a: { type: 'score', instructions: 'x', criteria: [{ what: 'low', examples: ['typo'] }, 'high'] } }), null)
    t.ok('noul criteria describe only true and false', /only "true" and "false"/.test(refuse({ a: { type: 'noul', instructions: 'x', criteria: { maybe: 'd' } } }) ?? ''))
    t.ok('an unknown field is refused rather than silently sent', /unknown field/.test(refuse({ a: { type: 'noul', instructions: 'x', temperature: 1 } }) ?? ''))
    t.ok('an id with a separator is refused', /an id is/.test(refuse({ 'a/b': { type: 'noul', instructions: 'x' } }) ?? ''))
  }

  t.section('2. an answer is untrusted: it must answer what was asked, inside what was offered')
  {
    t.eq('a well-formed set of answers has no violations', checkAnswers(QUESTIONS, answersFor(QUESTIONS)), [])
    const outside = answersFor(QUESTIONS)
    outside.action = { type: 'choice', choice: 'delete-repo', probabilities: { continue: 0, 'close-issue': 0, 'needs-input': 1 }, confidence: 1 }
    t.ok('an option never offered is a violation', checkAnswers(QUESTIONS, outside).some((e) => /not one of the options offered/.test(e)))
    const missing = answersFor(QUESTIONS); delete missing.severity
    t.ok('a missing answer is a violation', checkAnswers(QUESTIONS, missing).some((e) => /"severity" is missing/.test(e)))
    const extra = { ...answersFor(QUESTIONS), other: { type: 'noul', noul: 1 } }
    t.ok('an answer to a question never asked is a violation', checkAnswers(QUESTIONS, extra).some((e) => /not asked/.test(e)))
    const wrongType = answersFor(QUESTIONS); wrongType.duplicate = { type: 'choice', choice: 'x', probabilities: {}, confidence: 1 }
    t.ok('an answer of the wrong type is a violation', checkAnswers(QUESTIONS, wrongType).some((e) => /was asked/.test(e)))
    const badSum = answersFor(QUESTIONS); badSum.action.probabilities = { continue: 0.5, 'close-issue': 0.3, 'needs-input': 0.5 }
    t.ok('a distribution that does not sum to one is a violation', checkAnswers(QUESTIONS, badSum).some((e) => /sum to/.test(e)))
    const notTop = answersFor(QUESTIONS, { action: 'continue' }); notTop.action.choice = 'close-issue'
    t.ok('a choice that is not the most probable option is a violation', checkAnswers(QUESTIONS, notTop).some((e) => /not the most probable/.test(e)))
    const badScore = answersFor(QUESTIONS); badScore.severity.score = 7
    t.ok('a score outside the levels is a violation', checkAnswers(QUESTIONS, badScore).some((e) => /outside 0..2/.test(e)))
  }

  t.section('3. what an answer means, and the threshold that decides whether to act on it')
  {
    const a = answersFor(QUESTIONS, { action: 'needs-input', severity: 2, duplicate: 0.03 }, 0.93)
    const choice = interpret(QUESTIONS.action, a.action, 0.9)
    t.eq('a choice is its option, with the provider\'s confidence', [choice.value, choice.confidence, choice.confidenceSource, choice.confident], ['needs-input', 0.93, 'provider', true])
    const score = interpret(QUESTIONS.severity, a.severity, 0.9)
    t.eq('a score acts on its most probable LEVEL, keeping the weighted score beside it', [score.value, score.score], [2, 2])
    const noul = interpret(QUESTIONS.duplicate, a.duplicate, 0.9)
    t.eq('a noul of 0.03 reads as false, with derived confidence 0.97', [noul.value, noul.confidence, noul.confidenceSource, noul.confident], [false, 0.97, 'derived', true])
    const unsure = interpret(QUESTIONS.duplicate, { type: 'noul', noul: 0.6 }, 0.9)
    t.eq('0.6 is true but not confident at 0.9', [unsure.value, unsure.confident], [true, false])
    const edge = interpret(QUESTIONS.action, answersFor(QUESTIONS, {}, 0.9).action, 0.9)
    t.ok('exactly at the threshold is confident', edge.confident)
  }

  t.section('4. the provider configuration is schema-checked; absent means not configured')
  {
    const real = await loadDecisionProvider({ root: CONFIG_ROOT })
    t.eq('decisions/jev.yaml loads with the agreed threshold and key location', [real.id, real.threshold, real.credentialRef, real.model], ['jev', 0.9, 'file:~/.config/typesafe/key', 'jev-latest'])
    t.ok('and carries its content hash', /^[0-9a-f]{64}$/.test(real.hash))
    const root = await temp()
    await fs.cp(path.join(CONFIG_ROOT, 'schemas'), path.join(root, 'schemas'), { recursive: true })
    t.eq('no file means null: not configured, never an error', await loadDecisionProvider({ root }), null)
    await fs.mkdir(path.join(root, 'decisions'))
    await fs.writeFile(path.join(root, 'decisions', 'jev.yaml'), 'id: jev\nendpoint: http://plain.example\nmodel: m\ncredentialRef: file:k\nthreshold: 1.5\npricing: {inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0}\nmaxCallCostUsd: 0.01\n')
    const invalid = await throwsWith(() => loadDecisionProvider({ root }))
    t.ok('an invalid file throws, naming what is wrong', /invalid: .*endpoint.*|invalid: .*threshold/.test(invalid?.message ?? ''), invalid?.message)
    await fs.writeFile(path.join(root, 'decisions', 'jev.yaml'), (await fs.readFile(path.join(CONFIG_ROOT, 'decisions', 'jev.yaml'), 'utf8')).replace('id: jev', 'id: other'))
    const renamed = await throwsWith(() => loadDecisionProvider({ root }))
    t.ok('the file name is the identity', /file name is the identity/.test(renamed?.message ?? ''))
  }

  t.section('5. the client: the documented request, the key read at call time, never echoed')
  {
    const h = await home()
    const { fetch, requests } = fakeFetch([ok()])
    const oracle = createJevOracle({ config: baseConfig(), fetch, home: h, root: CONFIG_ROOT })
    const result = await oracle.ask({ state: 'The panel crashes on start.', questions: QUESTIONS })
    const req = requests[0]
    t.eq('one POST to the configured endpoint', [requests.length, req.method, req.url], [1, 'POST', 'https://api.example.invalid/v1/systemone'])
    t.eq('with the key from the file, trailing newline trimmed', req.headers.authorization, `Bearer ${KEY}`)
    t.eq('and the documented body', Object.keys(req.body).sort(), ['model', 'questions', 'state'])
    t.eq('model and questions exactly as configured and asked', [req.body.model, req.body.questions], ['jev-latest', QUESTIONS])
    t.eq('the answer carries the model the provider says it used', [result.model, result.attempts, result.usage.input_tokens], ['jev-1.13.0', 1, 280])

    await fs.writeFile(path.join(h, '.config', 'typesafe', 'key'), 'apik_rotated\n')
    const second = fakeFetch([ok()])
    await createJevOracle({ config: baseConfig(), fetch: second.fetch, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: QUESTIONS })
    t.eq('a rotated key is used on the next call without a restart', second.requests[0].headers.authorization, 'Bearer apik_rotated')
    await fs.writeFile(path.join(h, '.config', 'typesafe', 'key'), KEY + '\n')

    const echo = fakeFetch([{ status: 401, body: `invalid api key ${KEY}` }])
    const e = await throwsWith(() => createJevOracle({ config: baseConfig(), fetch: echo.fetch, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: QUESTIONS }))
    t.eq('a 401 is auth, refused and not charged, never retried', [e?.class, e?.charged, echo.requests.length], ['auth', 'no', 1])
    t.ok('a provider echoing the key does not put it in our error', !e.message.includes(KEY) && e.message.includes('[credential]'), e.message)

    const env = fakeFetch([ok()])
    await createJevOracle({ config: baseConfig({ credentialRef: 'env:TYPESAFE_TEST_KEY' }), fetch: env.fetch, env: { TYPESAFE_TEST_KEY: ' k-env ' }, root: CONFIG_ROOT }).ask({ state: 's', questions: QUESTIONS })
    t.eq('env: references work too', env.requests[0].headers.authorization, 'Bearer k-env')
  }

  t.section('6. nothing is sent when there is nothing valid to send')
  {
    const h = await home()
    const none = fakeFetch([])
    const noKey = await throwsWith(() => createJevOracle({ config: baseConfig({ credentialRef: 'file:~/.config/nowhere/key' }), fetch: none.fetch, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: QUESTIONS }))
    t.eq('a missing key is configuration, not charged', [noKey?.class, noKey?.charged], ['configuration', 'no'])
    const emptyEnv = await throwsWith(() => readCredential('env:NOPE', { env: {} }))
    t.ok('an unset env reference says so', /empty or not set/.test(emptyEnv?.message ?? ''))
    const agent = await throwsWith(() => readCredential('agent:x'))
    t.ok('an unsupported reference type is refused', /unsupported/.test(agent?.message ?? ''))
    const client = createJevOracle({ config: baseConfig(), fetch: none.fetch, home: h, root: CONFIG_ROOT })
    const bad = await throwsWith(() => client.ask({ state: 's', questions: { a: { type: 'choice', instructions: 'x', criteria: {} } } }))
    t.eq('a malformed question is invalid-question', [bad?.class, bad?.charged], ['invalid-question', 'no'])
    const big = await throwsWith(() => client.ask({ state: 'x'.repeat(1001), questions: QUESTIONS }))
    t.ok('a state over the character cap is refused before sending', big?.class === 'invalid-question' && /1001 characters/.test(big.message))
    const empty = await throwsWith(() => client.ask({ state: '', questions: QUESTIONS }))
    t.eq('an empty state is refused', empty?.class, 'invalid-question')
    t.eq('and in all of these not one request was made', none.requests.length, 0)
  }

  t.section('7. bounded retries: rate limits and transient errors wait, and give up rather than stall')
  {
    const h = await home()
    const waits = []
    const sleep = async (ms) => { waits.push(ms) }
    const limited = fakeFetch([{ status: 429, headers: { 'retry-after': '1' } }, ok()])
    const r = await createJevOracle({ config: baseConfig(), fetch: limited.fetch, sleep, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: QUESTIONS })
    t.eq('a 429 honours retry-after, then succeeds, and counts both attempts', [waits, r.attempts], [[1000], 2])

    waits.length = 0
    const overloaded = fakeFetch([{ status: 529 }, { status: 529 }, { status: 529 }, ok()])
    const o = await throwsWith(() => createJevOracle({ config: baseConfig(), fetch: overloaded.fetch, sleep, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: QUESTIONS }))
    t.eq('529 is rate-limit; retries=2 means three attempts, then give up', [o?.class, o?.attempts, overloaded.requests.length, o?.charged], ['rate-limit', 3, 3, 'no'])
    t.eq('with doubling backoff between them', waits, [500, 1000])

    waits.length = 0
    const longWait = fakeFetch([{ status: 429, headers: { 'retry-after': '60' } }])
    const l = await throwsWith(() => createJevOracle({ config: baseConfig(), fetch: longWait.fetch, sleep, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: QUESTIONS }))
    t.eq('a wait longer than a decision is worth is not waited: the caller falls back', [l?.class, l?.retryAfterMs, waits.length], ['rate-limit', 60000, 0])

    const server = fakeFetch([{ status: 500 }, { status: 503 }, { status: 502 }])
    const s = await throwsWith(() => createJevOracle({ config: baseConfig(), fetch: server.fetch, sleep, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: QUESTIONS }))
    t.eq('a 5xx is transient and its charge is unknown', [s?.class, s?.charged], ['transient', 'unknown'])

    const net = fakeFetch([{ throw: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) }, ok()])
    const n = await createJevOracle({ config: baseConfig(), fetch: net.fetch, sleep, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: QUESTIONS })
    t.eq('a network error is retried', n.attempts, 2)

    const invalid = fakeFetch([{ status: 422, body: { detail: 'bad' } }])
    const i = await throwsWith(() => createJevOracle({ config: baseConfig(), fetch: invalid.fetch, sleep, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: QUESTIONS }))
    t.eq('a 422 is invalid-request, not retried', [i?.class, invalid.requests.length], ['invalid-request', 1])

    const hang = fakeFetch([{ hang: true }])
    const started = Date.now()
    const h1 = await throwsWith(() => createJevOracle({ config: baseConfig({ timeoutMs: 100, retries: 0 }), fetch: hang.fetch, sleep, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: QUESTIONS }))
    t.eq('no response within timeoutMs is a timeout, charge unknown', [h1?.class, h1?.charged], ['timeout', 'unknown'])
    t.ok('and it did not wait much past the timeout', Date.now() - started < 2000)

    const controller = new AbortController()
    const cancel = fakeFetch([{ hang: true }])
    const pending = createJevOracle({ config: baseConfig(), fetch: cancel.fetch, sleep, home: h, root: CONFIG_ROOT }).ask({ state: 's', questions: QUESTIONS, signal: controller.signal })
    controller.abort()
    t.eq('the caller\'s signal cancels', (await throwsWith(() => pending))?.class, 'cancelled')

    t.eq('retry-after as an HTTP date', retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000)
    t.eq('retry-after unreadable is null', retryAfterMs('soon'), null)
  }

  t.section('8. a response we cannot use is a contract violation, and it was charged')
  {
    const h = await home()
    const client = (responses) => { const f = fakeFetch(responses); return createJevOracle({ config: baseConfig(), fetch: f.fetch, home: h, root: CONFIG_ROOT }) }
    const notJson = await throwsWith(() => client([{ status: 200, body: '<html>' }]).ask({ state: 's', questions: QUESTIONS }))
    t.eq('a body that is not JSON', [notJson?.class, notJson?.charged], ['contract-violation', 'yes'])
    const shape = await throwsWith(() => client([{ status: 200, body: { answers: {} } }]).ask({ state: 's', questions: QUESTIONS }))
    t.ok('a body without the documented shape', shape?.class === 'contract-violation' && /documented shape/.test(shape.message), shape?.message)
    const wrong = ok(); wrong.body.answers.action.choice = 'rm-rf'; wrong.body.answers.action.probabilities = { continue: 0, 'close-issue': 0, 'needs-input': 1 }
    const outside = await throwsWith(() => client([wrong]).ask({ state: 's', questions: QUESTIONS }))
    t.ok('an option never offered, with the usage kept for the ledger', outside?.class === 'contract-violation' && outside.usage?.input_tokens === 280, outside?.message)
  }

  t.section('9. recorded before acted on: a replay reads the record and never asks again')
  {
    const dir = await temp()
    const oracle = fakeOracle([{ pick: { action: 'needs-input' }, confidence: 0.95 }, { pick: { action: 'continue' }, confidence: 0.5 }])
    let now = 0
    const decisions = createDecisions({ oracle, config: { ...baseConfig(), hash: 'h1' }, clock: { iso: () => new Date(Date.UTC(2026, 8, 19, 12, 0, now++)).toISOString() } })
    const first = await decisions.ask({ dir, purpose: 'triage-pregate', subject: 'devpanel-project/issue-1', state: 'Issue text', questions: QUESTIONS })
    t.eq('the first ask calls the provider and records an answer', [oracle.calls.length, first.status, first.replayed], [1, 'answered', false])
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))
    t.eq('one record, named by purpose and key', [files.length, files[0].startsWith('triage-pregate-')], [1, true])
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, files[0]), 'utf8'))
    t.eq('the record on disk is what was returned', onDisk.decisions, first.decisions)
    t.eq('it keeps what was asked, about what, and the model that answered', [onDisk.state, onDisk.questions, onDisk.model, onDisk.requestedModel, onDisk.configHash], ['Issue text', QUESTIONS, 'jev-fake-1.0.0', 'jev-latest', 'h1'])
    t.ok('with cost from usage × price', Math.abs(onDisk.costUsd - 1000 * 0.042 / 1e6) < 1e-12)
    t.eq('the confident answer is what may be acted on', confidentAnswer(first, 'action')?.value, 'needs-input')
    t.eq('no temp files are left behind', (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp')), [])

    const fresh = createDecisions({ oracle, config: { ...baseConfig(), hash: 'h1' } })
    const again = await fresh.ask({ dir, purpose: 'triage-pregate', state: 'Issue text', questions: QUESTIONS })
    t.eq('a replay — even a new process — reads the record and does not call', [oracle.calls.length, again.replayed, again.decisions.action.value], [1, true, 'needs-input'])

    const reordered = Object.fromEntries(Object.entries(QUESTIONS).reverse())
    await fresh.ask({ dir, purpose: 'triage-pregate', state: 'Issue text', questions: reordered })
    t.eq('the same questions in another key order are the same ask', oracle.calls.length, 1)
    t.eq('canonical form sorts keys', canonical({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}')

    const changed = await fresh.ask({ dir, purpose: 'triage-pregate', state: 'Issue text, edited', questions: QUESTIONS })
    t.eq('a changed state is a new ask', [oracle.calls.length, changed.replayed], [2, false])
    t.eq('an answer below the threshold is recorded but not actionable', [changed.decisions.action.confident, confidentAnswer(changed, 'action')], [false, null])

    const raised = createDecisions({ oracle, config: { ...baseConfig(), threshold: 0.99 } })
    const reread = await raised.ask({ dir, purpose: 'triage-pregate', state: 'Issue text', questions: QUESTIONS })
    t.eq('raising the threshold later does not re-read a past decision', [reread.threshold, reread.decisions.action.confident], [0.9, true])

    const bad = await throwsWith(() => fresh.ask({ dir: 'relative/dir', purpose: 'x', state: 's', questions: QUESTIONS }))
    t.ok('a relative directory is refused', /absolute directory/.test(bad?.message ?? ''))
    const badPurpose = await throwsWith(() => fresh.ask({ dir, purpose: '../escape', state: 's', questions: QUESTIONS }))
    t.ok('a purpose that could escape the directory is refused', /purpose must be/.test(badPurpose?.message ?? ''))
  }

  t.section('10. concurrent asks of one question share one call; two processes agree on one record')
  {
    const dir = await temp()
    const oracle = fakeOracle([{ pick: { action: 'continue' }, delayMs: 20 }, { pick: { action: 'close-issue' } }])
    const decisions = createDecisions({ oracle, config: baseConfig() })
    const [a, b] = await Promise.all([1, 2].map(() => decisions.ask({ dir, purpose: 'p', state: 's', questions: QUESTIONS })))
    t.eq('one call for two concurrent asks', oracle.calls.length, 1)
    t.eq('both see the same decision', [a.decisions.action.value, b.decisions.action.value], ['continue', 'continue'])

    const dir2 = await temp()
    const racer = fakeOracle([{ pick: { action: 'continue' }, delayMs: 10 }, { pick: { action: 'close-issue' }, delayMs: 30 }])
    const [p1, p2] = [createDecisions({ oracle: racer, config: baseConfig() }), createDecisions({ oracle: racer, config: baseConfig() })]
    const [r1, r2] = await Promise.all([p1.ask({ dir: dir2, purpose: 'p', state: 's', questions: QUESTIONS }), p2.ask({ dir: dir2, purpose: 'p', state: 's', questions: QUESTIONS })])
    t.eq('two independent writers: the first record wins and the second adopts it', [r1.decisions.action.value, r2.decisions.action.value, r2.replayed], ['continue', 'continue', true])
    t.eq('exactly one record exists', (await fs.readdir(dir2)).length, 1)
  }

  t.section('11. unavailability is recorded too, so a replay takes the same fallback')
  {
    const dir = await temp()
    const oracle = fakeOracle([{ fail: { class: 'rate-limit', charged: 'no', message: 'HTTP 529' } }, { pick: { action: 'close-issue' } }])
    const decisions = createDecisions({ oracle, config: baseConfig() })
    const down = await decisions.ask({ dir, purpose: 'p', state: 's', questions: QUESTIONS })
    t.eq('a failure is recorded as unavailable, with its class', [down.status, down.failure.class, down.decisions], ['unavailable', 'rate-limit', null])
    t.eq('nothing in it is actionable', confidentAnswer(down, 'action'), null)
    const replay = await decisions.ask({ dir, purpose: 'p', state: 's', questions: QUESTIONS })
    t.eq('the replay does not ask again and falls back again', [oracle.calls.length, replay.status, replay.replayed], [1, 'unavailable', true])

    const boom = createDecisions({ oracle: { id: 'jev', model: 'm', ask: async () => { throw new Error('a bug') } }, config: baseConfig() })
    const threw = await throwsWith(() => boom.ask({ dir, purpose: 'bug', state: 's', questions: QUESTIONS }))
    t.ok('a programming error is thrown, not recorded as a provider outage', threw?.message === 'a bug' && !(threw instanceof DecisionError))
    t.eq('and leaves no record', (await fs.readdir(dir)).filter((f) => f.startsWith('bug-')).length, 0)
  }

  t.section('12. money: reserved before the call, settled at the real price, released only when certainly free')
  {
    const ledgerFile = path.join(await temp(), 'ledger.jsonl')
    const ledger = createLedger({ file: ledgerFile })
    await ledger.load()
    const refused = await throwsWith(() => ledger.reserve({ id: 'x', subject: 'decision' }))
    t.ok('the ledger refuses an unpriced decision', /per-call maxCostUsd/.test(refused?.message ?? ''))

    const dir = await temp()
    const oracle = fakeOracle([
      { pick: {} },
      { fail: { class: 'auth', charged: 'no' } },
      { fail: { class: 'timeout', charged: 'unknown' } },
      { fail: { class: 'contract-violation', charged: 'yes', usage: { input_tokens: 2000, output_tokens: 0 } } },
      { pick: {}, usage: null }
    ])
    const decisions = createDecisions({ oracle, config: baseConfig(), ledger })
    const answered = await decisions.ask({ dir, purpose: 'm', state: 'a', questions: QUESTIONS })
    const auth = await decisions.ask({ dir, purpose: 'm', state: 'b', questions: QUESTIONS })
    const timeout = await decisions.ask({ dir, purpose: 'm', state: 'c', questions: QUESTIONS })
    const violation = await decisions.ask({ dir, purpose: 'm', state: 'd', questions: QUESTIONS })
    const unpriced = await decisions.ask({ dir, purpose: 'm', state: 'e', questions: QUESTIONS })
    t.eq('what happened to each reservation is on its record', [answered, auth, timeout, violation, unpriced].map((r) => r.ledger.state), ['settled', 'released', 'outstanding', 'settled', 'settled'])

    const reopened = createLedger({ file: ledgerFile })
    await reopened.load()
    const day = reopened.usage().day
    t.eq('the window counts the four that were or may have been charged', day.decisions, 4)
    // 1000 tokens (42 micro-USD) + 2000 tokens (84) + the ceiling for the one without usage (10 000)
    // settled, and the timed-out one's ceiling (10 000) still reserved.
    t.eq('settled at usage × price, the ceiling where usage was not reported', day.settledUsdMicros, 42 + 84 + 10_000)
    t.eq('the uncertain one stays committed at its ceiling', [day.reservedUsdMicros, day.outstanding], [10_000, 1])
    t.eq('none of it is unpriced', [day.unpricedRuns, day.unpricedCalls], [0, 0])
    t.eq('cost helper: no usage is unknown, not zero', costOf(null, baseConfig().pricing), null)

    const blocked = fakeOracle([{ pick: {} }])
    const gated = createDecisions({ oracle: blocked, config: baseConfig(), ledger, admit: () => ({ ok: false, limit: 'daily.usd', detail: 'the daily allowance is spent' }) })
    const r = await gated.ask({ dir, purpose: 'm', state: 'f', questions: QUESTIONS })
    t.eq('a spending refusal is recorded as unavailable and the provider is never called', [r.status, r.failure.class, blocked.calls.length], ['unavailable', 'spending-refused', 0])
  }

  t.section('13. the key never reaches a record, through the real client end to end')
  {
    const h = await home()
    const dir = await temp()
    const f = fakeFetch([ok(), { status: 401, body: `bad key ${KEY}` }])
    const oracle = createJevOracle({ config: baseConfig(), fetch: f.fetch, home: h, root: CONFIG_ROOT })
    const decisions = createDecisions({ oracle, config: baseConfig() })
    await decisions.ask({ dir, purpose: 'k', state: 'one', questions: QUESTIONS })
    const denied = await decisions.ask({ dir, purpose: 'k', state: 'two', questions: QUESTIONS })
    t.eq('an auth refusal is recorded as unavailable', [denied.status, denied.failure.class], ['unavailable', 'auth'])
    let leaked = false
    for (const file of await fs.readdir(dir)) if ((await fs.readFile(path.join(dir, file), 'utf8')).includes(KEY)) leaked = true
    t.ok('no record contains the key', !leaked)
  }

  await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
}

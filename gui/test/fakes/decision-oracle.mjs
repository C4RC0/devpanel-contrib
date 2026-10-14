/*
 * Fakes for the decisions module. Nothing here reaches the network.
 *
 * `fakeOracle` stands in for a whole provider (createDecisions' view of it).
 * `fakeFetch` stands in for HTTP underneath the real Jev client, so the client's
 * own request building, retries, classification and scrubbing are what is tested.
 */
import { DecisionError } from '../../server/decisions/jev.mjs'

/** A well-formed answer to each question, choosing `pick[id]` (or the first option / level 0 / true). */
export function answersFor (questions, pick = {}, confidence = 0.95) {
  const answers = {}
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'noul') {
      answers[id] = { type: 'noul', noul: pick[id] ?? confidence }
      continue
    }
    const options = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i))
    const chosen = String(pick[id] ?? options[0])
    const rest = (1 - confidence) / Math.max(1, options.length - 1)
    const probabilities = Object.fromEntries(options.map((o) => [o, o === chosen ? confidence : rest]))
    answers[id] = q.type === 'choice'
      ? { type: 'choice', choice: chosen, probabilities, confidence }
      : { type: 'score', score: Number(chosen), legend: Object.fromEntries(options.map((o, i) => [o, String(q.criteria[i])])), probabilities, confidence }
  }
  return answers
}

/**
 * @param script  a list consumed one per ask: `{ pick, confidence }` to answer,
 *                or `{ fail: { class, charged, message } }` to throw a DecisionError
 */
export function fakeOracle (script = [], { model = 'jev-fake-1.0.0', usage = { input_tokens: 1000, output_tokens: 10 } } = {}) {
  const calls = []
  return {
    id: 'jev',
    model: 'jev-latest',
    calls,
    async ask ({ state, questions }) {
      calls.push({ state, questions })
      const step = script[calls.length - 1] ?? {}
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs))
      if (step.fail) {
        const f = step.fail
        throw new DecisionError(f.class, f.message ?? f.class, { charged: f.charged ?? 'unknown', status: f.status ?? null, usage: f.usage ?? null, attempts: 1 })
      }
      return { model, answers: answersFor(questions, step.pick, step.confidence), usage: step.usage === undefined ? usage : step.usage, attempts: 1, latencyMs: 5 }
    }
  }
}

/**
 * A fetch that replays `responses` in order and records every request.
 * Each response is `{ status, body, headers }` (body an object or a string), or
 * `{ throw: Error }` for a network failure, or `{ hang: true }` to wait for the
 * request's own abort signal.
 */
export function fakeFetch (responses) {
  const requests = []
  const fetch = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) })
    const r = responses[requests.length - 1]
    if (!r) throw new Error(`fakeFetch: no response scripted for request ${requests.length}`)
    if (r.throw) throw r.throw
    if (r.hang) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')), { once: true })
      })
    }
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})
    const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]))
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
      text: async () => text
    }
  }
  return { fetch, requests }
}

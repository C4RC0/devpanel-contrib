import os from 'node:os'

import { createHttpOracle, CONFIG_ROOT } from './http.mjs'

/*
 * The OpenAI Decisions API (public beta, developers.openai.com/api/docs/guides/decisions,
 * read 2026-10-07) as a decision provider: POST {endpoint} with
 * `{ model, input, questions }`. Transport, retries, timeout, credential and
 * error classes are shared with Jev (http.mjs); this file only translates.
 *
 * devpanel's question shape (questions.mjs) stays the contract, so the
 * translation is entirely here and is purely syntactic:
 *
 *   devpanel                                  OpenAI
 *   questions object keyed by id              questions array, id → name
 *   noul (criteria folded into instructions)  predicate; answer probability → noul
 *   choice criteria { option: description }   choices [{ value, description }];
 *                                             answer probabilities [{ value, probability }] → map by value
 *   score criteria [description | { what }]   levels [{ label: "<index>", description }];
 *                                             answer probabilities [{ value: index, … }] → map by String(index)
 *   state (string or JSON)                    input string (JSON-stringified when not a string)
 *
 * The translated answers then pass checkAnswers like Jev's, so an option never
 * offered, a distribution that does not sum to one (beyond its tolerance) or a
 * missing answer is a contract violation, never repaired.
 *
 * Usage: the guide shows no `usage` object. When a response carries none, the
 * ask still succeeds with `usage: null`; costOf() then prices it as null and the
 * ledger keeps the reserved maxCallCostUsd as an unpriced call, exactly as for
 * any provider that reports none. When it carries `input_tokens`, it is priced
 * from the configured pricing (input only; the API charges no output).
 *
 * Images are not sent: devpanel's state is text.
 */

const TYPE_OUT = { noul: 'predicate', choice: 'choice', score: 'score' }
const TYPE_IN = { predicate: 'noul', choice: 'choice', score: 'score' }

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isProbability = (v) => typeof v === 'number' && v >= 0 && v <= 1
// An own property whatever the name: `obj[name] = v` with a question id, option or
// answer name of "__proto__" would set the prototype instead, losing the entry.
const put = (obj, key, value) => Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })

/** A criterion as one line of text: a string as it is, `{ what, … }` as what plus the rest. */
function describe (value) {
  if (typeof value === 'string') return value
  if (isObject(value) && typeof value.what === 'string') {
    const { what, ...rest } = value
    return Object.keys(rest).length ? `${what} ${JSON.stringify(rest)}` : what
  }
  return JSON.stringify(value)
}

/** devpanel's questions object as the OpenAI questions array. */
export function toOpenAIQuestions (questions) {
  return Object.entries(questions).map(([name, q]) => {
    const out = { type: TYPE_OUT[q.type], name, instructions: q.instructions }
    if (q.type === 'noul') {
      // A predicate has no field for what true and false mean; it goes in the instructions.
      const sides = ['true', 'false'].filter((k) => q.criteria?.[k] !== undefined).map((k) => `${k === 'true' ? 'True' : 'False'} means: ${describe(q.criteria[k])}`)
      if (sides.length) out.instructions = `${q.instructions}\n\n${sides.join('\n')}`
    } else if (q.type === 'choice') {
      out.choices = Object.entries(q.criteria).map(([value, description]) => ({ value, description: describe(description) }))
    } else {
      out.levels = q.criteria.map((level, i) => ({ label: String(i), description: describe(level) }))
    }
    return out
  })
}

function distribution (where, list, key) {
  if (!Array.isArray(list)) return { violation: `${where}: probabilities must be an array` }
  const map = {}
  for (const p of list) {
    if (!isObject(p) || !isProbability(p.probability) || !['string', 'number'].includes(typeof p.value)) {
      return { violation: `${where}: each probability needs a value and a probability in 0..1` }
    }
    const k = key(p.value)
    if (Object.hasOwn(map, k)) return { violation: `${where}: "${k}" is listed twice` }
    put(map, k, p.probability)
  }
  return { map }
}

/**
 * The OpenAI response body as devpanel's answers object, or a violation when it
 * is not the documented shape. Every field is type-checked before it is used, so
 * an untrusted body can only end in a violation (a charged contract-violation),
 * never in a TypeError the recorder would treat as our bug. Which options and
 * levels are allowed is left to checkAnswers, which knows what was asked.
 */
export function fromOpenAIAnswers (parsed) {
  if (!isObject(parsed) || !Array.isArray(parsed.answers)) return { violation: 'the response does not match the documented shape: /answers must be an array' }
  const answers = {}
  for (const [i, a] of parsed.answers.entries()) {
    const where = `/answers/${i}`
    if (!isObject(a) || typeof a.name !== 'string' || !a.name) return { violation: `${where} needs a name` }
    if (typeof a.type !== 'string' || !Object.hasOwn(TYPE_IN, a.type)) return { violation: `${where}: type must be predicate, choice or score` }
    if (Object.hasOwn(answers, a.name)) return { violation: `${where}: "${a.name}" is answered twice` }
    if (a.type === 'predicate') {
      if (!isProbability(a.probability)) return { violation: `${where}: a predicate needs a probability in 0..1` }
      put(answers, a.name, { type: 'noul', noul: a.probability })
      continue
    }
    if (!isProbability(a.confidence)) return { violation: `${where}: a ${a.type} needs a confidence in 0..1` }
    const { map, violation } = distribution(where, a.probabilities, (v) => String(v))
    if (violation) return { violation }
    if (a.type === 'choice') {
      if (typeof a.choice !== 'string') return { violation: `${where}: a choice needs the chosen value` }
      put(answers, a.name, { type: 'choice', choice: a.choice, probabilities: map, confidence: a.confidence })
    } else {
      if (typeof a.score !== 'number') return { violation: `${where}: a score needs a numeric score` }
      put(answers, a.name, { type: 'score', score: a.score, probabilities: map, confidence: a.confidence })
    }
  }
  return { answers }
}

/**
 * @param config    a validated decisions/<id>.yaml with `kind: openai`
 * @param fetch     injected in tests; nothing in `npm test` may reach the network
 * @param sleep     injected in tests, so a retry costs no wall time
 */
export function createOpenAIOracle ({ config, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), env = process.env, home = os.homedir(), root = CONFIG_ROOT, now = () => Date.now() }) {
  return createHttpOracle({
    config, fetch, sleep, env, home, root, now,
    request: ({ stateText, questions }) => ({ model: config.model, input: stateText, questions: toOpenAIQuestions(questions) }),
    async read (parsed) {
      // The guide does not show the model echoed; the one asked for is the only one there is.
      const model = typeof parsed?.model === 'string' && parsed.model ? parsed.model : config.model
      // The usage shape is undocumented: only its numeric fields are kept, so
      // nothing downstream reads an untrusted value of another type.
      const usage = isObject(parsed?.usage) ? Object.fromEntries(Object.entries(parsed.usage).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) : null
      return { model, usage, ...fromOpenAIAnswers(parsed) }
    }
  })
}

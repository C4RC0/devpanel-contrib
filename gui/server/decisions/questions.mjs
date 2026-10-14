/*
 * Typed questions for an advisory decision provider, and what its answers mean.
 *
 * Three question types, as TypeSafe defines them (docs.typesafe.ai/primitives.md):
 *
 *   noul    yes/no; the answer is P(true) and carries no confidence of its own
 *   choice  one of up to 255 named options; a distribution and a confidence
 *   score   a rubric of ordered levels; a distribution, a weighted score and a
 *           confidence
 *
 * Questions are checked before they are sent, so a malformed one is our bug and
 * never a provider failure. Answers are UNTRUSTED input: each is checked against
 * the question that was actually asked — the option must be one we offered, the
 * distribution must cover exactly our options and sum to one — before anything is
 * derived from it. An answer that fails is a contract violation, never a guess.
 */

export const QUESTION_TYPES = ['noul', 'choice', 'score']
export const MAX_CHOICE_OPTIONS = 255
export const MAX_QUESTIONS = 32
const ID = /^[A-Za-z0-9_-]{1,64}$/
// Rounding in a provider's floats must not fail an answer; a distribution off by
// more than this is not a distribution.
const SUM_TOLERANCE = 0.01

export class QuestionError extends Error {
  constructor (message) { super(message); this.name = 'QuestionError' }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0

function describable (value) {
  if (nonEmptyString(value)) return true
  if (Array.isArray(value)) return value.length > 0 && value.every(describable)
  if (isObject(value)) return Object.keys(value).length > 0
  return false
}

/** Throws a QuestionError naming the first thing wrong; returns the questions otherwise. */
export function validateQuestions (questions) {
  if (!isObject(questions)) throw new QuestionError('questions must be an object keyed by question id')
  const ids = Object.keys(questions)
  if (!ids.length) throw new QuestionError('at least one question is required')
  if (ids.length > MAX_QUESTIONS) throw new QuestionError(`at most ${MAX_QUESTIONS} questions per ask; got ${ids.length}`)
  for (const id of ids) {
    const q = questions[id]
    const where = `question "${id}"`
    if (!ID.test(id)) throw new QuestionError(`${where}: an id is 1-64 letters, digits, "_" or "-"`)
    if (!isObject(q)) throw new QuestionError(`${where} must be an object`)
    if (!QUESTION_TYPES.includes(q.type)) throw new QuestionError(`${where}: type must be one of ${QUESTION_TYPES.join(', ')}`)
    // The id never reaches the model; the whole question has to be in the instructions.
    if (!nonEmptyString(q.instructions)) throw new QuestionError(`${where}: instructions are required and carry the whole question`)
    const extra = Object.keys(q).filter((k) => !['type', 'instructions', 'criteria'].includes(k))
    if (extra.length) throw new QuestionError(`${where}: unknown field(s) ${extra.join(', ')}`)
    if (q.type === 'noul') {
      if (q.criteria === undefined) continue
      if (!isObject(q.criteria) || !Object.keys(q.criteria).every((k) => k === 'true' || k === 'false') || !Object.values(q.criteria).every(describable)) {
        throw new QuestionError(`${where}: noul criteria, when given, describe only "true" and "false"`)
      }
    } else if (q.type === 'choice') {
      if (!isObject(q.criteria)) throw new QuestionError(`${where}: choice criteria map each option name to its description`)
      const options = Object.keys(q.criteria)
      if (options.length < 2) throw new QuestionError(`${where}: a choice needs at least 2 options`)
      if (options.length > MAX_CHOICE_OPTIONS) throw new QuestionError(`${where}: a choice accepts at most ${MAX_CHOICE_OPTIONS} options; got ${options.length}`)
      for (const option of options) {
        if (!option.trim()) throw new QuestionError(`${where}: an option name cannot be empty`)
        if (!describable(q.criteria[option])) throw new QuestionError(`${where}: option "${option}" needs a description`)
      }
    } else {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2) throw new QuestionError(`${where}: score criteria are an ordered array of at least 2 levels`)
      for (const [level, text] of q.criteria.entries()) {
        const ok = nonEmptyString(text) || (isObject(text) && nonEmptyString(text.what))
        if (!ok) throw new QuestionError(`${where}: level ${level} must be a description, or an object with "what"`)
      }
    }
  }
  return questions
}

const optionsOf = (q) => q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i))

function checkDistribution (where, probabilities, expected) {
  const keys = Object.keys(probabilities)
  const missing = expected.filter((k) => !Object.hasOwn(probabilities, k))
  const unknown = keys.filter((k) => !expected.includes(k))
  if (missing.length || unknown.length) {
    return `${where}: probabilities must cover exactly the options asked` +
      (missing.length ? `; missing ${missing.join(', ')}` : '') + (unknown.length ? `; never offered ${unknown.join(', ')}` : '')
  }
  const sum = Object.values(probabilities).reduce((a, b) => a + b, 0)
  if (Math.abs(sum - 1) > SUM_TOLERANCE) return `${where}: probabilities sum to ${sum}, not 1`
  return null
}

/**
 * Every asked question answered once, with the type asked, inside the options
 * offered. Returns a list of violations; empty means the answers can be used.
 * The response shape itself is checked by the JSON Schema before this runs.
 */
export function checkAnswers (questions, answers) {
  const errors = []
  for (const id of Object.keys(answers ?? {})) {
    if (!Object.hasOwn(questions, id)) errors.push(`answer "${id}" is for a question that was not asked`)
  }
  for (const [id, q] of Object.entries(questions)) {
    const a = answers?.[id]
    const where = `answer "${id}"`
    if (!a) { errors.push(`${where} is missing`); continue }
    if (a.type !== q.type) { errors.push(`${where} is a ${a.type}, but a ${q.type} was asked`); continue }
    if (q.type === 'noul') continue
    const expected = optionsOf(q)
    const bad = checkDistribution(where, a.probabilities, expected)
    if (bad) { errors.push(bad); continue }
    if (q.type === 'choice') {
      if (!expected.includes(a.choice)) { errors.push(`${where}: "${a.choice}" is not one of the options offered`); continue }
      const top = Math.max(...Object.values(a.probabilities))
      if (a.probabilities[a.choice] < top - 1e-9) errors.push(`${where}: "${a.choice}" is not the most probable option`)
    } else if (!(a.score >= 0 && a.score <= expected.length - 1)) {
      errors.push(`${where}: score ${a.score} is outside 0..${expected.length - 1}`)
    }
  }
  return errors
}

/**
 * What a checked answer means, and whether it may be acted on.
 *
 * `value` is what the caller acts on: a boolean for a noul, the option name for a
 * choice, and the most probable LEVEL (an integer) for a score — a weighted score
 * of 1.4 is a summary, not a level anyone defined. The weighted score is kept
 * beside it.
 *
 * A noul carries no confidence from the provider. Its confidence here is derived
 * as max(p, 1 - p), the probability of the side it is read as, and says so with
 * `confidenceSource: 'derived'`.
 */
export function interpret (question, answer, threshold) {
  let value, confidence, confidenceSource = 'provider', extra = {}
  if (question.type === 'noul') {
    value = answer.noul >= 0.5
    confidence = Math.max(answer.noul, 1 - answer.noul)
    confidenceSource = 'derived'
    extra = { probability: answer.noul }
  } else if (question.type === 'choice') {
    value = answer.choice
    confidence = answer.confidence
    extra = { probabilities: answer.probabilities }
  } else {
    const levels = Object.entries(answer.probabilities).map(([k, p]) => [Number(k), p])
    value = levels.reduce((best, cur) => cur[1] > best[1] ? cur : best)[0]
    confidence = answer.confidence
    extra = { score: answer.score, probabilities: answer.probabilities }
  }
  return { type: question.type, value, confidence, confidenceSource, threshold, confident: confidence >= threshold, ...extra }
}

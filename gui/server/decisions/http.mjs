import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateQuestions, checkAnswers, QuestionError } from './questions.mjs'

/*
 * What every HTTP decision provider shares (jev.mjs, openai.mjs): one POST per
 * ask with a Bearer key, every question of the ask in that one request.
 *
 * Plain `fetch`, not a provider SDK: this client has to own its retries (so
 * every attempt is counted and none is silent), its timeout, and what an error
 * says — an SDK error message is not ours to scrub of a credential.
 *
 * The key is read from `credentialRef` at EVERY call, so adding or rotating it
 * needs no restart, and it exists only in the Authorization header of the
 * request. It is never returned, logged, recorded, or kept in an error: every
 * message leaving this file has had the key's value replaced.
 *
 * Failures are classified, and each says whether the provider could have charged
 * for it, which is what the spending ledger needs to know:
 *
 *   configuration       no key, bad reference                    — nothing sent
 *   invalid-question    our question or state is malformed       — nothing sent
 *   auth                401 / 403                                — refused, not charged
 *   invalid-request     400 / 404 / 422                          — refused, not charged
 *   rate-limit          429 / 529, after bounded retries         — refused, not charged
 *   transient           5xx or a network error, after retries    — charge unknown
 *   timeout             no response within timeoutMs             — charge unknown
 *   contract-violation  a response we cannot use                 — charged
 *   cancelled           the caller's signal fired                — charge unknown
 *
 * What differs per provider is only the request body and how its response
 * becomes devpanel's answers (`request` and `read` below).
 */

export class DecisionError extends Error {
  constructor (cls, message, { status = null, charged = 'unknown', retryAfterMs = null, attempts = 0, usage = null, model = null } = {}) {
    super(message)
    this.name = 'DecisionError'
    this.class = cls
    this.status = status
    this.charged = charged
    this.retryAfterMs = retryAfterMs
    this.attempts = attempts
    this.usage = usage
    this.model = model
  }
}

export const CONFIG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** env:NAME or file:PATH, read now. `~/` is the service user's home; anything else is relative to the config root. */
export async function readCredential (ref, { env = process.env, home = os.homedir(), root = CONFIG_ROOT } = {}) {
  const at = ref?.indexOf(':') ?? -1
  if (at < 0) throw new DecisionError('configuration', 'credentialRef must be env:NAME or file:PATH', { charged: 'no' })
  const kind = ref.slice(0, at)
  const name = ref.slice(at + 1)
  let value = null
  if (kind === 'env') value = env[name] ?? null
  else if (kind === 'file') {
    const file = name.startsWith('~/') ? path.join(home, name.slice(2)) : path.resolve(root, name)
    try { value = await fs.readFile(file, 'utf8') } catch (error) {
      throw new DecisionError('configuration', `credential ${ref} is not readable (${error.code ?? 'error'})`, { charged: 'no' })
    }
  } else throw new DecisionError('configuration', `unsupported credential reference type "${kind}"`, { charged: 'no' })
  value = value?.trim() ?? ''
  if (!value) throw new DecisionError('configuration', `credential ${ref} is empty or not set`, { charged: 'no' })
  return value
}

/** retry-after in seconds or as an HTTP date; null when absent or unreadable. */
export function retryAfterMs (header, now = Date.now()) {
  if (header == null || header === '') return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - now) : null
}

const classifyStatus = (status) => {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429 || status === 529) return 'rate-limit'
  if (status >= 500) return 'transient'
  return 'invalid-request'
}

/**
 * An oracle `{ id, model, ask }` over one HTTP endpoint.
 *
 * @param request   ({ state, stateText, questions }) => the JSON body to send
 * @param read      async (parsed) => { model, answers } in devpanel's shape, or
 *                  { model, violation } when the body is not the documented shape;
 *                  may add `usage` to replace the body's own
 * @param fetch     injected in tests; nothing in `npm test` may reach the network
 * @param sleep     injected in tests, so a retry costs no wall time
 */
export function createHttpOracle ({ config, request, read, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), env = process.env, home = os.homedir(), root = CONFIG_ROOT, now = () => Date.now() }) {
  const retries = config.retries ?? 2
  const timeoutMs = config.timeoutMs ?? 10000
  const maxWaitMs = config.maxWaitMs ?? 5000
  const maxStateChars = config.maxStateChars ?? 100000

  return {
    id: config.id,
    model: config.model,

    /**
     * One ask. Resolves `{ model, answers, usage, attempts, latencyMs }` with
     * answers already checked against the questions; rejects with a DecisionError.
     */
    async ask ({ state, questions, signal = null }) {
      try { validateQuestions(questions) } catch (error) {
        if (error instanceof QuestionError) throw new DecisionError('invalid-question', error.message, { charged: 'no' })
        throw error
      }
      const stateText = typeof state === 'string' ? state : JSON.stringify(state ?? null)
      if (state == null || stateText === '' || stateText === 'null') throw new DecisionError('invalid-question', 'state is required', { charged: 'no' })
      if (stateText.length > maxStateChars) throw new DecisionError('invalid-question', `state is ${stateText.length} characters; the limit is ${maxStateChars}`, { charged: 'no' })

      const key = await readCredential(config.credentialRef, { env, home, root })
      const scrub = (text) => String(text ?? '').split(key).join('[credential]')
      const body = JSON.stringify(request({ state, stateText, questions }))

      let attempts = 0
      let last = null
      const started = now()
      while (true) {
        if (signal?.aborted) throw new DecisionError('cancelled', 'the ask was cancelled', { attempts })
        attempts++
        // A referenced timer, not AbortSignal.timeout(): that one is unref'd, and a
        // CLI waiting on nothing else would exit mid-request instead of timing out.
        const timeout = new AbortController()
        const timer = setTimeout(() => timeout.abort(new Error('timeout')), timeoutMs)
        let response
        let text = ''
        try {
          response = await fetch(config.endpoint, {
            method: 'POST',
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
            body,
            signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
          })
        } catch (error) {
          if (signal?.aborted) throw new DecisionError('cancelled', 'the ask was cancelled', { attempts })
          clearTimeout(timer)
          last = timeout.signal.aborted
            ? new DecisionError('timeout', `no response within ${timeoutMs} ms`, { attempts })
            : new DecisionError('transient', `network error: ${scrub(error.cause?.code ?? error.message)}`, { attempts })
        }

        if (response) {
          // The body is read under the same timer: a stalled body is a timeout too.
          text = await response.text().catch(() => '').finally(() => clearTimeout(timer))
          if (timeout.signal.aborted && !signal?.aborted) {
            last = new DecisionError('timeout', `the response body did not arrive within ${timeoutMs} ms`, { status: response.status, attempts })
            response = null
          }
        }
        if (signal?.aborted) throw new DecisionError('cancelled', 'the ask was cancelled', { attempts })

        if (response) {
          if (response.ok) {
            let parsed
            try { parsed = JSON.parse(text) } catch {
              throw new DecisionError('contract-violation', 'the response body is not JSON', { status: response.status, charged: 'yes', attempts })
            }
            const reading = await read(parsed)
            const { model = null, answers, violation } = reading
            // A provider may hand back its own reading of usage; otherwise the body's, as it is.
            const usage = reading.usage !== undefined ? reading.usage : (parsed?.usage && typeof parsed.usage === 'object' ? parsed.usage : null)
            if (violation) {
              throw new DecisionError('contract-violation', scrub(violation), { status: response.status, charged: 'yes', attempts, usage, model })
            }
            const violations = checkAnswers(questions, answers)
            if (violations.length) {
              throw new DecisionError('contract-violation', scrub(violations.join('; ')), { status: response.status, charged: 'yes', attempts, usage, model })
            }
            return { model, answers, usage, attempts, latencyMs: now() - started }
          }
          const cls = classifyStatus(response.status)
          const wait = retryAfterMs(response.headers?.get?.('retry-after'), now())
          last = new DecisionError(cls, `HTTP ${response.status}: ${scrub(text).slice(0, 300)}`, {
            status: response.status,
            // A status code is the provider refusing the request. A 5xx could have
            // failed after the work was done, so only that stays unknown.
            charged: cls === 'transient' ? 'unknown' : 'no',
            retryAfterMs: wait,
            attempts
          })
        }

        const retryable = ['rate-limit', 'transient', 'timeout'].includes(last.class)
        if (!retryable || attempts > retries) throw last
        const backoff = Math.min(maxWaitMs, 500 * 2 ** (attempts - 1))
        const wait = last.retryAfterMs ?? backoff
        // A provider asking for a longer wait than a decision is worth gets its
        // answer now: the caller falls back instead of stalling.
        if (wait > maxWaitMs) throw last
        await sleep(wait)
      }
    }
  }
}

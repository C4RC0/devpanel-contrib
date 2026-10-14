import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'

import { createHttpOracle, CONFIG_ROOT } from './http.mjs'

export { DecisionError, readCredential, retryAfterMs } from './http.mjs'

/*
 * TypeSafe Jev over plain HTTP: POST {endpoint} with `{ model, state, questions }`,
 * where `questions` is devpanel's own object keyed by question id. Jev's answers
 * are already devpanel's shape, so the only work here is checking the body
 * against the documented schema. Transport, retries, timeout, credential and
 * error classes are shared with every HTTP provider (http.mjs).
 */

const SCHEMA_ROOT = CONFIG_ROOT
const validators = new Map()

async function responseValidator (root) {
  if (!validators.has(root)) {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    const schema = JSON.parse(await fs.readFile(path.join(root, 'schemas', 'jev-response.schema.json'), 'utf8'))
    validators.set(root, ajv.compile(schema))
  }
  return validators.get(root)
}

/**
 * @param config    a validated decisions/<id>.yaml
 * @param fetch     injected in tests; nothing in `npm test` may reach the network
 * @param sleep     injected in tests, so a retry costs no wall time
 */
export function createJevOracle ({ config, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), env = process.env, home = os.homedir(), root = SCHEMA_ROOT, now = () => Date.now() }) {
  return createHttpOracle({
    config, fetch, sleep, env, home, root, now,
    request: ({ state, questions }) => ({ model: config.model, state, questions }),
    async read (parsed) {
      const validate = await responseValidator(root)
      const model = typeof parsed?.model === 'string' ? parsed.model : null
      if (!validate(parsed)) {
        const detail = validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')
        return { model, violation: `the response does not match the documented shape: ${detail}` }
      }
      return { model, answers: parsed.answers }
    }
  })
}

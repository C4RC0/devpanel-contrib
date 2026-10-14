/*
 * Live check of the Jev decision provider: ONE request, retries off, three
 * questions whose answers are not in doubt.
 *
 *   npm run live -- --jev --plan
 *   DEVPANEL_LIVE=1 npm run live -- --jev
 *
 * It passes when the key is accepted and the response satisfies the contract —
 * the documented shape, every question answered inside the options offered. Whether
 * the answers are the obvious ones is reported beside that, not folded into it:
 * a single wrong answer is a statement about one question, not about access.
 * The record is written to a temp directory and copied into the report; nothing
 * touches issues/.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { loadDecisionProvider, createDecisions } from '../server/decisions/index.mjs'
import { createJevOracle } from '../server/decisions/jev.mjs'
import { oracleFor } from '../server/decisions/advisor.mjs'
import { triageRequest } from '../server/decisions/triage-shadow.mjs'
import { WAKE_QUESTIONS, summariseEvent } from '../server/decisions/wake-filter.mjs'
import { FAILURE_QUESTIONS } from '../server/decisions/failure-advisor.mjs'

const STATE = [
  'Paris is the capital and largest city of France.',
  'At sea level, pure water boils at 100 degrees Celsius.',
  'Bug report: the service crashes on every start, and nobody can log in. There is no workaround.'
].join('\n')

const QUESTIONS = {
  capital: { type: 'choice', instructions: 'According to the text, which city is the capital of France?', criteria: { paris: 'Paris', lyon: 'Lyon', marseille: 'Marseille' } },
  boiling: { type: 'noul', instructions: 'Does the text state that pure water boils at 100 degrees Celsius at sea level?' },
  severity: { type: 'score', instructions: 'How severe is the bug report in the text?', criteria: ['Cosmetic; no impact to functionality', 'Broken or degraded feature, but a workaround exists', 'Blocking; no workaround exists'] }
}
const EXPECTED = { capital: 'paris', boiling: true, severity: 2 }

export const plan = [
  '1. load decisions/jev.yaml and read the key from its credentialRef   (free)',
  '2. ONE request with three questions (a choice, a noul, a score); retries off',
  '3. check the response against the documented shape and the questions asked'
]

/**
 * The same single-request check for any provider file, through the client its
 * `kind` declares (openai-decisions-check.mjs uses it for decisions/openai.yaml).
 * The provider is named, not taken from decisions/active.yaml, so a provider
 * can be checked before it is made active.
 */
export async function runJevCheck ({ log, providerId = 'jev', flag = '--jev' }) {
  const config = await loadDecisionProvider({ id: providerId })
  if (!config) throw new Error(`decisions/${providerId}.yaml is not present`)
  // Exactly one request: the invocation cap is the only limit enforceable before a call.
  const oracle = oracleFor({ ...config, retries: 0 })
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `devpanel-live-${providerId}-`))
  try {
    const decisions = createDecisions({ oracle, config })
    const record = await decisions.ask({ dir, purpose: 'live-check', subject: `npm run live -- ${flag}`, state: STATE, questions: QUESTIONS })
    const answered = record.status === 'answered'
    log('key accepted and contract satisfied', answered ? 'pass' : 'fail', { detail: answered ? `${record.model}, ${record.latencyMs} ms` : `${record.failure.class}: ${record.failure.message}` })
    const expected = {}
    if (answered) {
      for (const [id, want] of Object.entries(EXPECTED)) {
        const d = record.decisions[id]
        expected[id] = { expected: want, got: d.value, confidence: Number(d.confidence.toFixed(4)), confident: d.confident, matches: d.value === want }
        log(`${id}: ${JSON.stringify(d.value)} at ${d.confidence.toFixed(3)}`, d.value === want ? 'pass' : 'inconclusive', { detail: d.value === want ? '' : `expected ${JSON.stringify(want)}` })
      }
    }
    return { passed: answered, record, expected, config: { id: config.id, kind: config.kind, model: config.model, endpoint: config.endpoint, threshold: config.threshold, hash: config.hash } }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/*
 * The integration check: the questions each rollout phase really asks, sent to
 * the real provider once each (three requests, retries off). The inputs are
 * written samples with an answer nobody would dispute, labelled as samples; the
 * question sets are imported from the modules that ask them in production, so a
 * change to those questions is what this checks.
 *
 *   DEVPANEL_LIVE=1 npm run live -- --jev-integration
 */
/** An in-memory issue with the shape issues.js returns: a sample, never a panel issue. */
function sampleIssues () {
  const report = 'After Tuesday\'s deploy, every login on the customer portal fails with HTTP 500. The server log shows "TypeError: cannot read properties of undefined (reading \'session\')" in auth/login.js line 88. All customers are locked out; there is no workaround.'
  const issue = { id: '2026-09-19-sample-login-500', name: 'Customer portal login returns 500 for everyone since the deploy', kind: 'bug', openedOn: '2026-09-19', priority: null, steps: [{ number: '001', slug: 'report', files: [{ name: 'note.md', directory: false }] }] }
  const other = { id: '2026-09-02-sample-dark-mode', name: 'Add a dark mode toggle to the settings page', openedOn: '2026-09-02', archived: false, status: 'open' }
  return {
    getIssue: async () => issue,
    listIssues: async (_project, { archived = false } = {}) => (archived ? [] : [issue, other]),
    readStepFile: async () => ({ bytes: Buffer.from(report) })
  }
}

export const integrationPlan = [
  '1. load decisions/jev.yaml and read the key from its credentialRef   (free)',
  '2. triage pre-gate questions on a sample report of a total login outage   (one request)',
  '3. wake-filter question on a sample "run moved to running" event          (one request)',
  '4. failure question on a sample dropped-connection error                   (one request)',
  '   retries off; each response is checked against the documented shape and the questions asked'
]

export async function runJevIntegrationCheck ({ log }) {
  const config = await loadDecisionProvider({ id: 'jev' })
  if (!config) throw new Error('decisions/jev.yaml is not present')
  const oracle = createJevOracle({ config: { ...config, retries: 0 } })
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-live-jev-integration-'))
  const pregate = await triageRequest({ issues: sampleIssues(), project: 'sample-project', issueId: '2026-09-19-sample-login-500' })
  const cases = [
    { phase: 'pregate', purpose: 'triage-pregate', state: pregate.state, questions: pregate.questions, expected: { gate: 'continue', priority: 'urgent', duplicateOf: 'none' } },
    {
      phase: 'wake-filter', purpose: 'wake-filter', questions: WAKE_QUESTIONS, expected: { wake: 'defer' },
      state: { mission: 'Work through the open issues of sample-project in priority order and report when they are resolved.', event: summariseEvent({ type: 'run-changed', run: { runId: 'sample-run', issue: { project: 'sample-project', id: 'sample-issue' }, playbook: { id: 'implementation' }, status: 'running', outcome: null } }) }
    },
    {
      phase: 'failure', purpose: 'failure-reclass', questions: FAILURE_QUESTIONS, expected: { class: 'transient' },
      state: { invocationId: 'sample-invocation', harness: 'claude', model: 'sample-model', message: 'claude exited with code 1', output: 'API Error: stream disconnected before completion: error decoding response body\nRequest was aborted by the peer after 214 s' }
    }
  ]
  const results = []
  try {
    const decisions = createDecisions({ oracle, config })
    for (const c of cases) {
      const record = await decisions.ask({ dir, purpose: c.purpose, subject: `npm run live -- --jev-integration (${c.phase})`, state: c.state, questions: c.questions })
      const answered = record.status === 'answered'
      log(`${c.phase}: key accepted and contract satisfied`, answered ? 'pass' : 'fail', { detail: answered ? `${record.model}, ${record.latencyMs} ms, ${record.usage?.input_tokens} input tokens` : `${record.failure.class}: ${record.failure.message}` })
      const expected = {}
      if (answered) {
        for (const [id, want] of Object.entries(c.expected)) {
          const d = record.decisions[id]
          expected[id] = { expected: want, got: d.value, confidence: Number(d.confidence.toFixed(4)), confident: d.confident, matches: d.value === want }
          log(`  ${id}: ${JSON.stringify(d.value)} at ${d.confidence.toFixed(3)}${d.confident ? '' : ' (below threshold)'}`, d.value === want ? 'pass' : 'inconclusive', { detail: d.value === want ? '' : `expected ${JSON.stringify(want)}` })
        }
      }
      results.push({ phase: c.phase, passed: answered, record, expected })
    }
    const costUsd = results.reduce((sum, r) => sum + (r.record.costUsd ?? 0), 0)
    return { passed: results.every((r) => r.passed), results, costUsd, config: { id: config.id, model: config.model, endpoint: config.endpoint, threshold: config.threshold, hash: config.hash } }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

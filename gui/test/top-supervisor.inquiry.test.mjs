import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTopSupervisor } from '../server/top-supervisor.mjs'

export const name = 'top-level supervisor — inquire binds a preview to the new inquiry, as analysis, with the flag frozen'

const wait = async (test) => { const end = Date.now() + 4000; while (!test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-supervisor-inquiry-'))
  const invocations = []
  const starts = []
  const inquiries = []
  const events = []
  let script = []
  const models = async () => [{ id: 'test-model', title: 'Test model', model: 'wire-model', defaultEffort: 'high', verification: { status: 'verified' } }]
  const adapter = { invoke: async (args) => {
    invocations.push(args)
    const event = JSON.parse(args.prompt).event
    events.push(event)
    const action = script.shift()?.(event) ?? null
    return { session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action }), usage: { costUsd: 0.01 } }
  } }
  const tools = {
    projects: async () => [{ id: 'one-project' }], playbooks: async () => [], seatModels: async () => [],
    infrastructure: async () => null, listIssues: async () => [], getIssue: async () => ({ name: 'x' }),
    preview: async () => ({ ok: true, configHash: 'plain-hash' }),
    inquire: async (a) => { inquiries.push(a); return { ok: true, configHash: 'inquiry-hash', inquiryId: '2026-09-30-inquiry-why' } },
    inquiryStatus: async (a) => ({ inquiryId: a.inquiryId, row: 4, state: 'answered' }),
    start: async (p) => { starts.push(p); return { runId: 'r1', status: 'running' } },
    getRun: async () => ({ status: 'completed' }), stop: async () => {}
  }
  const agent = await createTopSupervisor({ dir, models, adapter, tools, pollMs: 20 })
  try {
    script = [
      () => ({ type: 'inquire', project: 'one-project', question: 'Why does the export fail?', runOptions: { participants: { analyser: { model: 'test-model', effort: 'high' } } } }),
      (e) => ({ type: 'start_run', project: 'one-project', issueId: e.result.inquiryId, previewId: e.result.previewId }),
      () => ({ type: 'inquire', project: 'one-project', question: 'q', runOptions: { intent: 'research' } }),
      () => ({ type: 'preview', project: 'one-project', issueId: 'x', playbook: 'analysis', runOptions: { inquiry: true } }),
      () => ({ type: 'get_inquiry', project: 'one-project', inquiryId: '2026-09-30-inquiry-why' })
    ]
    await agent.start({ model: 'test-model', projects: ['one-project'], message: 'Answer a question', limits: { maxCalls: 20, maxRuns: 2, maxConcurrent: 1, maxStartsPerIssue: 1 } })
    await wait(() => invocations.length >= 6)
    t.eq('inquire created one inquiry with the question', inquiries.map((a) => a.question), ['Why does the export fail?'])
    t.eq('its runOptions carry the flag, set by the engine', inquiries[0].runOptions, { participants: { analyser: { model: 'test-model', effort: 'high' } }, inquiry: true })
    t.eq('start_run started exactly that preview', starts.map((p) => [p.issueId, p.playbook, p.configHash, p.runOptions.inquiry]), [['2026-09-30-inquiry-why', 'analysis', 'inquiry-hash', true]])
    const refusals = events.map((e) => e?.result?.error).filter(Boolean)
    t.ok('runOptions beyond participants are refused', refusals.some((m) => /seat models and efforts only/.test(m)), JSON.stringify(refusals))
    t.ok('a preview cannot set the inquiry flag', refusals.some((m) => /opened with inquire/.test(m)), JSON.stringify(refusals))
    t.ok('get_inquiry reads the state', events.some((e) => e?.result?.state === 'answered'))
    t.ok('the charter names inquiries', /becomes an INQUIRY/.test(invocations[0].instructions ?? invocations[0].prompt ?? ''))
  } finally {
    await agent.stop().catch(() => {})
    await agent.shutdown?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

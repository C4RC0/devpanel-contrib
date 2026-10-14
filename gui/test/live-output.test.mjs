import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { readLive } from '../server/runtime/store.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'
import { startStage } from './browser/stage.mjs'

export const name = 'live output — every byte the runtime writes, persisted first, then forwarded'

const NL = String.fromCharCode(10)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const AGENT = path.join(HERE, 'fakes/cli/agent.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until (predicate, { timeout = 20000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(80)
  }
}

export default async function (t) {
  // ------------------------------------------------------------ engine
  t.section('1. the engine records what the runtime wrote and emits it after the write')
  {
    const f = await engineFixture()
    const events = []
    const engine = await startRun({
      playbookId: f.playbookId,
      issue: { project: 'devpanel-project', id: f.issue.id },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
      workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock,
      deliveryProvider: f.delivery,
      emit: (e) => events.push(e)
    })
    await engine.drive({ maxTurns: 2 })

    const live = events.filter((e) => e.type === 'live')
    t.ok('live events were emitted', live.length > 0, `${live.length}`)
    const first = engine.run.steps[0]
    const mine = live.filter((e) => e.invocationId === first.invocationId)
    t.ok('they name the invocation, role and step', mine.every((e) => e.role === first.role && e.stepId === first.stepId))
    t.eq('sequence numbers are contiguous from 1', mine.map((e) => e.entry.seq).join(','), mine.map((_, i) => i + 1).join(','))
    t.eq('the first entry is the spawn marker', mine[0].entry.kind, 'spawn')
    t.ok('the spawn marker carries the command line and where it ran',
      typeof mine[0].entry.command === 'string' && mine[0].entry.command.length > 0 && Array.isArray(mine[0].entry.args) && Boolean(mine[0].entry.cwd),
      JSON.stringify({ command: mine[0].entry.command, args: mine[0].entry.args?.length, cwd: mine[0].entry.cwd }))
    t.ok('stdout and stderr are both there', mine.some((e) => e.entry.kind === 'stdout') && mine.some((e) => e.entry.kind === 'stderr'))
    t.eq('the last entry is the exit marker', mine.at(-1).entry.kind, 'exit')

    const stored = await readLive(f.issuePath, engine.runId, first.invocationId)
    t.eq('the file holds exactly what was emitted', JSON.stringify(stored), JSON.stringify(mine.map((e) => e.entry)))
    const after = await readLive(f.issuePath, engine.runId, first.invocationId, { after: stored.length - 1 })
    t.eq('reading after a sequence number returns only the rest', after.length, 1)
    t.ok('the log lives in run metadata, not the step folder', await fs.stat(path.join(f.issuePath, 'runs', engine.runId, 'live')).then((s) => s.isDirectory()))
    t.eq('the step folder still holds only response.md', await f.filesIn((await f.stepFolders())[0]), ['response.md'])
    await releaseWorkspace(engine)
  }

  t.section('1b. a capped log still forwards the cap marker and the exit marker')
  {
    const { appendLive } = await import('../server/runtime/store.mjs')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-cap-'))
    const sizes = new Map()
    const opts = { maxBytes: 300 }
    const forwarded = []
    const put = async (entry) => { const w = await appendLive(dir, 'r', 'inv', entry, sizes, opts); if (w.entry) forwarded.push(w.entry); return w }
    await put({ seq: 1, at: 't', kind: 'spawn', text: 'process 1 started' })
    const first = await put({ seq: 2, at: 't', kind: 'stdout', text: 'x'.repeat(60) })
    t.eq('output under the cap is kept', first.kept, true)
    const over = await put({ seq: 3, at: 't', kind: 'stdout', text: 'y'.repeat(200) })
    t.eq('the chunk that crosses the cap is not kept', over.kept, false)
    t.eq('but the marker that replaced it is forwarded', over.entry?.kind, 'truncated')
    const dropped = await put({ seq: 4, at: 't', kind: 'stdout', text: 'z' })
    t.eq('later output is dropped', dropped.entry, null)
    const exit = await put({ seq: 5, at: 't', kind: 'exit', text: 'invocation completed' })
    t.eq('the exit marker is still persisted and forwarded', exit.entry?.kind, 'exit')
    const stored = await readLive(dir, 'r', 'inv')
    t.eq('the file holds spawn, output, cap marker, exit', stored.map((x) => x.kind).join(','), 'spawn,stdout,truncated,exit')
    t.eq('forwarded matches stored', forwarded.map((x) => x.kind).join(','), 'spawn,stdout,truncated,exit')
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('1c. a process buffer keeps the tail and reports truncation honestly')
  {
    const { runProcess } = await import('../server/runtime/process.mjs')
    const script = 'for (let i = 0; i < 2000; i++) process.stdout.write("line " + i + " " + "p".repeat(40) + "\\n"); process.stdout.write(JSON.stringify({ type: "result", result: "final" }) + "\\n")'
    const seen = []
    const r = await runProcess({ command: process.execPath, args: ['-e', script], maxBuffer: 4096, observe: { onOutput: (s, c) => { if (s === 'stdout') seen.push(c) } } })
    t.eq('truncation is reported', r.truncated, true)
    t.ok('the retained buffer is capped', r.stdout.length <= 4096, `${r.stdout.length}`)
    t.ok('and holds the END of the stream', r.stdout.trimEnd().endsWith('"result":"final"}'))
    t.ok('the observer saw everything', seen.join('').includes('line 0 ') && seen.join('').includes('line 1999 '))
  }

  // ------------------------------------------------------------ real adapters
  t.section('2. the claude adapter forwards raw chunks from both streams')
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-adapter-'))
    const file = path.join(dir, 'cli')
    await fs.writeFile(file, ['#!/bin/sh', "export AGENT_MODE='ok'", "export AGENT_SHAPE='claude'", 'echo "a warning" 1>&2', `exec "${process.execPath}" "${AGENT}" "$@"`].join(NL) + NL)
    await fs.chmod(file, 0o755)
    process.env.DEVPANEL_CLAUDE_BIN = file
    const claude = await import('../../harness/claude.mjs')
    const chunks = []
    let spawned = null
    await claude.invoke({
      model: 'm', cwd: dir, prompt: 'Do the `handoff` thing.', ledgerDir: null,
      observe: { onOutput: (stream, chunk) => chunks.push({ stream, chunk }), onSpawn: (s) => { spawned = s } }
    })
    t.ok('spawn reported with a pid', Number.isInteger(spawned?.pid))
    t.ok('stderr forwarded', chunks.some((c) => c.stream === 'stderr' && c.chunk.includes('a warning')))
    const stdout = chunks.filter((c) => c.stream === 'stdout').map((c) => c.chunk).join('')
    t.ok('stdout forwarded byte for byte, including the result line', stdout.includes('"type":"result"'))
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('2b. the final result survives a stdout buffer that could not hold the transcript')
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-verbose-'))
    const file = path.join(dir, 'cli')
    // A runtime that writes far more than the buffer keeps before its result.
    const noisy = path.join(dir, 'noisy.mjs')
    await fs.writeFile(noisy, [
      'import fs from "node:fs"',
      'const NL = String.fromCharCode(10)',
      'if (process.argv.includes("--version")) { process.stdout.write("9" + NL); process.exit(0) }',
      'fs.readFileSync(0, "utf8")',
      'for (let i = 0; i < 20000; i++) process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "chatter " + i + " " + "c".repeat(200) }] } }) + NL)',
      'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "the answer", session_id: "s1", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.1 }) + NL)'
    ].join(NL) + NL)
    await fs.writeFile(file, ['#!/bin/sh', `exec "${process.execPath}" "${noisy}" "$@"`].join(NL) + NL)
    await fs.chmod(file, 0o755)
    process.env.DEVPANEL_CLAUDE_BIN = file
    // Force a tiny retained buffer for the adapter's process call.
    const { runProcess } = await import('../server/runtime/process.mjs')
    const claude = await import('../../harness/claude.mjs?verbose=1')
    const turn = await claude.invoke({ model: 'm', cwd: dir, prompt: 'x', ledgerDir: null, maxBuffer: 8192 })
    t.eq('the result was captured', turn.response, 'the answer')
    t.eq('with its session', turn.session.id, 's1')
    void runProcess
    await fs.rm(dir, { recursive: true, force: true })
  }

  // ------------------------------------------------------------ API
  t.section('3. the API serves the recorded output and lets a client catch up')
  {
    const stage = await startStage({ control: { delayMs: 0, delayFor: { implement: 4000 } } })
    const issue = await stage.createIssue('Live output over the API')
    const started = await stage.request(`/api/projects/${stage.project}/issues/${issue.id}/runs`, {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    t.eq('started', started.status, 201)

    // The implement turn is slow, so it is caught in flight.
    const inflight = await until(async () => {
      const run = await stage.run(issue.id, started.body.runId)
      return run.active.find((a) => a.stepId === 'implement') ? run : null
    }, { label: 'the implement turn in flight' })
    const active = inflight.active.find((a) => a.stepId === 'implement')

    const page = await stage.request(`/api/projects/${stage.project}/issues/${issue.id}/runs/${started.body.runId}/live/${active.invocationId}`)
    t.eq('served', page.status, 200)
    t.eq('marked live while the turn is in flight', page.body.live, true)
    t.ok('with the output written so far', page.body.entries.length > 0, `${page.body.entries.length}`)
    t.ok('including a parseable runtime event line', page.body.entries.some((e) => e.kind === 'stdout' && e.text.includes('tool_use')))

    const rest = await stage.request(`/api/projects/${stage.project}/issues/${issue.id}/runs/${started.body.runId}/live/${active.invocationId}?after=${page.body.next}`)
    t.eq('nothing new after the last sequence', rest.body.entries.length, 0)
    t.eq('and next stays put', rest.body.next, page.body.next)

    const settled = await until(async () => {
      const [run] = await stage.runs(issue.id)
      return run && !['preflighting', 'pending', 'running', 'stopping'].includes(run.status) ? run : null
    }, { label: 'the run to settle', timeout: 40000 })
    t.eq('the run completed', settled.status, 'completed')

    const done = await stage.request(`/api/projects/${stage.project}/issues/${issue.id}/runs/${started.body.runId}/live/${active.invocationId}`)
    t.eq('no longer live once recorded', done.body.live, false)
    t.eq('the transcript ends with the exit marker', done.body.entries.at(-1).kind, 'exit')

    const missing = await stage.request(`/api/projects/${stage.project}/issues/${issue.id}/runs/no-such-run/live/x`)
    t.eq('an unknown run is 404', missing.status, 404)
    await stage.stop()
  }

  await cleanupFixtures()
}

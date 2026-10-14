import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveProjectPath } from '../server/project-path.mjs'
import { exportProject } from '../server/runtime/selection.mjs'
import { ensureMountPoint, resolveMounts } from '../server/runtime/tooling-mounts.mjs'
import { ISOLATION_INHERITED, ISOLATION_UNAVAILABLE, OFFLINE, renderToolingCommand } from '../server/runtime/tooling-commands.mjs'
import { calls } from './read-fence-check.mjs'

/*
 * Can a seat run the project's own tooling (workspace.tooling in
 * projects/<id>.yaml) inside the fence, offline, with the mounts read-only?
 *
 * ONE invocation, as a read-only reviewer, in an export of the project's
 * checkout (its ls-files selection, as a run's worktree is) with the project's
 * mounts bound in. The turn is asked to run the offline wrapper alone first
 * (is network isolation available in this runtime, and is it the wrapper's own
 * namespace or the runtime's proved denial?), then a network probe WITHOUT the
 * wrapper (what the seat's own sandbox allows: `seatNetwork`), then each
 * declared command in the engine's rendered form with its placeholders filled,
 * then the same probe through the wrapper, both against a listener this
 * process holds on 127.0.0.1. Every verdict is read from the runtime's own tool-call record and
 * the filesystem, never from the model's prose: a provisional path is
 * confirmed, refuted, or `not-run` (isolation unavailable), and the report says
 * which.
 */

const NL = String.fromCharCode(10)
const PANEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Placeholders a declared command leaves for the seat, filled for this check. */
async function fill (command, worktree) {
  let run = command.run
  if (run.includes('<suite>')) run = run.replaceAll('<suite>', 'config.schemas')
  if (run.includes('<files>')) {
    const listed = await fs.readdir(worktree, { recursive: true }).catch(() => [])
    const files = listed.filter((f) => /\.m?js$/.test(f) && !f.split('/').some((p) => p === 'node_modules' || p.startsWith('.'))).sort().slice(0, 2)
    if (!files.length) return { ...command, run: null, why: 'no .js/.mjs file in the export to check' }
    run = run.replaceAll('<files>', files.join(' '))
  }
  if (run.includes('<name>')) {
    const dir = path.join(worktree, path.dirname(run.match(/(\S*)<name>/)?.[1] ?? ''))
    const prefix = path.basename(run.match(/(\S*)<name>/)?.[1] ?? '')
    const found = (await fs.readdir(dir).catch(() => [])).filter((f) => f.startsWith(prefix) && f.endsWith('.mjs')).sort()
    if (!found.length) return { ...command, run: null, why: `no ${prefix}*.mjs in ${path.relative(worktree, dir) || '.'} of the export` }
    run = run.replace(/(\S*)<name>(\.mjs)?/, (m, head) => path.join(path.dirname(head), found[0]))
  }
  return { ...command, run }
}

/**
 * One POSIX shell word decoded ('…', "…" with its four escapes, backslash), or
 * null when the text is not exactly one word.
 */
function shellWord (text) {
  let out = '', i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) return null
    if (ch === "'") { const end = text.indexOf("'", i + 1); if (end < 0) return null; out += text.slice(i + 1, end); i = end + 1 } else if (ch === '"') {
      i++
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\' && '"\\$`'.includes(text[i + 1] ?? '')) i++; out += text[i++] }
      if (text[i] !== '"') return null
      i++
    } else if (ch === '\\') { out += text[i + 1] ?? ''; i += 2 } else { out += ch; i++ }
  }
  return out
}

/**
 * What a runtime record says was EXECUTED: the command itself, or the one
 * argument of a shell wrapper the runtime adds (Codex records `bash -lc '<cmd>'`).
 * Anything else, a command printed or quoted inside another, is not execution.
 */
export function executed (command) {
  const trimmed = command.trim()
  const wrapped = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(.+)$/s.exec(trimmed)
  return [trimmed, ...(wrapped && shellWord(wrapped[1]) !== null ? [shellWord(wrapped[1])] : [])]
}

/**
 * `config` and `projectPath` default to the panel's configuration and the
 * project's checkout; tests pass their own (the evaluator needs no paid turn).
 */
export async function runToolingCheck ({ adapter, harnessId, model, root, projectId, ledgerDir, reserve = () => {}, log = () => {}, ledger, config = null, projectPath = null }) {
  const result = { harness: harnessId, model, project: projectId, stages: [], paths: [], isolation: null, isolationMode: null, seatNetwork: null }
  const stage = (name, status, detail = {}) => { result.stages.push({ name, status, ...detail }); log(name, status, detail) }
  const verdict = (entry) => { result.paths.push(entry); stage(`${entry.kind} ${entry.id}`, entry.verdict === 'confirmed' ? 'pass' : entry.verdict === 'refuted' ? 'fail' : 'inconclusive', { detail: entry.detail }) }

  const project = (config ?? await (await import('../server/config/load.mjs')).loadConfig()).projects.get(projectId)
  const tooling = project?.workspace?.tooling ?? {}
  if (!tooling.mounts?.length && !tooling.commands?.length) { stage('the project declares tooling', 'fail', { detail: `projects/${projectId}.yaml has no workspace.tooling mounts or commands` }); return result }
  if (harnessId === 'gemini') {
    // Nothing is spent: a gemini seat has no shell in a run (gemini.mjs, the
    // non-writer has none; a writer loses it whenever a read-only root exists).
    stage('not run: gemini seats have no shell', 'inconclusive', { detail: 'harness/gemini.mjs: a non-writing seat has no shell; a writer is denied it whenever a read-only root (always: the run\'s evidence) exists. The mounts are readable by its file tools; the commands cannot be run.' })
    return result
  }

  const probed = await adapter.probe({ depth: 'installation' })
  result.cliVersion = probed.installation.version
  if (probed.installation.status !== 'installed') { stage('installation', 'fail', { detail: probed.installation.detail }); return result }
  stage('installation', 'pass', { version: probed.installation.version })

  const checkout = projectPath ?? await resolveProjectPath(projectId)
  const { mounts, errors } = await resolveMounts(tooling.mounts ?? [], { projectPath: checkout })
  // A source the configuration rejects is never bound: refused before any fence or turn (auditor-1-007).
  for (const e of errors) verdict({ kind: 'mount', id: tooling.mounts[e.index].target, source: tooling.mounts[e.index].source, provisional: Boolean(tooling.mounts[e.index].provisional), verdict: 'refuted', detail: e.message })
  if (errors.length) return result
  const missing = mounts.filter((m) => m.missing)
  for (const m of missing) verdict({ kind: 'mount', id: m.target, source: m.source, provisional: Boolean(m.provisional), verdict: 'refuted', detail: `${m.source} does not exist: a run's seat turns would be refused` })
  if (missing.length) return result

  const worktree = path.join(root, 'worktree'), scratch = path.join(root, 'scratch')
  await fs.mkdir(scratch, { recursive: true })
  await exportProject({ projectPath: checkout, target: worktree })
  const fenceMounts = []
  for (const m of mounts) fenceMounts.push({ source: m.sourceReal, target: await ensureMountPoint(worktree, m.target) })

  // The network probe's listener: reachable from the fence (it shares the
  // host's network), never from inside the offline wrapper.
  // A runtime that may not listen leaves the probe without a target: recorded, never passed.
  const server = net.createServer((socket) => socket.end())
  const listening = await new Promise((resolve) => { server.once('error', () => resolve(false)); server.listen(0, '127.0.0.1', () => resolve(true)) })
  const port = listening ? server.address().port : 9
  const probe = { id: 'offline-probe', run: `node -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>{console.log('NETWORK-REACHED');process.exit(0)}).on('error',(e)=>{console.log('NETWORK-REFUSED',e.code);process.exit(0)})"` }

  const commands = []
  for (const c of tooling.commands ?? []) {
    const filled = await fill(c, worktree)
    if (!filled.run) verdict({ kind: 'command', id: c.id, provisional: Boolean(c.provisional), verdict: 'refuted', detail: filled.why })
    else commands.push({ ...filled, line: renderToolingCommand(filled, worktree) })
  }
  const isolationLine = `${OFFLINE} /bin/true`
  const probeLine = renderToolingCommand(probe, worktree)
  // The same probe in the seat's own shell: what the runtime's sandbox itself allows.
  const seatLine = probe.run
  const prompt = [
    'This is a tooling check. Run each command below with your shell, one at a time, EXACTLY as written (do not change, wrap or',
    'retry them another way), even when an earlier one fails. Do not ask for confirmation. Then report each one\'s output.',
    `1. ${isolationLine}`,
    `2. ${seatLine}`,
    ...commands.map((c, i) => `${i + 3}. ${c.line}`),
    `${commands.length + 3}. ${probeLine}`
  ].join(NL)

  let stdout = ''
  let turn
  try {
    reserve()
    turn = await adapter.invoke({
      model, cwd: worktree, scratchDir: scratch, ledgerDir, prompt, hygiene: true, marker: `devpanel:tooling:${Date.now()}`,
      tooling: { writesCode: false, allowLiveCheckout: false, liveCheckout: null, allowedRoots: [scratch], networkAccess: false, mountTargets: fenceMounts.map((m) => m.target) },
      fence: { cwd: worktree, writable: [scratch], readOnly: [worktree], entries: [], panelRoot: PANEL, mounts: fenceMounts, toolingBin: path.join(PANEL, 'harness', 'tooling') },
      observe: { onOutput: (stream, chunk) => { if (stream === 'stdout') stdout += String(chunk) } },
      meta: { invocationId: 'live-tooling', role: 'auditor' }
    })
    ledger?.record({ stage: 'tooling', outcome: 'completed', session: turn.session?.id ?? null, usage: turn.usage })
    stage('turn completed', 'pass', { session: turn.session?.id ?? null })
  } catch (error) {
    ledger?.record({ stage: 'tooling', outcome: 'failed', error: error.message, usage: null })
    stage('turn completed', 'fail', { detail: [error.message, error.stderr].filter(Boolean).join(' — ').slice(0, 400) })
    server.close()
    return result
  }
  server.close()
  result.response = turn.response ?? null

  const fence = turn.diagnostics?.fence
  stage('the turn ran inside a proved fence with the mounts', fence?.namespace === 1 && (fence.mounts?.tooling?.length ?? 0) === mounts.length ? 'pass' : 'fail', { detail: JSON.stringify(fence?.mounts ?? fence) })
  // The fence proof saw each source's sentinel through its mount.
  for (const m of mounts) verdict({ kind: 'mount', id: m.target, source: m.source, provisional: Boolean(m.provisional), verdict: fence?.namespace === 1 ? 'confirmed' : 'refuted', detail: fence?.namespace === 1 ? `mounted read-only from ${m.sourceReal}, proved before launch` : `fence: ${fence?.reason ?? 'not applied'}` })

  const record = calls(harnessId, stdout)
  result.calls = record.map((c) => ({ ...c, output: c.output.slice(-2000) }))
  // Matched on the decoded shell command, never its JSON encoding (auditor-1-006).
  // The executed command must BE the rendered line, not contain it (auditor-1-006, -009).
  const callFor = (line) => record.find((c) => c.command !== null && executed(c.command).includes(line)) ?? null
  const unavailable = (c) => c.output.includes(ISOLATION_UNAVAILABLE)
  // Only the Prettier launcher may exit 1 and still have run (it lists unformatted files).
  // (harness/tooling/prettier-check.mjs, or a locally kept alias of it: prettier-<name>.mjs).
  const formatter = (c) => /^node \/run\/devpanel\/tooling\/prettier-[\w.-]+\.mjs\s/.test(c.run.trim())
  const iso = callFor(isolationLine)
  const inherited = (c) => c.output.includes(ISOLATION_INHERITED)
  result.isolation = !iso ? 'not-attempted' : unavailable(iso) ? 'unavailable' : iso.exitCode === 0 ? 'available' : 'unavailable'
  // namespace: the wrapper's own; inherited: the runtime's seccomp denial, proved by the wrapper before it ran anything.
  if (result.isolation === 'available') result.isolationMode = inherited(iso) ? 'inherited' : 'namespace'
  stage('network isolation is available in this runtime', result.isolation === 'available' ? 'pass' : 'inconclusive', { detail: iso ? (iso.output.slice(-400) || `exit ${iso.exitCode}, ${result.isolationMode ?? 'no'} isolation`) : 'the probe was not run' })

  // A measurement, not a requirement: Claude's fence shares the host's network, Codex's sandbox may refuse it.
  const bare = callFor(seatLine)
  const refused = bare && /NETWORK-REFUSED (\S+)/.exec(bare.output)
  result.seatNetwork = !listening ? 'no-listener' : !bare ? 'not-attempted' : bare.output.includes('NETWORK-REACHED') ? 'network-reached' : refused ? `refused ${refused[1]}` : 'unclear'
  log('the seat\'s own shell (no wrapper)', 'measured', { detail: `${result.seatNetwork}${bare ? `: ${bare.output.trim().slice(-200)}` : ''}` })

  for (const c of commands) {
    const call = callFor(c.line)
    const entry = { kind: 'command', id: c.id, provisional: Boolean(c.provisional), line: c.line, exitCode: call?.exitCode ?? null, output: call?.output.slice(-1200) ?? null }
    if (!call) verdict({ ...entry, verdict: 'not-run', detail: 'the turn did not run it as written' })
    else if (unavailable(call)) verdict({ ...entry, verdict: 'not-run', detail: 'isolation unavailable: the wrapper refused to run it (exit 125)' })
    // Under the runtime's denial loopback is refused too: a command that listens on it fails for that reason, said so.
    else if (call.exitCode !== 0 && inherited(call) && !formatter(c)) verdict({ ...entry, verdict: 'refuted', detail: `exit ${call.exitCode ?? 'not recorded'} under the runtime's own network denial (loopback refused too): ${call.output.trim().split(NL).slice(-3).join(' | ').slice(0, 400)}` })
    // Confirmed only on the runtime's own exit status 0 (auditor-1-005); a
    // formatter that ran and listed unformatted files exits 1 and has still run.
    else if (call.exitCode === 0 || (formatter(c) && call.exitCode === 1 && / are not formatted with /.test(call.output))) verdict({ ...entry, verdict: 'confirmed', detail: call.output.trim().split(NL).slice(-1)[0] ?? '' })
    else verdict({ ...entry, verdict: 'refuted', detail: `exit ${call.exitCode ?? 'not recorded'}: ${call.output.trim().split(NL).slice(-3).join(' | ').slice(0, 400)}` })
  }
  const reached = callFor(probeLine)
  result.offline = !listening ? 'no-listener' : !reached ? 'not-attempted' : reached.output.includes('NETWORK-REACHED') ? 'network-reached' : unavailable(reached) ? 'not-run' : reached.output.includes('NETWORK-REFUSED') ? 'no-network' : 'unclear'
  stage('a declared command has no network', result.offline === 'network-reached' ? 'fail' : result.offline === 'no-network' ? 'pass' : 'inconclusive', { detail: reached?.output.slice(-200) ?? 'the probe was not run' })

  const written = []
  for (const m of fenceMounts) if ((await fs.readdir(m.target).catch(() => [])).length) written.push(path.relative(worktree, m.target))
  stage('the mounts stayed read-only (host targets empty)', written.length ? 'fail' : 'pass', { detail: written.join(', ') })
  return result
}

/** Passed: nothing refuted and nothing failed. Not-run paths keep it inconclusive, reported as such. */
export const toolingPassed = (result) => result.stages.length > 0 && result.stages.every((s) => s.status === 'pass')

export function describeTooling (result) {
  const failed = result.stages.filter((s) => s.status === 'fail')
  const open = result.stages.filter((s) => s.status === 'inconclusive')
  if (failed.length) return `TOOLING NOT PROVED: ${failed.map((s) => `${s.name}${s.detail ? ` (${s.detail})` : ''}`).join('; ')}`
  if (open.length) return `INCONCLUSIVE${result.isolation === 'unavailable' ? ' (network isolation is unavailable in this runtime, so its declared commands are not run)' : ''}: ${open.map((s) => `${s.name}${s.detail ? ` (${s.detail})` : ''}`).join('; ')}`
  return `the project's tooling ran inside the fence, offline (${result.isolationMode === 'inherited' ? 'the runtime\'s own proved network denial' : 'the wrapper\'s network namespace'}), with read-only mounts (${result.project}); the seat's own shell: ${result.seatNetwork}`
}

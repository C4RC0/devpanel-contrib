import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/*
 * Does a hygiene seat (fence.hygiene: 1) still work, against the real CLI?
 *
 * The offline suite proves what the adapter hands the runtime: an allow-listed
 * environment, stated setting sources, a named tool set, no connectors. Whether
 * the RUNTIME then still loads the repository's own instructions (CLAUDE.md for
 * Claude, AGENTS.md for Codex), still runs the shell without the operator's
 * permission rules, and still lets the writer edit, is a claim about somebody
 * else's software. Two turns per harness settle it: a writer and a reviewer.
 *
 * The verdict is read from the runtime's own event stream (its init record, its
 * tool calls and their results) and from the filesystem, never from the model's
 * account of what it did. The canary is unguessable, so the answer repeating it
 * is evidence the instruction file was in the model's context.
 */

const NL = String.fromCharCode(10)
const EDIT_FILE = 'hygiene-edit.txt'

function prompt (writer) {
  return [
    'This is a short configuration check. Do exactly this, in order:',
    '1. Find the line in your project instructions that starts with HYGIENE-CANARY and quote it exactly.',
    '2. Use your shell tool to run: pwd',
    writer ? `3. Create the file ${EDIT_FILE} in the current directory containing the single word EDITED.` : '3. Do not change any file.',
    'Then reply in two lines: the canary line, and the output of pwd.'
  ].join(NL)
}

/** Every regular file under a directory (links and empty directories are not content). */
async function regularFiles (root, rel = '', out = {}) {
  for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    const name = path.join(rel, entry.name)
    if (entry.isDirectory()) await regularFiles(root, name, out)
    else if (entry.isFile()) out[name] = await fs.readFile(path.join(root, name), 'utf8')
    else out[name] = null
  }
  return out
}

/** Every JSON event in the captured stdout, in order. */
function events (stdout) {
  const out = []
  for (const line of stdout.split(NL)) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try { out.push(JSON.parse(t)) } catch { /* progress noise */ }
  }
  return out
}

/** What the runtime itself recorded: its init record and the shell calls it ran. */
function observed (harnessId, stdout) {
  const all = events(stdout)
  if (harnessId === 'claude') {
    const init = all.find((e) => e.type === 'system' && e.subtype === 'init') ?? null
    const uses = new Map()
    const shell = []
    for (const e of all) {
      for (const block of e.message?.content ?? []) {
        if (e.type === 'assistant' && block.type === 'tool_use') uses.set(block.id, block)
        if (e.type === 'user' && block.type === 'tool_result') {
          const use = uses.get(block.tool_use_id)
          if (use?.name === 'Bash') {
            const text = typeof block.content === 'string' ? block.content : (block.content ?? []).map((c) => c.text ?? '').join('')
            shell.push({ command: use.input?.command ?? '', ok: block.is_error !== true, output: text.slice(0, 300) })
          }
        }
      }
    }
    return { init: init && { tools: init.tools, mcp: init.mcp_servers, permissionMode: init.permissionMode }, shell }
  }
  const shell = all.filter((e) => e.type === 'item.completed' && e.item?.type === 'command_execution')
    .map((e) => ({ command: String(e.item.command ?? ''), ok: e.item.exit_code === 0, output: String(e.item.aggregated_output ?? '').slice(0, 300) }))
  return { init: null, shell }
}

export async function runHygieneCheck ({ adapter, harnessId, model, root, ledgerDir, reserve = () => {}, log = () => {}, ledger, workerTools = null }) {
  const result = { harness: harnessId, model, stages: [], turns: [] }
  const stage = (name, status, detail = {}) => { result.stages.push({ name, status, ...detail }); log(name, status, detail); return status }

  const probed = await adapter.probe({ depth: 'installation' })
  result.cliVersion = probed.installation.version
  if (probed.installation.status !== 'installed') { stage('installation', 'fail', { detail: probed.installation.detail }); return result }
  stage('installation', 'pass', { version: probed.installation.version })

  const instructionFile = harnessId === 'claude' ? 'CLAUDE.md' : harnessId === 'codex' ? 'AGENTS.md' : 'GEMINI.md'
  for (const writer of [true, false]) {
    const seat = writer ? 'writer' : 'reviewer'
    const dir = path.join(root, seat)
    const cwd = path.join(dir, 'worktree'), scratchDir = path.join(dir, 'scratch'), evidence = path.join(dir, 'evidence')
    for (const d of [cwd, scratchDir, evidence]) await fs.mkdir(d, { recursive: true })
    const canary = `HYGIENE-CANARY-${crypto.randomBytes(8).toString('hex')}`
    await fs.writeFile(path.join(cwd, instructionFile), `# Project instructions${NL}${NL}${canary}${NL}`, 'utf8')
    await fs.writeFile(path.join(cwd, 'source.txt'), `candidate${NL}`, 'utf8')

    let stdout = ''
    const marker = `devpanel:hygiene:${seat}:${Date.now()}`
    let turn
    try {
      reserve()
      turn = await adapter.invoke({
        model, cwd, scratchDir, ledgerDir, prompt: prompt(writer), marker, hygiene: true,
        // Exactly what the engine passes a seat: the evidence root read-only,
        // scratch writable, no live checkout; the network as for infrastructure.
        tooling: { writesCode: writer, allowLiveCheckout: false, liveCheckout: null, allowedRoots: [evidence, scratchDir], networkAccess: true },
        observe: { onOutput: (stream, chunk) => { if (stream === 'stdout') stdout += String(chunk) } },
        meta: { invocationId: `live-hygiene-${seat}`, role: writer ? 'implementer' : 'auditor-1' }
      })
      ledger?.record({ stage: `hygiene-${seat}`, outcome: 'completed', session: turn.session?.id ?? null, usage: turn.usage, marker })
      stage(`${seat}: turn completed`, 'pass', { session: turn.session?.id ?? null })
    } catch (error) {
      ledger?.record({ stage: `hygiene-${seat}`, outcome: 'failed', error: error.message, usage: null, marker })
      stage(`${seat}: turn completed`, 'fail', { detail: [error.message, error.stderr].filter(Boolean).join(' — ').slice(0, 400) })
      continue
    }

    const seen = observed(harnessId, stdout)
    result.turns.push({ seat, response: turn.response, observed: seen, diagnostics: turn.diagnostics })
    stage(`${seat}: ${instructionFile} was in context (canary repeated)`, (turn.response ?? '').includes(canary) ? 'pass' : 'fail',
      { detail: (turn.response ?? '').includes(canary) ? null : `response: ${JSON.stringify((turn.response ?? '').slice(0, 200))}` })
    const pwd = seen.shell.filter((s) => /\bpwd\b/.test(s.command))
    stage(`${seat}: the shell ran (runtime record)`, !pwd.length ? 'inconclusive' : pwd.some((s) => s.ok) ? 'pass' : 'fail',
      { detail: pwd.length ? pwd.map((s) => `${s.ok ? 'ok' : 'refused'}: ${s.output.slice(0, 120)}`).join('; ') : 'no pwd call in the runtime record' })
    if (harnessId === 'claude') {
      const init = seen.init
      stage(`${seat}: permission mode is the stated one`, init?.permissionMode === 'acceptEdits' ? 'pass' : 'fail', { detail: `permissionMode: ${init?.permissionMode}` })
      stage(`${seat}: no MCP servers or connectors`, Array.isArray(init?.mcp) && init.mcp.length === 0 ? 'pass' : 'fail', { detail: JSON.stringify(init?.mcp ?? null).slice(0, 200) })
      const extra = (init?.tools ?? []).filter((tool) => !(workerTools ?? []).includes(tool))
      stage(`${seat}: only the named tools`, init && !extra.length ? 'pass' : 'fail', { detail: extra.length ? `unexpected: ${extra.join(', ')}` : (init?.tools ?? []).join(', ') })
    }
    if (writer) {
      const edited = await fs.readFile(path.join(cwd, EDIT_FILE), 'utf8').catch(() => null)
      stage('writer: the edit landed in the worktree', edited?.trim() === 'EDITED' ? 'pass' : 'fail', { detail: edited === null ? `${EDIT_FILE} missing` : JSON.stringify(edited.slice(0, 40)) })
    } else {
      // Files, as the fingerprint counts them: the CLI leaves an EMPTY
      // `.claude/.cc-writes/` staging directory in every working directory it
      // runs in, with or without hygiene (observed on 2.1.284), and an empty
      // directory is not part of the candidate.
      const files = await regularFiles(cwd)
      const expected = { [instructionFile]: `# Project instructions${NL}${NL}${canary}${NL}`, 'source.txt': `candidate${NL}` }
      const same = JSON.stringify(Object.keys(files).sort()) === JSON.stringify(Object.keys(expected).sort()) &&
        Object.entries(expected).every(([f, text]) => files[f] === text)
      stage('reviewer: the worktree is unchanged', same ? 'pass' : 'fail', { detail: Object.keys(files).sort().join(', ') })
    }
  }
  return result
}

export const hygienePassed = (result) => result.stages.length > 0 && result.stages.every((s) => s.status === 'pass')

export function describeHygiene (result) {
  const failed = result.stages.filter((s) => s.status === 'fail')
  const open = result.stages.filter((s) => s.status === 'inconclusive')
  if (failed.length) return `HYGIENE BREAKS THE SEAT: ${failed.map((s) => `${s.name}${s.detail ? ` (${s.detail})` : ''}`).join('; ')}`
  if (open.length) return `INCONCLUSIVE: ${open.map((s) => `${s.name} (${s.detail})`).join('; ')}`
  return 'hygiene seats work: instructions load, the shell runs, the writer edits, the reviewer does not'
}

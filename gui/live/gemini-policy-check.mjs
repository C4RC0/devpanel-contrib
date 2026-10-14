import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveCommand } from '../server/runtime/command.mjs'
import { buildPolicy } from '../../harness/gemini.mjs'
import { liveReportsDir } from '../server/config/host-config.mjs'

/*
 * Local, free verification using the INSTALLED CLI's TOML parser and policy
 * engine. Never imported by the offline suite unless a runtime is injected.
 * Gemini removes statically denied tools from its registry, so asking a model
 * to call those tools cannot reliably exercise the policy.
 *
 * Two things are established, each against the engine that will decide at run
 * time rather than against this repository's model of it:
 *
 *   auditor  — a non-writing seat: write, shell and mode-transition tools are
 *              excluded from the registry and forced calls are denied at the
 *              admin tier above a permissive control. Its hash is what the live
 *              fence turn must have acknowledged (`boundToTurn`).
 *   writer   — a writing seat with read-only roots: every spelling of a path
 *              into a root is denied, including the ones the root rule cannot
 *              name (`.`, `..`, empty segments, a NUL, a relative spelling of a
 *              root inside the worktree), the worktree and scratch stay writable
 *              — also beneath a root that contains them — and the shell is gone.
 *              No live turn exercises this; the decisions are the engine's own,
 *              on the exact policy the adapter generates. These rules are what
 *              the model is TOLD; what keeps the roots unchanged is the read-only
 *              mount the adapter proves before launch (`gemini.test.mjs` 2g
 *              exercises that mount with a shell inside it).
 */

const NL = String.fromCharCode(10)

/** Writer configurations and what the engine must decide for each. */
const WRITER_CASES = [
  {
    name: 'evidence root beside the worktree',
    options: { writesCode: true, readOnlyRoots: ['/run/audit/evidence'] },
    expect: [
      ['write_file', { file_path: '/run/audit/evidence/x', content: '' }, 'deny'],
      ['replace', { file_path: '/run/audit/evidence/x', old_string: 'a', new_string: 'b' }, 'deny'],
      ['write_file', { file_path: '/run/audit/./evidence/x', content: '' }, 'deny'],
      ['write_file', { file_path: '/run//audit/evidence/x', content: '' }, 'deny'],
      ['write_file', { file_path: '//run/audit/evidence/x', content: '' }, 'deny'],
      ['write_file', { file_path: '/run/audit/evidence/.', content: '' }, 'deny'],
      ['write_file', { file_path: '/run/wt/../audit/evidence/x', content: '' }, 'deny'],
      ['write_file', { file_path: '../audit/evidence/x', content: '' }, 'deny'],
      ['replace', { file_path: '/run/audit/./evidence/x', old_string: 'a', new_string: 'b' }, 'deny'],
      ['write_file', { file_path: '/run/wt/src/a.js', content: '' }, 'allow'],
      ['write_file', { file_path: 'src/a.js', content: '' }, 'allow'],
      ['write_file', { file_path: '/run/wt/.env', content: '' }, 'allow'],
      ['write_file', { file_path: '/run/audit/evidence-copy/x', content: '' }, 'allow'],
      ['run_shell_command', { command: 'ls' }, 'deny'],
      ['read_file', { file_path: '/run/audit/evidence/x' }, 'allow']
    ]
  },
  {
    name: 'a root above the worktree and scratch',
    options: { writesCode: true, readOnlyRoots: ['/run'], carveOuts: ['/run/scratch/author', '/run/wt'] },
    expect: [
      ['write_file', { file_path: '/run/evidence/x', content: '' }, 'deny'],
      ['write_file', { file_path: '/run/x', content: '' }, 'deny'],
      ['write_file', { file_path: '/run/scratch/auditor/x', content: '' }, 'deny'],
      ['write_file', { file_path: '/run/scratch/author-2/x', content: '' }, 'deny'],
      ['write_file', { file_path: '/run/scratch/author/notes.md', content: '' }, 'allow'],
      ['write_file', { file_path: '/run/wt/src/a.js', content: '' }, 'allow'],
      ['replace', { file_path: '/run/wt/src/a.js', old_string: 'a', new_string: 'b' }, 'allow'],
      ['write_file', { file_path: '/run/scratch/author/../../evidence/x', content: '' }, 'deny'],
      ['write_file', { file_path: '/run/scratch/author/./x', content: '' }, 'deny'],
      ['write_file', { file_path: '/run//wt/x', content: '' }, 'deny'],
      ['run_shell_command', { command: 'ls' }, 'deny']
    ]
  },
  {
    // The adapter names such a root by its relative spelling as well, since the
    // working directory is the worktree; the runtime strips NUL characters
    // before resolving a path, so a NUL anywhere is refused too.
    name: 'a root inside the worktree',
    options: { writesCode: true, readOnlyRoots: ['/run/wt/vendor', 'vendor'], carveOuts: ['/run/wt'] },
    expect: [
      ['write_file', { file_path: '/run/wt/vendor/x', content: '' }, 'deny'],
      ['write_file', { file_path: 'vendor/x', content: '' }, 'deny'],
      ['write_file', { file_path: 'vendor', content: '' }, 'deny'],
      ['write_file', { file_path: `/run/wt/ven${String.fromCharCode(0)}dor/x`, content: '' }, 'deny'],
      ['replace', { file_path: `ven${String.fromCharCode(0)}dor/x`, old_string: 'a', new_string: 'b' }, 'deny'],
      ['write_file', { file_path: 'vendored/x', content: '' }, 'allow'],
      ['write_file', { file_path: '/run/wt/src/x', content: '' }, 'allow']
    ]
  }
]

async function installedRuntime () {
  const binary = await fs.realpath(resolveCommand('gemini', process.env.DEVPANEL_GEMINI_BIN))
  const bundle = path.dirname(binary)
  const pkg = JSON.parse(await fs.readFile(path.join(bundle, '../package.json'), 'utf8'))
  if (pkg.name !== '@google/gemini-cli' || pkg.version !== '0.60.0') {
    throw new Error('Gemini policy verification requires the inspected CLI 0.60.0 bundle layout')
  }
  const core = (await fs.readdir(bundle)).filter(name => /^core-.*\.js$/.test(name)).sort()[0]
  if (!core) throw new Error('Installed Gemini policy engine is unavailable')
  return { runtime: await import(pathToFileURL(path.join(bundle, core)).href), version: pkg.version, bundle: path.join(bundle, core) }
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')

export async function verifyGeminiPolicy ({ runtime, bundle } = {}) {
  let version = null
  if (!runtime) ({ runtime, version, bundle } = await installedRuntime())
  const { loadPoliciesFromToml, PolicyEngine, PolicyDecision, ApprovalMode, ADMIN_POLICY_TIER } = runtime
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-policy-check-'))
  // An explicitly permissive lower tier ensures a missing deny fails this
  // check, rather than accidentally passing through a deny-by-default engine.
  const permissive = { toolName: '*', decision: PolicyDecision.ALLOW, priority: 1.999 }
  const options = { nonInteractive: true, approvalMode: ApprovalMode.YOLO, defaultDecision: PolicyDecision.ALLOW }
  const control = new PolicyEngine({ ...options, rules: [permissive] })
  let files = 0
  const load = async (policy) => {
    const file = path.join(dir, `devpanel-${files++}.toml`)
    await fs.writeFile(file, policy)
    const parsed = await loadPoliciesFromToml([file], () => ADMIN_POLICY_TIER)
    if (parsed.errors.some(error => error.severity !== 'warning')) throw new Error('Installed CLI rejected the policy')
    return new PolicyEngine({ ...options, rules: [...parsed.rules, permissive] })
  }
  try {
    // --- the auditor: registry exclusion and forced-call denial ---------------
    const policy = buildPolicy({ writesCode: false })
    const hash = sha256(policy)
    const engine = await load(policy)
    const probes = [
      ['write_file', { file_path: '/workspace/fence-canary-write.txt', content: 'BREACH' }],
      ['replace', { file_path: '/workspace/protected.txt', old_string: 'original', new_string: 'BREACH' }],
      ['run_shell_command', { command: 'touch fence-canary-shell.txt' }],
      ['enter_plan_mode', {}], ['exit_plan_mode', {}]
    ]
    const names = [...probes.map(([name]) => name), 'read_file']
    const excluded = engine.getExcludedTools(new Map(), names)
    const tools = []
    for (const [name, args] of probes) {
      const baseline = await control.check({ name, args })
      const checked = await engine.check({ name, args })
      tools.push({ name, excluded: excluded.has(name), decision: checked.decision,
        adminRule: checked.rule?.priority >= ADMIN_POLICY_TIER,
        controlAllowed: baseline.decision === PolicyDecision.ALLOW })
    }
    const read = await engine.check({ name: 'read_file', args: { file_path: '/workspace/protected.txt' } })
    const readAllowed = read.decision === PolicyDecision.ALLOW && !excluded.has('read_file')
    const auditorPassed = readAllowed && tools.every(tool =>
      tool.excluded && tool.decision === PolicyDecision.DENY && tool.adminRule && tool.controlAllowed)

    // --- the writer: every decision the read-only roots depend on ------------
    const writer = { cases: [], passed: true }
    for (const { name, options: opts, expect } of WRITER_CASES) {
      const text = buildPolicy(opts)
      const fenced = await load(text)
      const decisions = []
      for (const [tool, args, expected] of expect) {
        const checked = await fenced.check({ name: tool, args })
        const baseline = await control.check({ name: tool, args })
        // A deny must come from OUR tier; an allow must not be the permissive
        // control's, or a rule that never matched would look like an allow.
        const ours = checked.rule?.priority >= ADMIN_POLICY_TIER
        const ok = checked.decision === expected && ours && baseline.decision === PolicyDecision.ALLOW
        decisions.push({ tool, path: args.file_path ?? args.command ?? null, expected, decision: checked.decision, adminRule: ours, ok })
      }
      const shell = fenced.getExcludedTools(new Map(), ['run_shell_command', 'write_file', 'read_file'])
      const shellExcluded = opts.readOnlyRoots.length ? shell.has('run_shell_command') && !shell.has('write_file') && !shell.has('read_file') : true
      const passed = decisions.every(d => d.ok) && shellExcluded
      writer.cases.push({ name, options: opts, hash: sha256(text), shellExcluded, decisions, passed })
      if (!passed) writer.passed = false
    }

    return {
      cliVersion: version, engine: bundle ?? null, checkedAt: new Date().toISOString(),
      hash, readAllowed, tools, auditorPassed, writer,
      passed: auditorPassed && writer.passed
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

/** One line per decision, for a terminal or a report's summary. */
export function describePolicyCheck (result) {
  const lines = [`Gemini CLI ${result.cliVersion ?? '?'} policy engine — ${result.passed ? 'PASS' : 'FAIL'}`, '']
  lines.push(`auditor (${result.hash.slice(0, 12)}…): ${result.auditorPassed ? 'pass' : 'FAIL'}; read_file ${result.readAllowed ? 'allowed' : 'DENIED'}`)
  for (const tool of result.tools) lines.push(`  ${tool.decision === 'deny' && tool.excluded && tool.adminRule && tool.controlAllowed ? '✓' : '✗'} ${tool.name}: ${tool.decision}${tool.excluded ? ', excluded' : ', NOT excluded'}${tool.adminRule ? '' : ', not by an admin rule'}`)
  for (const c of result.writer.cases) {
    lines.push('', `writer, ${c.name} (${c.hash.slice(0, 12)}…): ${c.passed ? 'pass' : 'FAIL'}${c.shellExcluded ? '' : '; shell NOT excluded'}`)
    for (const d of c.decisions) lines.push(`  ${d.ok ? '✓' : '✗'} ${d.tool} ${JSON.stringify(d.path)} → ${d.decision}${d.ok ? '' : ` (expected ${d.expected}${d.adminRule ? '' : ', not by an admin rule'})`}`)
  }
  return lines.join(NL)
}

// Run directly: verify against the installed engine and keep the report with
// the live ones (host-config/live-reports once it exists). Spends nothing; no model is involved.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyGeminiPolicy()
  const reports = await liveReportsDir({ tree: path.join(path.dirname(fileURLToPath(import.meta.url)), 'reports') })
  await fs.mkdir(reports, { recursive: true })
  const file = path.join(reports, `gemini-policy-${result.checkedAt.replace(/[:.]/g, '-')}.json`)
  await fs.writeFile(file, JSON.stringify(result, null, 2) + NL)
  console.log(describePolicyCheck(result))
  console.log(NL + `report: ${path.relative(process.cwd(), file)}`)
  process.exit(result.passed ? 0 : 1)
}

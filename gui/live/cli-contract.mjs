#!/usr/bin/env node
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { resolveCommand } from '../server/runtime/command.mjs'

/*
 * Do the installed runtimes really honour their config-directory variables?
 *
 *   npm run contract
 *
 * The account feature rests on a promise the CLIs make, not on anything devpanel
 * controls: that `CLAUDE_CONFIG_DIR` and `CODEX_HOME` select which login is used.
 * The adapter suite substitutes the executable for a recorder, which proves the
 * variable is FORWARDED and would stay green if an update stopped honouring it —
 * at which point every account would silently run as whoever is logged in
 * ambiently, with the requested label intact.
 *
 * This lives outside `npm test` on purpose. That suite is offline by contract:
 * nothing in it may reach a real runtime. This launches the real binaries, so it
 * belongs beside `npm run live`, not inside the offline guarantee. It still
 * spends nothing — every command here is local and read-only — and it refuses to
 * run any command that this CLI would treat as a prompt.
 */

const exec = promisify(execFile)
const NL = String.fromCharCode(10)
const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', off: '\x1b[0m' }

let failed = 0
let skipped = 0
const ok = (label, detail = '') => console.log(`  ${c.green}✓${c.off} ${label}${detail ? ` ${c.dim}— ${detail}${c.off}` : ''}`)
const bad = (label, detail = '') => { failed++; console.log(`  ${c.red}✗${c.off} ${label}${detail ? ` ${c.dim}— ${detail}${c.off}` : ''}`) }
const skip = (label, why) => { skipped++; console.log(`  ${c.yellow}○${c.off} ${label} ${c.dim}— ${why}${c.off}`) }

/**
 * Run a command, distinguishing a failure to LAUNCH from a command that ran and
 * said something. `resolveCommand` falls back to the bare name when a binary is
 * absent, so ENOENT arrives as a spawn error rather than as a missing path —
 * treat it as text and a missing CLI becomes a confusing assertion failure.
 */
async function run (command, args, env) {
  // A null value DELETES the variable. Clearing a credential by setting it to ''
  // is not the same thing: a CLI that reads an empty key reports an invalid one,
  // which is a different state from having no credential at all.
  const merged = { ...process.env, ...env }
  for (const [key, value] of Object.entries(env)) if (value == null) delete merged[key]
  try {
    const { stdout, stderr } = await exec(command, args, { env: merged, timeout: 60000 })
    return { launched: true, text: `${stdout}${stderr}` }
  } catch (error) {
    // ABSENT is the only reason to skip. An installed runtime that hangs, or that
    // this user may not execute, is one whose isolation cannot be verified — and
    // an unverified isolation must fail, because the alternative is reporting
    // "nothing to check here" about a binary that is very much there and might
    // be routing every account to the ambient login.
    if (error.code === 'ENOENT') return { launched: false, absent: true, reason: `${command} is not installed (ENOENT)` }
    if (error.killed || error.signal === 'SIGTERM') return { launched: false, absent: false, reason: `${command} ${args.join(' ')} did not finish within the timeout` }
    // `code` is an errno STRING when the spawn failed and the exit CODE when the
    // process ran and returned non-zero. Conflating them turns "logged out, exit
    // 1" — the healthy answer this check is looking for — into a launch failure.
    if (typeof error.code === 'string') return { launched: false, absent: false, reason: `${command} could not be run (${error.code})` }
    // Ran and exited non-zero: its output is still evidence.
    return { launched: true, text: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/**
 * Is there anything on PATH by this name that this user can see?
 *
 * Node reports EACCES rather than ENOENT when the PATH search passes a directory
 * the user may not read — a PATH that lists /root/bin for every account does — so the spawn
 * error alone cannot tell "not installed" from "installed but not executable by
 * me", and that difference decides between a skip and a failure. Nothing visible
 * anywhere on PATH means the runtime is absent FOR THE ACCOUNT THAT WOULD RUN IT,
 * which is the only sense of absent that matters here.
 */
async function visibilityOnPath (command) {
  if (command.includes(path.sep)) return { state: 'present', reason: 'an explicit path was given' }
  // "Not there" and "I could not look" are different answers, and only the first
  // may become a skip. A PATH directory this account cannot read hides whatever
  // is inside it, so treating the failure to look as proof of absence turns an
  // EACCES — an installed runtime whose isolation is unverifiable — back into
  // "nothing to check here".
  const blocked = []
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    try {
      await fs.stat(path.join(dir, command))
      return { state: 'present', reason: `found in ${dir}` }
    } catch (error) {
      if (error.code !== 'ENOENT') blocked.push(`${dir} (${error.code})`)
    }
  }
  if (blocked.length) return { state: 'indeterminate', reason: `could not inspect ${blocked.slice(0, 3).join(', ')}` }
  return { state: 'absent', reason: 'nothing of that name anywhere on PATH' }
}

/** logged-out | logged-in | unrecognised — never a silent third meaning. */
function loginState (text, { loggedOut, loggedIn }) {
  if (loggedOut.test(text)) return 'logged-out'
  if (loggedIn.test(text)) return 'logged-in'
  return 'unrecognised'
}

const CLIS = [
  {
    label: 'claude',
    bin: 'claude',
    override: 'DEVPANEL_CLAUDE_BIN',
    variable: 'CLAUDE_CONFIG_DIR',
    // `doctor` is a real subcommand. Anything this CLI does not recognise is
    // treated as a PROMPT — `config ls` reached the model and spent money.
    args: ['doctor'],
    // It reports no login state, and no free command does. Declared, not
    // discovered by a fallback that would read as success.
    reportsLogin: false,
    reason: 'no claude subcommand reports login state without being treated as a prompt'
  },
  {
    label: 'codex',
    bin: 'codex',
    override: 'DEVPANEL_CODEX_BIN',
    variable: 'CODEX_HOME',
    args: ['login', 'status'],
    reportsLogin: true,
    loggedOut: /not logged in/i,
    loggedIn: /logged in/i
  },
  {
    label: 'gemini',
    bin: 'gemini',
    override: 'DEVPANEL_GEMINI_BIN',
    // Gemini keeps settings, login and session transcripts under one home, which
    // it reads from this variable. It is the whole of the account fence.
    variable: 'GEMINI_CLI_HOME',
    // Local and free: it lists this project's sessions, and reaches for the
    // credential while doing it. Not a prompt, so nothing is spent.
    args: ['--skip-trust', '--list-sessions'],
    /*
     * The isolated run has to be the adapter's account environment, not merely a
     * different home. An ambient API key authenticates the process regardless of
     * which home it reads, so leaving one in place would prove nothing about
     * isolation — and an account whose directory has no login must fail as
     * unauthenticated rather than answer as whoever the host is logged in as.
     */
    env: {
      GEMINI_API_KEY: null,
      GOOGLE_API_KEY: null,
      GOOGLE_APPLICATION_CREDENTIALS: null,
      GOOGLE_GENAI_USE_VERTEXAI: null,
      GOOGLE_CLOUD_PROJECT: null,
      GOOGLE_GENAI_USE_GCA: 'true'
    },
    reportsLogin: true,
    // Session listing is local and prints either way, so it is not evidence of a
    // login; an authentication error is evidence of the absence of one, and is
    // checked first.
    loggedOut: /manual authorization is required|please set an auth method|error authenticating/i,
    loggedIn: /available sessions for this project|no previous sessions found/i
  }
]

console.log(`${c.cyan}installed-CLI contract${c.off} ${c.dim}does each runtime honour its config-directory variable?${c.off}`)
console.log(`${c.dim}local, read-only commands only — nothing here reaches a model or spends anything${c.off}`)

// Said once, as a property of the host rather than of each runtime: a PATH entry
// this account cannot read makes "is it installed?" unanswerable for every bare
// command name, and that is the root cause behind any indeterminate result below.
{
  const opaque = []
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    try { await fs.readdir(dir) } catch (error) { if (error.code !== 'ENOENT') opaque.push(`${dir} (${error.code})`) }
  }
  if (opaque.length) console.log(`${c.yellow}note${c.off} ${c.dim}PATH contains entries this account cannot read: ${opaque.join(', ')}. Absence cannot be established for a bare command name while they are there.${c.off}`)
}
console.log('')

const temps = []
for (const cli of CLIS) {
  console.log(`${c.cyan}${cli.label}${c.off} ${c.dim}${cli.variable}${c.off}`)
  const command = resolveCommand(cli.bin, process.env[cli.override])

  const version = await run(command, ['--version'], {})
  if (!version.launched) {
    // Absence is the only skip, and only on evidence of absence: the spawn's own
    // ENOENT, or a PATH walk that looked everywhere and found nothing. A failure
    // to LOOK is not a finding.
    const visible = await visibilityOnPath(command)
    if (version.absent) skip(`${cli.label} honours ${cli.variable}`, `${version.reason} on this host`)
    else if (visible.state === 'absent') skip(`${cli.label} honours ${cli.variable}`, `no executable named ${cli.bin} anywhere on this account's PATH (${version.reason})`)
    else if (visible.state === 'indeterminate') {
      // Not "installed and broken" and not "absent" — unknowable from here, which
      // is still not a pass. Name the two ways an operator can settle it.
      bad(`${cli.label} honours ${cli.variable}`, `cannot tell whether ${cli.bin} is installed: ${visible.reason}. Point ${cli.override} at its path, or remove the unreadable entries from PATH.`)
    } else bad(`${cli.label} honours ${cli.variable}`, `${version.reason}: an installed runtime whose isolation cannot be checked is not a verified one`)
    continue
  }
  const reported = version.text.trim().split(NL)[0]

  const dir = await fs.mkdtemp(path.join(await fs.mkdir(path.join(os.homedir(), '.cache'), { recursive: true }).then(() => path.join(os.homedir(), '.cache')), 'devpanel-cli-contract-'))
  temps.push(dir)
  const isolated = await run(command, cli.args, { [cli.variable]: dir, ...(cli.env ?? {}) })
  if (!isolated.launched) { bad(`${cli.label} ${cli.args.join(' ')} runs`, isolated.reason); continue }

  const entries = await fs.readdir(dir).catch(() => [])
  if (entries.length) ok(`${cli.label} writes into the directory it is pointed at`, `created ${entries.slice(0, 3).join(', ')}`)
  else bad(`${cli.label} writes into the directory it is pointed at`, `${dir} is still empty: the variable may no longer be honoured`)

  if (!cli.reportsLogin) {
    skip(`an empty ${cli.variable} reports no login`, cli.reason)
    skip(`${cli.label}'s ambient login differs from the isolated one`, 'the ambient run would be a paid call')
  } else {
    // The decisive assertion. "logged-in" here IS the regression — an update that
    // stopped honouring the variable would report the ambient session — so it
    // must fail, never skip. Unrecognised output must fail too: it means this
    // check can no longer tell, which is not the same as passing.
    const state = loginState(isolated.text, cli)
    if (state === 'logged-out') ok(`an empty ${cli.variable} reports no login`, isolated.text.trim().split(NL)[0].slice(0, 80))
    else if (state === 'logged-in') bad(`an empty ${cli.variable} reports no login`, `it reported a LOGIN: the variable is not isolating this runtime`)
    else bad(`an empty ${cli.variable} reports no login`, `unrecognised output, so isolation cannot be established: ${isolated.text.trim().split(NL)[0].slice(0, 80)}`)

    // The contrast: ambient must be recognisably logged IN, or the assertion
    // above only proves this host has no login at all.
    const ambient = await run(command, cli.args, cli.env ?? {})
    if (!ambient.launched) bad(`${cli.label}'s ambient login differs from the isolated one`, ambient.reason)
    else {
      const ambientState = loginState(ambient.text, cli)
      if (ambientState === 'logged-in') ok(`${cli.label}'s ambient login is not what the isolated directory sees`, ambient.text.trim().split(NL)[0].slice(0, 80))
      else if (ambientState === 'logged-out') skip(`${cli.label}'s ambient login differs from the isolated one`, 'nothing is logged in ambiently, so there is no contrast to draw')
      else bad(`${cli.label}'s ambient login differs from the isolated one`, `unrecognised output: ${ambient.text.trim().split(NL)[0].slice(0, 80)}`)
    }
  }
  ok(`recorded against ${cli.label} ${reported}`)
}

for (const dir of temps) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
console.log(`${NL}${failed ? c.red : c.green}${failed} failed${c.off}, ${skipped} skipped`)
process.exit(failed ? 1 : 0)

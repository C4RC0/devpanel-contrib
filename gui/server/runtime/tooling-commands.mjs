import path from 'node:path'

/*
 * The project's declared tooling commands (`workspace.tooling.commands`), in
 * the one form a seat is given them: run from their directory, through the
 * offline wrapper the fence binds at /run/devpanel/tooling (harness/tooling/
 * offline), so a declared command never has network. The wrapper takes the
 * program directly; it adds bubblewrap's own `--` (auditor-1-004). Prompts and
 * tests both use renderToolingCommand, so they cannot drift apart.
 */

export const OFFLINE = '/run/devpanel/tooling/offline'
export const ISOLATION_UNAVAILABLE = 'devpanel-offline: network isolation could not start in this seat'
/** The wrapper ran the command under the runtime's own, proved network denial (Codex's sandbox), not a namespace of its own. */
export const ISOLATION_INHERITED = 'devpanel-offline: isolation inherited'

const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`

/** The exact command line a seat runs for one declared command. */
export function renderToolingCommand (command, worktree) {
  const dir = command.cwd ? path.join(worktree, command.cwd) : worktree
  return `cd ${quote(dir)} && ${OFFLINE} sh -c ${quote(command.run)}`
}

/**
 * The prompt text for a run's declared tooling, or null when it declares none.
 * `shell: false` is a seat whose runtime has no shell this turn (gemini).
 */
export function toolingBrief ({ tooling, worktree, shell = true }) {
  const mounts = tooling?.mounts ?? []
  const commands = tooling?.commands ?? []
  if (!mounts.length && !commands.length) return null
  const lines = ['Project tooling (projects/<id>.yaml workspace.tooling).']
  if (mounts.length) lines.push(`Mounted read-only in the worktree: ${mounts.map((m) => `${m.target} (from ${m.source}${m.provisional ? ', provisional' : ''})`).join('; ')}. Never install anything: these are read-only, and the commands below have no network.`)
  if (commands.length) {
    lines.push('Declared commands, each to be run exactly in the form shown (fill in <placeholders>):')
    for (const c of commands) lines.push(`- ${c.id}${c.provisional ? ' (provisional)' : ''}${c.description ? `: ${c.description}` : ''}${'\n'}  ${renderToolingCommand(c, worktree)}`)
    lines.push(shell
      ? `A listed command is not "could not run" unless you quote the command line you ran and its output. Exit 125 with "${ISOLATION_UNAVAILABLE}" means isolation is unavailable here and the command was NOT run: record it as not run, quoting the command line and that output, and do not run it any other way (not without the wrapper, not with network). "${ISOLATION_INHERITED}" means the command ran under your runtime's own proved network denial, which refuses loopback too: a failure to listen on or reach 127.0.0.1 is that, not a defect of the candidate.`
      : 'Your runtime has no shell in this turn, so you cannot run these: record each one you would need under not run, saying so.')
  }
  return lines.join('\n')
}

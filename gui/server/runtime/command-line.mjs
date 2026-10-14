// The command an invocation ran, as a person would read it in a terminal.
//
// Recorded on the live log's spawn entry so the terminal view can open with
// the exact command line. Credentials never travel as arguments (the adapters
// pass them in the environment), but an argument is still redacted when it
// looks like a secret, and long ones — system prompts, settings JSON — are
// shortened: this is a readable record, not a way to re-run the turn.

const SECRET = /(sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*\S+)/gi
const MAX_ARG = 160

function tidy (arg) {
  let text = String(arg).replace(SECRET, (m) => `${m.slice(0, 3)}…[redacted]`)
  if (text.length > MAX_ARG) text = `${text.slice(0, MAX_ARG)}… (${text.length} chars)`
  return text
}

/** { command, args, cwd } for the live log; arguments tidied, never the environment. */
export function describeCommand ({ command, args = [], cwd = null } = {}) {
  return { command: String(command ?? ''), args: args.map(tidy), cwd: cwd ?? null }
}

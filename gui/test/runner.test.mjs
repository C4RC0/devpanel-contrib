import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { listen } from './helpers.mjs'

export const name = 'test runner — a denied listen fails its suite, not the whole run'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const node = (args, env = {}) => promisify(execFile)(process.execPath, args, { env: { ...process.env, ...env }, timeout: 60_000 })
  .then((r) => ({ code: 0, signal: null, ...r }), (e) => ({ code: e.code, signal: e.signal, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message }))
const quoted = (r) => `exit ${r.code}, signal ${r.signal}, stderr ${JSON.stringify(r.stderr.slice(0, 500))}, stdout ${JSON.stringify(r.stdout.slice(-1500))}`

export default async function (t) {
  // A Unix socket path a regular file already occupies: refused by the file
  // system (EADDRINUSE) for any user, whatever the host's network allows.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-denied-'))
  const denied = path.join(dir, 'occupied')
  await fs.writeFile(denied, '')
  try {
    t.section('1. the listen helper rejects and releases the server')
    {
      const server = net.createServer()
      const error = await listen(server, denied).then(() => null, (e) => e)
      // EPERM where the seat's own sandbox refuses sockets before the file system does.
      t.ok('rejected with the refusal', ['EADDRINUSE', 'EPERM'].includes(error?.code), String(error))
      t.eq('the server is not left listening', server.listening, false)
      t.eq('and no error listener is left behind', server.listenerCount('error'), 0)
    }

    t.section('2. the runner records it, cleans up, goes on and tallies')
    {
      const probe = await node(['-e', "console.log('child-ok')"])
      if (!probe.stdout.includes('child-ok')) {
        t.skip('the runner in a child process', `this environment cannot run a child node process: ${quoted(probe)}`)
        return
      }
      const result = await node([path.join(HERE, 'run.mjs')], { DEVPANEL_TEST_SUITES: path.join(HERE, 'fakes', 'runner'), DENIED_SOCKET: denied })
      const out = result.stdout
      if (!/^\d+ passed, \d+ failed/m.test(out)) {
        t.ok('the child runner printed a tally', false, quoted(result))
        return
      }
      const seen = (re) => [re.test(out), re.test(out) ? '' : out]
      t.eq('exits nonzero', result.code, 1, result.stderr)
      t.ok('the denied listen is that suite\'s failure', ...seen(/a-denied-listen\.test\.mjs › threw › uncaught: .*(EADDRINUSE|EPERM)/))
      t.ok('a stray rejection is its suite\'s failure', ...seen(/b-stray-rejection\.test\.mjs › threw › uncaught: stray rejection/))
      t.ok('a rejection left by a suite that completes is that suite\'s failure', ...seen(/c-completing-rejection\.test\.mjs › threw › uncaught: unawaited suite rejection/))
      t.ok('the next suite still runs', ...seen(/✓.* still runs/))
      t.ok('the final tally is printed', ...seen(/\n3 passed, 3 failed\n/))
      const made = out.match(/^SANDBOX (.+)$/m)?.[1]
      t.ok('cleanupAll() removed what the abandoned suite made', made && !(await fs.stat(made).catch(() => null)), made ?? out)
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

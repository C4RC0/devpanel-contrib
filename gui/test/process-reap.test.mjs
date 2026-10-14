import { runProcess, alive } from '../server/runtime/process.mjs'

const running = async (pid) => alive(pid) && !(await import('node:fs/promises')).readFile(`/proc/${pid}/stat`, 'utf8').then((s) => s.slice(s.lastIndexOf(')') + 2).startsWith('Z'), () => true)

export default async function (t) {
  if (process.platform !== 'linux') { t.skip('reaping escaped descendants reads /proc', 'not linux'); return }

  t.section('cancelling a reaped command does not wait on a descendant that left the process group')
  {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const started = Date.now()
    const result = await runProcess({ command: 'sh', args: ['-c', 'setsid sleep 30 & echo started; sleep 30'], signal: controller.signal, reap: true, graceMs: 500 })
    t.ok('returns promptly instead of waiting for the pipe to close', Date.now() - started < 5000, `${Date.now() - started} ms`)
    t.ok('reports the cancellation', result.cancelled)
    t.eq('finds the escaped descendant', result.leftovers.escaped.length, 1)
    t.eq('and it is gone', await running(result.leftovers.escaped[0]), false)
    t.eq('output read before the cancel is kept', result.stdout, 'started\n')
  }

  t.section('a reaped command that exits normally leaves nothing running in its group')
  {
    const result = await runProcess({ command: 'sh', args: ['-c', '(sleep 30) </dev/null >/dev/null 2>&1 & echo done'], reap: true, graceMs: 500 })
    t.eq('exit code is the command\'s', result.code, 0)
    t.eq('the background child was terminated', result.leftovers.group?.method, 'SIGTERM')
    t.eq('the group is empty', alive(-result.pid), false)
  }

  t.section('without reap, a deliberate daemon survives and the caller still returns')
  {
    const started = Date.now()
    const result = await runProcess({ command: 'sh', args: ['-c', 'setsid sleep 3 & echo started'], closeGraceMs: 300 })
    t.ok('returns within the close grace', Date.now() - started < 3000, `${Date.now() - started} ms`)
    t.ok('reports that it stopped reading', result.leftovers.streamsAbandoned)
    t.eq('the output is complete', result.stdout, 'started\n')
  }

  t.section('large output is read in full')
  {
    const result = await runProcess({ command: 'sh', args: ['-c', 'seq 1 200000'], reap: true })
    t.eq('every line arrives', result.stdout.trim().split('\n').length, 200000)
    t.eq('and the streams closed normally', result.leftovers.streamsAbandoned, false)
  }
}

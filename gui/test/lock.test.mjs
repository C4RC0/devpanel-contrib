import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { acquire, currentOwner } from '../server/runtime/lock.mjs'

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-lock-'))
  const file = path.join(dir, 'run.lock')
  const old = new Date(Date.now() - 120_000)
  const dead = { ...(await currentOwner()), pid: 999999, processStartedAt: '1' }
  try {
    t.section('a lock is published complete, never empty')
    {
      const held = await acquire(file, { purpose: 'test' })
      t.eq('the file holds the whole record', JSON.parse(await fs.readFile(file, 'utf8')).token, held.token)
      t.eq('no temp file is left beside it', (await fs.readdir(dir)).sort(), ['run.lock'])
      await held.release()
    }

    t.section('a stale takeover gate cannot block the lock forever')
    {
      await fs.writeFile(file, JSON.stringify({ token: 'old', owner: dead }))
      await fs.writeFile(`${file}.takeover`, JSON.stringify({ token: 'gate', owner: dead }))
      const started = Date.now()
      const held = await acquire(file, { purpose: 'test' }).catch((e) => e)
      t.ok('a gate whose holder died is removed and the dead lock taken over', Boolean(held.token), held.message)
      t.ok('without spinning', Date.now() - started < 3000, `${Date.now() - started} ms`)
      await held.release?.()

      await fs.writeFile(file, JSON.stringify({ token: 'old', owner: dead }))
      await fs.writeFile(`${file}.takeover`, '')
      const t0 = Date.now()
      const refused = await acquire(file, { purpose: 'test' }).catch((e) => e)
      t.ok('a fresh gate being written is respected: the caller is refused, not spun', refused.name !== undefined && !refused.token && Date.now() - t0 < 3000, `${refused.message} after ${Date.now() - t0} ms`)
      await fs.utimes(`${file}.takeover`, old, old)
      const later = await acquire(file, { purpose: 'test' }).catch((e) => e)
      t.ok('an old unreadable gate is cleared', Boolean(later.token), later.message)
      await later.release?.()
    }

    t.section('an empty lock left by the earlier writer')
    {
      await fs.writeFile(file, '')
      const fresh = await acquire(file, { purpose: 'test' }).catch((e) => e)
      t.eq('is respected while it could still be a write in progress', fresh.liveness, 'unknown')
      await fs.utimes(file, old, old)
      const taken = await acquire(file, { purpose: 'test' }).catch((e) => e)
      t.ok('and taken over once it cannot be', Boolean(taken.token), taken.message)
      await taken.release?.()
    }

    t.section('a live owner still wins')
    {
      const held = await acquire(file, { purpose: 'test' })
      const refused = await acquire(file, { purpose: 'other' }).catch((e) => e)
      t.eq('the second caller is refused', refused.liveness, 'alive')
      await held.release()
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

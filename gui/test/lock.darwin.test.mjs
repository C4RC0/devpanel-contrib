import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { acquire, currentOwner, ownerLiveness } from '../server/runtime/lock.mjs'
import { platformFor } from '../server/runtime/platform.mjs'

/*
 * Lock liveness with the darwin implementation injected: sysctl and ps answer
 * from a table, kill(pid, 0) from a set of live pids. Nothing here reads a Mac;
 * it proves the decision built on darwin's answers. The real formats are the
 * operator's measurement: cd ~/devpanel/gui && node test/run.mjs lock
 */
const BOOT = '0f2c1a3b-9d4e-4f5a-8b6c-7d8e9f0a1b2c'
const T = 'Thu Oct 16 07:42:29 2026'
const T1 = 'Thu Oct 16 07:42:30 2026'
const errno = (code) => Object.assign(new Error(code), { code })

function darwin ({ boot = BOOT, alive = new Set([process.pid]), lstart = { [process.pid]: T } } = {}) {
  return platformFor('darwin', {
    kill: (pid) => { if (!alive.has(pid)) throw errno('ESRCH') },
    exec: async (command, args) => {
      if (command.endsWith('sysctl')) return boot === null ? { ok: false, code: 1, stdout: '', error: 'sysctl: unknown oid' } : { ok: true, code: 0, stdout: `${boot}\n` }
      const pid = Number(args.at(-1))
      const text = lstart[pid]
      return text === undefined ? { ok: false, code: 1, stdout: '', error: 'ps failed' } : { ok: true, code: 0, stdout: `${text}\n` }
    }
  })
}

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-lock-darwin-'))
  const file = path.join(dir, 'run.lock')
  const write = (owner) => fs.writeFile(file, JSON.stringify({ purpose: 'run', token: 'held', owner }))
  try {
    t.section('a live owner reports alive and a second acquire is refused (P2-1)')
    {
      const platform = darwin()
      const held = await acquire(file, { purpose: 'run', platform })
      t.ok('the owner records a darwin boot identity and an lstart time', held.owner.bootId === `darwin-boot:${BOOT}` && held.owner.processStartedAt.startsWith('lstart:'), JSON.stringify(held.owner))
      t.eq('the owner is alive', await ownerLiveness(held.owner, { platform }), 'alive')
      const refused = await acquire(file, { purpose: 'other', platform }).catch((e) => e)
      t.eq('the second caller is refused', refused.liveness, 'alive')
      await held.release()
    }

    t.section('proven absence, a start-time mismatch or a boot change reports dead (P2-2)')
    {
      const platform = darwin()
      const me = await currentOwner(null, { platform })
      const cases = [
        ['an absent pid', { ...me, pid: 4242 }],
        ['the same pid with another start time', { ...me, processStartedAt: 'lstart:1' }],
        ['another boot', { ...me, bootId: 'darwin-boot:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }]
      ]
      for (const [label, owner] of cases) {
        t.eq(`${label}: dead`, await ownerLiveness(owner, { platform }), 'dead')
        await write(owner)
        const taken = await acquire(file, { purpose: 'run', platform }).catch((e) => e)
        t.ok(`${label}: the lock is taken over`, Boolean(taken.token), taken.message)
        await taken.release?.()
      }
    }

    t.section('a failed or malformed probe reports unknown and never permits takeover (P2-3)')
    {
      const me = await currentOwner(null, { platform: darwin() })
      const cases = [
        ['ps fails for a live pid', darwin({ lstart: {} }), me],
        ['ps prints a start without seconds', darwin({ lstart: { [process.pid]: '7:42AM' } }), me],
        ['the boot identity cannot be read', darwin({ boot: null }), me],
        ['the owner could not read its own boot identity', darwin(), { ...me, bootId: `unproved:${os.hostname()}` }]
      ]
      for (const [label, platform, owner] of cases) {
        t.eq(`${label}: unknown`, await ownerLiveness(owner, { platform }), 'unknown')
        for (const purpose of ['run', 'step-allocation', 'top-level-supervisor']) {
          await write(owner)
          const refused = await acquire(file, { purpose, platform, waitMs: purpose === 'step-allocation' ? 50 : 0 }).catch((e) => e)
          t.ok(`${label}: ${purpose} lock is not taken over`, !refused.token && refused.liveness === 'unknown', refused.message)
          t.eq(`${label}: ${purpose} lock is still the owner's`, JSON.parse(await fs.readFile(file, 'utf8')).token, 'held')
        }
      }
      const unproved = await currentOwner(null, { platform: darwin({ boot: null }) })
      t.eq('an owner that cannot read its boot records that, not a stand-in', unproved.bootId, `unproved:${os.hostname()}`)
    }

    t.section('pid-reuse precision is tested (P2-4)')
    {
      const platform = darwin()
      t.eq('darwin start times are whole seconds, and the record says so', platform.describe().startTimePrecision, 'second')
      const recorded = await currentOwner(null, { platform })
      t.eq('the same second: alive', await ownerLiveness(recorded, { platform }), 'alive')
      const oneLater = darwin({ lstart: { [process.pid]: T1 } })
      t.eq('a pid reused one second later: dead', await ownerLiveness(recorded, { platform: oneLater }), 'dead')
      if (process.platform !== 'linux') t.skip('clock-tick precision on linux', 'not linux')
      else {
        const linux = platformFor('linux')
        const own = await currentOwner(null, { platform: linux })
        t.eq('linux records clock ticks', linux.describe().startTimePrecision, 'clock-tick')
        t.eq('linux: one tick apart is another process', await ownerLiveness({ ...own, processStartedAt: String(Number(own.processStartedAt) + 1) }, { platform: linux }), 'dead')
        t.eq('linux: the same tick is the owner', await ownerLiveness(own, { platform: linux }), 'alive')
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

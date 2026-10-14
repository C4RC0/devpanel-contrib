import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { captureIntegrity } from '../server/runtime/integrity.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-integrity-reuse-'))
  const ws = { path: dir }
  try {
    for (let i = 0; i < 50; i++) await fs.writeFile(path.join(dir, `f${i}.txt`), `content ${i}`)
    const old = new Date(Date.now() - 60_000)
    for (let i = 0; i < 50; i++) await fs.utimes(path.join(dir, `f${i}.txt`), old, old)
    await sleep(2100)   // past the racy margin for the files' ctime

    t.section('a repeated capture of an unchanged tree is identical')
    const first = await captureIntegrity(ws)
    const second = await captureIntegrity(ws)
    t.eq('same hash', second.hash, first.hash)

    t.section('reuse cannot hide a change that keeps size and mtime')
    {
      const file = path.join(dir, 'f1.txt')
      await fs.writeFile(file, 'CONTENT 1')              // same length as 'content 1'
      await fs.utimes(file, old, old)                    // mtime put back; ctime cannot be
      const after = await captureIntegrity(ws)
      t.ok('the hash changes', after.hash !== second.hash)
      t.ok('and the entry is re-read', after.entries.find((e) => e.path === 'f1.txt').contentHash !== second.entries.find((e) => e.path === 'f1.txt').contentHash)
    }

    t.section('nor a file replaced by rename, nor a mode change')
    {
      const base = await captureIntegrity(ws)
      await fs.writeFile(path.join(dir, 'tmp'), 'content 2')
      await fs.rename(path.join(dir, 'tmp'), path.join(dir, 'f2.txt'))
      await fs.writeFile(path.join(dir, 'tmp'), 'replaced!')
      await fs.utimes(path.join(dir, 'tmp'), old, old)
      await fs.rename(path.join(dir, 'tmp'), path.join(dir, 'f3.txt'))
      const renamed = await captureIntegrity(ws)
      t.ok('a replaced file with new content is seen', renamed.entries.find((e) => e.path === 'f3.txt').contentHash !== base.entries.find((e) => e.path === 'f3.txt').contentHash)
      await fs.chmod(path.join(dir, 'f4.txt'), 0o755)
      const moded = await captureIntegrity(ws)
      t.eq('the executable bit is seen', moded.entries.find((e) => e.path === 'f4.txt').mode, '000755')
    }

    t.section('a write in the same tick as the previous capture is always re-read')
    {
      const file = path.join(dir, 'f5.txt')
      await captureIntegrity(ws)
      await fs.writeFile(file, 'content X')             // within the racy margin of that capture
      const now = await captureIntegrity(ws)
      t.eq('its new content is hashed', now.entries.find((e) => e.path === 'f5.txt').contentHash !== undefined && now.hash !== first.hash, true)
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

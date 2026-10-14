import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { persistence } from '../server/runtime/persistence.mjs'
import { createAvailabilityStore } from '../server/runtime/failure.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export default async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'durability-test-'))
  try {
    t.section('concurrent writers across store instances and processes preserve every cooldown')
    const file = path.join(root, 'availability.json')
    const stores = Array.from({ length: 12 }, () => createAvailabilityStore(file))
    await Promise.all(stores.map((s, i) => s.recordExhausted({ modelId: `m${i}`, reason: 'quota' })))
    t.eq('all concurrent holds survive', (await stores[0].all()).length, 12)
    const child = promisify(execFile)
    const module = new URL('../server/runtime/failure.mjs', import.meta.url).href
    await Promise.all(Array.from({ length: 4 }, (_, i) => child(process.execPath, ['--input-type=module', '-e', `import {createAvailabilityStore} from ${JSON.stringify(module)}; await createAvailabilityStore(${JSON.stringify(file)}).recordExhausted({modelId:'child${i}',reason:'quota'})`])))
    t.eq('cross-process holds survive', (await stores[0].all()).length, 16)
    await Promise.all(stores.map((s, i) => s.clear(`m${i}`)))
    t.eq('concurrent clears preserve unrelated holds', (await stores[0].all()).length, 4)
    let error
    for (const malformed of [{}, { models: [] }, { models: { m: null } }, { models: { m: { modelId: 'm', exhaustedUntil: 'never' } } }]) {
      await fs.writeFile(file, JSON.stringify(malformed))
      error = null
      try { await stores[0].all() } catch (e) { error = e }
      t.eq('invalid schema fails closed', error?.status, 503)
    }

    t.section('journal sync failure suppresses its socket event')
    const { appendEvent } = await import('../server/runtime/store.mjs')
    const journalDir = path.join(root, 'runs', 'r1')
    await fs.mkdir(journalDir, { recursive: true })
    await fs.writeFile(path.join(journalDir, 'events.jsonl'), '')
    const originalOpen = fs.open
    let emitted = false
    fs.open = async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode)
      if (flags === 'a') handle.sync = async () => { throw new Error('journal-sync') }
      return handle
    }
    error = null
    try { await appendEvent(root, 'r1', { type: 'test' }, { emit: () => { emitted = true } }) } catch (e) { error = e } finally { fs.open = originalOpen }
    t.eq('journal durability failure propagates', error?.message, 'journal-sync')
    t.eq('unacknowledged journal entry is never emitted', emitted, false)

    t.section('failed sync never acknowledges a save; file sync precedes replacement')
    const target = path.join(root, 'state.json')
    for (const fault of ['file-sync', 'rename', 'directory-sync', null]) {
      await fs.writeFile(target, 'old')
      let renamed = false
      const events = []
      const io = { ...fs,
        async open (file, flags, mode) {
          const h = await fs.open(file, flags, mode)
          return {
            writeFile: data => h.writeFile(data), close: () => h.close(),
            async sync () {
              const kind = flags === 'wx' ? 'file-sync' : 'directory-sync'
              events.push(kind)
              if (fault === kind && (kind === 'file-sync' || renamed)) throw new Error(fault)
              await h.sync()
            }
          }
        },
        async rename (from, to) {
          events.push('rename')
          if (fault === 'rename') throw new Error(fault)
          await fs.rename(from, to); renamed = true
        }
      }
      error = null
      try { await persistence(io).writeAtomic(target, 'new') } catch (e) { error = e }
      t.eq('save reports its durability failure', error?.message ?? null, fault)
      t.eq('replacement preserves old data until commit', await fs.readFile(target, 'utf8'), renamed ? 'new' : 'old')
      t.ok('no temporary files remain', !(await fs.readdir(root)).some(n => n.endsWith('.tmp')))
      if (renamed) t.ok('file sync precedes rename and directory sync follows', events.indexOf('file-sync') < events.indexOf('rename') && events.at(-1) === 'directory-sync')
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}

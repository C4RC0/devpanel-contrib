import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

// Atomic visibility and acknowledged durability are separate guarantees.
// Callers that update shared state must also lock the whole read/modify/write.
export function persistence (io = fs) {
  const use = async (handle, action) => {
    let failure
    try { return await action(handle) } catch (error) { failure = error; throw error } finally {
      try { await handle.close() } catch (error) { if (!failure) throw error }
    }
  }
  const syncDir = async dir => use(await io.open(dir, 'r'), handle => handle.sync())
  const prepare = async file => {
    const dir = path.dirname(file)
    await io.mkdir(dir, { recursive: true })
    // Include ancestors: a caller may just have created the run/issue folders.
    for (let current = dir; ; current = path.dirname(current)) {
      await syncDir(current)
      if (path.dirname(current) === current) break
    }
    return dir
  }
  const writeAtomic = async (file, data, { mode = 0o600 } = {}) => {
    const dir = await prepare(file)
    const tmp = `${file}.${crypto.randomUUID()}.tmp`
    let failure
    try {
      const handle = await io.open(tmp, 'wx', mode)
      await use(handle, async h => { await h.writeFile(data); await h.sync() })
      await io.rename(tmp, file)
      await syncDir(dir)
    } catch (error) { failure = error; throw error } finally {
      try { await io.rm(tmp, { force: true }) } catch (error) { if (!failure) throw error }
    }
  }
  const appendDurable = async (file, data, { flag = 'a' } = {}) => {
    const dir = await prepare(file)
    const handle = await io.open(file, flag, 0o600)
    await use(handle, async h => { await h.writeFile(data); await h.sync() })
    await syncDir(dir)
  }
  return { writeAtomic, appendDurable }
}
export const { writeAtomic, appendDurable } = persistence()
export const writeJson = (file, value, options) => writeAtomic(file, JSON.stringify(value, null, 2) + '\n', options)

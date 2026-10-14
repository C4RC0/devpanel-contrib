import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * Is this process running the code that is on disk?
 *
 * The browser reloads the client from `dist/` on every visit, but Node loads
 * `server/` exactly once, at startup. So a rebuilt front end can be served by a
 * back end from an hour earlier — and the symptom is a button that answers with
 * Express's default "Cannot DELETE /api/…", which explains nothing.
 *
 * The check is a comparison of mtimes against this process's own start. Cheap,
 * needs no build step, and detects precisely the situation that produces it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STARTED_AT = Date.now() - Math.round(process.uptime() * 1000)
const CACHE_MS = Number(process.env.DEVPANEL_SOURCE_CACHE_MS ?? 10_000)

let cached = null

async function newestSource (dir) {
  let newest = 0
  let entries = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return newest
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestSource(full))
    } else if (/\.(js|mjs|json)$/.test(entry.name)) {
      try {
        const { mtimeMs } = await fs.stat(full)
        newest = Math.max(newest, mtimeMs)
      } catch { /* vanished mid-scan */ }
    }
  }
  return newest
}

/**
 * @returns { startedAt, sourceChangedAt, stale } — `stale` means server code on
 *          disk is newer than the process serving it, so the running routes are
 *          not the routes in the repository.
 */
export async function sourceState () {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const sourceChangedAt = await newestSource(HERE)
  const value = {
    startedAt: STARTED_AT,
    sourceChangedAt: sourceChangedAt || null,
    // A second of slack: a file written in the same second the process booted is
    // almost certainly the file it loaded.
    stale: Boolean(sourceChangedAt && sourceChangedAt > STARTED_AT + 1000)
  }
  cached = { at: Date.now(), value }
  return value
}

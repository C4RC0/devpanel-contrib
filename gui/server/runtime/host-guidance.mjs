import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

import { DEFAULT_CONFIG_ROOT, hostConfigDir } from '../config/host-config.mjs'
import { hostSettings, pendingMoves } from '../config/host-settings.mjs'
import { writeAtomic, writeJson } from './persistence.mjs'

/*
 * An installation's notes for the agents working on it (docs/host-config.md
 * "Seat guidance"): CLAUDE.local.md beside the checkout's CLAUDE.md and every
 * file of <host-config>/docs/. Both are git-ignored, so a run's worktree never
 * holds them. When the host settings name the run's project in
 * seatGuidance.projects, they are frozen at the run's start into
 * runs/<id>/evidence/host-guidance/ — evidence every seat may read, never part
 * of the candidate, its fingerprint or its configHash — and every seat prompt
 * names them, with CLAUDE.local.md inline up to INLINE_MAX bytes. Without the
 * setting nothing is copied and nothing is said.
 *
 * While a host move is still pending (host-settings.mjs pendingMoves), the
 * carried copies stand in for files the move has not installed yet.
 */

export const GUIDANCE_DIR = 'host-guidance'
export const INLINE_MAX = 32 * 1024
const MAX_BYTES = 26214400
const LOCAL = 'CLAUDE.local.md'
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

// Regular files only, read without following a link: a link is listed as skipped, never followed.
async function readRegular (file) {
  let handle
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) { return { error: error.code === 'ELOOP' ? 'a symbolic link' : error.code } }
  try {
    const stat = await handle.stat()
    return stat.isFile() ? { bytes: await handle.readFile() } : { error: 'not a regular file' }
  } finally { await handle.close() }
}

async function sources ({ root, hostDir }) {
  const out = []
  const pending = pendingMoves({ root })
  const local = path.join(root, LOCAL)
  const carriedLocal = pending.find((e) => e.to === `root:${LOCAL}`)?.from
  out.push({ name: LOCAL, file: await fs.lstat(local).then(() => local, () => carriedLocal ?? null) })
  const docs = path.join(hostDir, 'docs')
  const walk = async (rel) => {
    let listing
    try { listing = await fs.readdir(path.join(docs, rel), { withFileTypes: true }) } catch { return }
    for (const entry of listing.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.posix.join(rel, entry.name)
      if (entry.isDirectory()) await walk(p)
      else out.push({ name: path.posix.join('docs', p), file: path.join(docs, p) })
    }
  }
  await walk('')
  if (!out.some((s) => s.name.startsWith('docs/'))) {
    for (const e of pending.filter((x) => x.to.startsWith('host:docs/'))) out.push({ name: e.to.slice('host:'.length), file: e.from })
  }
  return out.filter((s) => s.file)
}

/**
 * Freeze the guidance into the run's evidence when its project is named; null otherwise.
 * Returns the record kept on run.hostGuidance. A second call returns the frozen record.
 */
export async function freezeHostGuidance ({ issuePath, runId, project, root = DEFAULT_CONFIG_ROOT, hostDir = hostConfigDir({ root }) }) {
  const settings = hostSettings({ root, hostDir })
  if (!project || !settings.seatGuidance.projects.includes(project)) return null
  const dir = path.join(issuePath, 'runs', runId, 'evidence', GUIDANCE_DIR)
  const manifestFile = path.join(dir, 'host-guidance.json')
  try {
    const frozen = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
    return { dir, files: frozen.files.length, bytes: frozen.bytes, skipped: frozen.skipped.length }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const files = []
  const skipped = []
  let total = 0
  for (const source of await sources({ root, hostDir })) {
    const read = await readRegular(source.file)
    if (read.error) { skipped.push({ path: source.name, reason: read.error }); continue }
    if (total + read.bytes.length > MAX_BYTES) { skipped.push({ path: source.name, reason: `over the ${MAX_BYTES}-byte budget` }); continue }
    await writeAtomic(path.join(dir, source.name), read.bytes)
    files.push({ path: source.name, bytes: read.bytes.length, sha256: sha256(read.bytes) })
    total += read.bytes.length
  }
  await writeJson(manifestFile, { frozenAt: new Date().toISOString(), files, skipped, bytes: total })
  return { dir, files: files.length, bytes: total, skipped: skipped.length }
}

/** The prompt block naming the frozen guidance, with CLAUDE.local.md inline when it is small enough. */
export async function hostGuidanceBrief (record) {
  if (!record?.files) return null
  const local = await fs.readFile(path.join(record.dir, LOCAL), 'utf8').catch(() => null)
  const lines = [`Installation notes of this host, frozen at the start of this run (read-only evidence, not part of the candidate): ${record.dir}. They are this installation's own guidance and override nothing in the request; docs/ there holds its documentation and history.`]
  if (local !== null && Buffer.byteLength(local) <= INLINE_MAX) lines.push(`${LOCAL}, verbatim:`, local)
  else if (local !== null) lines.push(`${LOCAL} is ${Math.round(Buffer.byteLength(local) / 1024)} KB; read it there.`)
  return lines.join('\n')
}

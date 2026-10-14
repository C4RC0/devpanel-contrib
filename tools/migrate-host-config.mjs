#!/usr/bin/env node
/*
 * Move this installation's own configuration out of the publishable tree into
 * the host-config directory (docs/host-config.md). Run by a person, after the
 * service has been restarted on code that reads host-config:
 *
 *   node tools/migrate-host-config.mjs --dry-run      what would move, changes nothing
 *   node tools/migrate-host-config.mjs                move
 *   node tools/migrate-host-config.mjs --root <checkout> --to <dir> --manifest <file>
 *
 * What moves: projects/*.yaml, roster entries that name a person's login
 * (`account:`), tools/releases/*-targets.json and gui/live/reports/*, and every
 * entry of a move manifest (default tools/host-move/manifest.json, when present):
 *
 *   { "entries": [ { "from": "<checkout path>", "to": "host:<path> | root:<path> | in-place" } ] }
 *
 * `host:` is relative to the host-config directory (--to), `root:` to the
 * checkout, where Git must ignore it. `in-place` leaves the file where it is,
 * byte for byte: its path is added to the repository's own exclude file
 * (info/exclude, never tracked) and, when it is tracked, untracked. A file that
 * is not tracked (one a delivered patch added, still unstaged) is only excluded:
 * never untracked and never removed. The manifest lists itself, so after a run
 * no part of it is left in the checkout and a second run has nothing to do.
 *
 * Nothing is lost on the way. Every target is checked before anything changes:
 * a target with different bytes, a symlink or special file, a category directory
 * reached through a symlink, a target that is its own original (the same
 * directory by real path, or the same file by device and inode), or a target
 * inside the checkout that Git does not ignore refuses the whole run (exit 2)
 * — a file is never overwritten, and an original is never its own copy. Each file is copied to a temporary name, synced, checked
 * and then linked into place, which fails rather than replace anything. Only
 * when every copy re-reads with its source's sha256 are the originals untracked
 * (`git rm --cached`, staged for the next checkpoint) and removed; any mismatch
 * stops before that (exit 3). A target that already holds the same bytes counts
 * as present, and a manifest entry whose source is gone but whose target exists
 * counts as moved, so a run that stopped half-way is finished by running it
 * again, and a second run finds nothing to move. The manifest is printed as JSON.
 */
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { CATEGORIES, DEFAULT_CONFIG_ROOT, hostConfigDir } from '../gui/server/config/host-config.mjs'

const args = process.argv.slice(2)
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const dryRun = args.includes('--dry-run')
const root = path.resolve(value('--root') ?? DEFAULT_CONFIG_ROOT)
const to = path.resolve(value('--to') ?? hostConfigDir({ root }))
const manifestFile = path.resolve(root, value('--manifest') ?? path.join('tools', 'host-move', 'manifest.json'))

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const hashFile = async (file) => sha256(await fs.readFile(file))
const inside = (dir, p) => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)) }
// Paths are literal for ls-files and rm; check-ignore refuses pathspec magic and takes paths as given.
const git = (gitArgs, { literal = false } = {}) => execFileSync('git', ['-C', root, ...gitArgs], { encoding: 'utf8', env: { ...process.env, ...(literal ? { GIT_LITERAL_PATHSPECS: '1' } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] })
const ignored = (rel, { noIndex = false } = {}) => { try { git(['check-ignore', '-q', ...(noIndex ? ['--no-index'] : []), '--', rel]); return true } catch { return false } }
let repository = true
try { git(['rev-parse', '--is-inside-work-tree']) } catch { repository = false }

function finish (code, manifest) {
  console.log(JSON.stringify({ root, to, dryRun, repository, ...manifest }, null, 2))
  process.exit(code)
}

// The real path of p: its nearest existing ancestor resolved, the rest appended.
async function realPath (p) {
  const rest = []
  for (let q = p; ; q = path.dirname(q)) {
    try { return path.join(await fs.realpath(q), ...rest) } catch (error) {
      if (error.code !== 'ENOENT' || q === path.dirname(q)) throw error
      rest.unshift(path.basename(q))
    }
  }
}
// The first symbolic link from base down to base/rel, if any.
async function linkWithin (base, rel) {
  for (let p = base, parts = rel.split(path.sep); ; p = path.join(p, parts.shift())) {
    const stat = await fs.lstat(p).catch(() => null)
    if (!stat) return null
    if (stat.isSymbolicLink()) return p
    if (!parts.length) return null
  }
}
// A manifest path: relative, '/'-separated, no empty, '.' or '..' segment, no NUL.
const plainPath = (rel) => typeof rel === 'string' && rel.length > 0 && !rel.includes('\0') && !path.isAbsolute(rel) && rel.split('/').every((s) => s && s !== '.' && s !== '..')

// --- what moves, and whether it can --------------------------------------
const entries = []
const refusals = []
// Through a link, a copy and its original can be one file, and removing the
// original would lose the only copy. No path from --root or --to (themselves
// included) down to a category directory may be a link, and what lies above them
// is compared by real path: a source and a target directory that are the same,
// or one inside the other, refuse the run.
const [realRoot, realTo] = [await realPath(root), await realPath(to)]
for (const c of CATEGORIES) {
  for (const [base, rel] of [[root, c.tree], [to, c.host]]) {
    const link = await linkWithin(base, rel)
    if (link) refusals.push(`${link} is a symbolic link; nothing is moved through one`)
  }
  const [from, into] = [path.join(realRoot, c.tree), path.join(realTo, c.host)]
  if (inside(from, into) || inside(into, from)) refusals.push(`${path.join(to, c.host)} and ${path.join(root, c.tree)} are the same directory or one contains the other`)
}
for (const c of CATEGORIES) {
  const dir = path.join(root, c.tree)
  let listing = []
  try { listing = await fs.readdir(dir, { withFileTypes: true }) } catch (error) { if (error.code !== 'ENOENT') throw error }
  for (const entry of listing.filter((e) => c.match(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const from = path.join(dir, entry.name)
    const stat = await fs.lstat(from)
    if (!stat.isFile()) { refusals.push(`${path.relative(root, from)} is not a regular file`); continue }
    const bytes = await fs.readFile(from)
    if (!c.moves(entry.name, bytes.toString('utf8'))) continue
    entries.push({ category: c.id, from: path.relative(root, from), to: path.join(to, c.host, entry.name), sha256: sha256(bytes), size: stat.size, mode: (stat.mode & 0o777).toString(8), tracked: false, action: 'copy' })
  }
}

// The move manifest, when there is one: its entries, each checked like the categories'.
let manifest = null
try { manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')) } catch (error) {
  if (error.code !== 'ENOENT') refusals.push(`the manifest ${manifestFile} cannot be read: ${error.message}`)
  else if (value('--manifest')) refusals.push(`the manifest ${manifestFile} does not exist`)
}
if (manifest && !inside(root, manifestFile)) refusals.push(`the manifest ${manifestFile} is outside ${root}`)
for (const m of manifest?.entries ?? []) {
  const where = /^(host|root):(.*)$/.exec(m.to ?? '')
  if (!plainPath(m.from) || (m.to !== 'in-place' && !(where && plainPath(where[2])))) { refusals.push(`manifest entry ${JSON.stringify(m)} is not a plain relative path to host:, root: or in-place`); continue }
  const [base, rel] = m.to === 'in-place' ? [root, m.from] : [where[1] === 'host' ? to : root, where[2]]
  const target = path.join(base, rel)
  for (const [b, r] of [[root, m.from], [base, rel]]) {
    const link = await linkWithin(b, r)
    if (link) refusals.push(`${link} is a symbolic link; nothing is moved through one`)
  }
  const from = path.join(root, m.from)
  const entry = { category: 'manifest', from: m.from, to: target, inPlace: m.to === 'in-place', tracked: false, self: from === manifestFile }
  const stat = await fs.lstat(from).catch(() => null)
  if (!stat) {
    const there = await fs.lstat(target).catch(() => null)
    if (!entry.inPlace && there?.isFile()) entries.push({ ...entry, sha256: await hashFile(target), action: 'already-moved' })
    else refusals.push(`${m.from} does not exist${entry.inPlace ? '' : `, and neither does ${target}`}`)
    continue
  }
  if (!stat.isFile()) { refusals.push(`${m.from} is not a regular file`); continue }
  entries.push({ ...entry, sha256: await hashFile(from), size: stat.size, mode: (stat.mode & 0o777).toString(8), action: entry.inPlace ? 'exclude' : 'copy' })
}
if (entries.some((e) => e.inPlace) && !repository) refusals.push(`in-place entries need ${root} to be a Git work tree`)

const present = entries.filter((e) => e.action !== 'already-moved')
if (repository && present.length) {
  const tracked = new Set(git(['ls-files', '-z', '--', ...present.map((e) => e.from)], { literal: true }).split('\0').filter(Boolean))
  for (const e of present) e.tracked = tracked.has(e.from)
}
// A target inside the checkout that Git does not ignore would be committed by
// the next checkpoint: the private files would land in history again.
for (const e of entries.filter((x) => x.action === 'copy')) {
  if (!inside(realRoot, await realPath(e.to))) continue
  if (!repository) refusals.push(`the target ${e.to} is inside ${root}, which is not a Git work tree, so its ignore rules cannot be checked`)
  else if (!ignored(path.relative(root, e.to))) refusals.push(`${path.relative(root, e.to)} is inside the checkout and not ignored by Git`)
}
for (const e of entries.filter((x) => x.action === 'copy')) {
  const stat = await fs.lstat(e.to).catch(() => null)
  if (!stat) continue
  const source = await fs.lstat(path.join(root, e.from))
  if (stat.dev === source.dev && stat.ino === source.ino) refusals.push(`${e.to} is the same file as ${e.from}; removing the original would lose it`)
  else if (stat.isFile() && await hashFile(e.to) === e.sha256) e.action = 'already-present'
  else refusals.push(`${e.to} exists with different content; it is never overwritten`)
}

const count = (action) => entries.filter((e) => e.action === action).length
const totals = () => ({ files: entries.length, copied: count('copied'), alreadyPresent: count('already-present'), alreadyMoved: count('already-moved'), excluded: count('excluded') + count('excluded-untracked'), removed: entries.filter((e) => e.removed).length })
if (refusals.length) finish(2, { refused: refusals, entries, totals: totals() })
if (dryRun || !entries.length) finish(0, { entries, totals: totals() })

// --- copy, verify, exclude, then remove ------------------------------------
for (const e of entries.filter((x) => x.action === 'copy')) {
  await fs.mkdir(path.dirname(e.to), { recursive: true, mode: 0o700 })
  const temp = `${e.to}.migrate-${process.pid}`
  const handle = await fs.open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(await fs.readFile(path.join(root, e.from)))
    await handle.chmod(parseInt(e.mode, 8))
    await handle.sync()
  } finally { await handle.close() }
  if (await hashFile(temp) !== e.sha256) { await fs.unlink(temp); finish(3, { failed: `${temp} does not read back as ${e.from}`, entries, totals: totals() }) }
  try { await fs.link(temp, e.to) } catch (error) {
    await fs.unlink(temp)
    finish(2, { refused: [`${e.to} appeared while copying (${error.code}); it is never overwritten`], entries, totals: totals() })
  }
  await fs.unlink(temp)
  e.action = 'copied'
}
for (const e of entries.filter((x) => x.action !== 'already-moved')) {
  const source = await hashFile(path.join(root, e.from))
  const target = e.inPlace ? source : await hashFile(e.to)
  if (source !== e.sha256 || target !== e.sha256) finish(3, { failed: `${e.from} and ${e.to} do not both read as ${e.sha256}; no original was removed`, entries, totals: totals() })
}
const inPlace = entries.filter((e) => e.inPlace)
if (inPlace.length) {
  const exclude = git(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']).trim()
  const text = await fs.readFile(exclude, 'utf8').catch(() => '')
  const missing = inPlace.map((e) => `/${e.from}`).filter((line) => !text.split('\n').includes(line))
  if (missing.length) {
    await fs.mkdir(path.dirname(exclude), { recursive: true })
    await fs.appendFile(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}# Installation files kept in place by tools/migrate-host-config.mjs\n${missing.join('\n')}\n`)
  }
  for (const e of inPlace) {
    if (!ignored(e.from, { noIndex: true })) finish(3, { failed: `${e.from} is still not ignored after adding it to ${exclude}; nothing was untracked or removed`, entries, totals: totals() })
    e.action = e.tracked ? 'excluded' : 'excluded-untracked'
  }
}
const tracked = entries.filter((e) => e.tracked).map((e) => e.from)
if (tracked.length) git(['rm', '--cached', '-q', '--', ...tracked], { literal: true })
// Never an in-place file, and the manifest last: until then a rerun can finish the move.
for (const e of entries.filter((x) => !x.inPlace && x.action !== 'already-moved').sort((a, b) => Number(Boolean(a.self)) - Number(Boolean(b.self)))) {
  await fs.unlink(path.join(root, e.from))
  e.removed = true
  // A manifest's carry directories go with their last file; a category directory stays.
  if (e.category === 'manifest') {
    for (let dir = path.dirname(path.join(root, e.from)); inside(root, dir) && dir !== root; dir = path.dirname(dir)) {
      try { await fs.rmdir(dir) } catch { break }
    }
  }
}
finish(0, { entries, totals: totals() })

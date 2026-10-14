import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'

/*
 * Would this patch apply to the checkout as it is NOW? Read-only: `git apply --check` writes nothing.
 *
 * Asked by the issue page every time it shows a run with a patch (GET …/runs/:runId/patch-check), so the
 * answer is a moment's reading, never a stored fact. It is TEXTUAL: "applies" says git can place every
 * hunk, not that the code works, and not that the result is the approved revision (source-delivery.mjs
 * delivers only when the patch's own paths are unchanged since the base, which is stricter).
 *
 * A patch is relative to the project checkout, but files under a symlinked collection (an application's
 * `@…-modules -> <projects-root>/framework/…`) belong to another repository, and git refuses any path "beyond a
 * symbolic link". So the patch is split per file, each file is followed through the links to the checkout
 * that owns it, and each owner gets its own sections with the link prefix stripped (-p) and the target's
 * place inside the owner prepended (--directory). The reverse check (-R) recognises a patch already in.
 */

const run = (cwd, args, input) => new Promise((resolve) => {
  const child = execFile('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 30000 }, (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr: String(stderr ?? '') }))
  child.stdin.on('error', () => {})
  child.stdin.end(input)
})

// git C-quotes a path with bytes outside printable ASCII — every `ß.<name>.mjs` of the framework —
// as "a/…\303\237…": octal escapes are raw UTF-8 bytes.
const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
export function unquote (quoted) {
  const bytes = []
  for (let i = 1; i < quoted.length - 1; i++) {
    if (quoted[i] !== '\\') { bytes.push(...Buffer.from(quoted[i], 'utf8')); continue }
    const octal = /^[0-7]{3}/.exec(quoted.slice(i + 1))
    if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3 } else { bytes.push(ESCAPES[quoted[i + 1]] ?? quoted.charCodeAt(i + 1)); i += 1 }
  }
  return Buffer.from(bytes).toString('utf8')
}

const PATH = String.raw`("(?:[^"\\]|\\.)*"|\S+)`
const HEADER = new RegExp(`^diff --git ${PATH} ${PATH}\n`)
const side = (raw, prefix) => {
  const value = raw.startsWith('"') ? unquote(raw) : raw
  return value.startsWith(prefix) ? value.slice(prefix.length) : null
}

/** Per-file sections of a git patch, with the path each one changes (null when the header is unreadable). */
export function splitPatch (text) {
  const sections = text.split(/^(?=diff --git )/m).filter((s) => s.startsWith('diff --git '))
  return sections.map((body) => {
    const m = HEADER.exec(body)
    return { body, path: m ? side(m[2], 'b/') : null, from: m ? side(m[1], 'a/') : null }
  })
}

// The longest leading part of `rel` that is a symlink in `root`, or null.
async function linkPrefix (root, rel) {
  const parts = rel.split('/')
  let found = null
  for (let i = 1; i < parts.length; i++) {
    const stat = await fs.lstat(path.join(root, ...parts.slice(0, i))).catch(() => null)
    if (!stat) break
    if (stat.isSymbolicLink()) found = parts.slice(0, i).join('/')
  }
  return found
}

async function ownerOf (dir) {
  const top = await run(dir, ['rev-parse', '--show-toplevel'], '')
  return top.ok ? fs.realpath(top.stdout.trim()) : null
}

/** Group sections by the checkout that owns them: [{owner, strip, directory, paths, body}] or a refusal. */
export async function groupByOwner (projectPath, sections) {
  const root = await fs.realpath(projectPath)
  const groups = new Map()
  for (const section of sections) {
    if (!section.path) return { unavailable: 'a file header of the patch could not be read; check it by hand' }
    const link = await linkPrefix(root, section.path)
    if (link && section.from !== section.path && !(section.from + '/').startsWith(link + '/')) return { unavailable: `${section.path} is renamed across a linked collection` }
    const target = link ? await fs.realpath(path.join(root, link)).catch(() => null) : root
    if (!target) return { unavailable: `${link} does not resolve` }
    const owner = await ownerOf(target)
    if (!owner) return { unavailable: `${link ?? '.'} is not inside a git checkout` }
    const directory = path.relative(owner, target).split(path.sep).join('/')
    const strip = 1 + (link ? link.split('/').length : 0)
    const key = `${owner}\0${strip}\0${directory}`
    if (!groups.has(key)) groups.set(key, { owner, strip, directory, paths: [], body: '' })
    const group = groups.get(key)
    group.paths.push(section.path)
    group.body += section.body
  }
  return { groups: [...groups.values()] }
}

// "error: patch failed: a/b.mjs:12" and friends → the paths git complained about, in the patch's own terms.
function failedPaths (stderr, group) {
  const named = new Set()
  for (const m of stderr.matchAll(/^error: (?:patch failed: )?([^:\n]+?)(?::\d+)?(?:: .*)?$/gm)) named.add(m[1].trim())
  const strip = (p) => (group.directory && p.startsWith(group.directory + '/') ? p.slice(group.directory.length + 1) : p)
  return group.paths.filter((p) => [...named].some((n) => p.endsWith(strip(n)) || n.endsWith(p)))
}

/**
 * { state: 'applies' | 'applied' | 'conflicts' | 'unavailable', owners: [{path, files, state, conflicts?, detail?}], checkedAt, detail? }
 * 'applied' only when every owner's part reverse-applies; a mix of applied and applicable parts is 'conflicts'
 * with the applied parts named, because applying the whole patch would then fail.
 */
export async function checkPatch ({ patchFile, projectPath, now = () => new Date() }) {
  const text = await fs.readFile(patchFile, 'utf8')
  const checkedAt = now().toISOString()
  const sections = splitPatch(text)
  if (!sections.length) return { state: 'unavailable', detail: 'the patch changes nothing', owners: [], checkedAt }
  const grouped = await groupByOwner(projectPath, sections)
  if (grouped.unavailable) return { state: 'unavailable', detail: grouped.unavailable, owners: [], checkedAt }
  const owners = []
  for (const group of grouped.groups) {
    const args = ['apply', '--check', `-p${group.strip}`, ...(group.directory ? [`--directory=${group.directory}`] : [])]
    const forward = await run(group.owner, args, group.body)
    if (forward.ok) { owners.push({ path: group.owner, files: group.paths.length, state: 'applies' }); continue }
    const reverse = await run(group.owner, [...args, '-R'], group.body)
    if (reverse.ok) { owners.push({ path: group.owner, files: group.paths.length, state: 'applied' }); continue }
    const conflicts = failedPaths(forward.stderr, group)
    owners.push({ path: group.owner, files: group.paths.length, state: 'conflicts', conflicts: conflicts.length ? conflicts : group.paths, detail: forward.stderr.trim().split('\n').slice(0, 6).join('\n') })
  }
  const states = new Set(owners.map((o) => o.state))
  const state = states.size === 1 ? owners[0].state : 'conflicts'
  return { state, owners, checkedAt }
}

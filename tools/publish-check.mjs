#!/usr/bin/env node
/*
 * Does the publishable tree name this installation? (docs/host-config.md
 * "Publishing"). Greps what a commit of the checkout would contain — tracked
 * files and untracked ones Git does not ignore — for the installation's own
 * denylist, in file contents and in paths.
 *
 *   node tools/publish-check.mjs                     the host-config denylist
 *   node tools/publish-check.mjs --denylist <file> --root <checkout>
 *
 * The denylist is <host-config>/publish-denylist.txt: one JavaScript regular
 * expression per line, matched case-insensitively; blank lines and lines
 * starting with # are skipped. It belongs to the installation and is never
 * tracked. Without one there is nothing to look for, and the check passes.
 * Binary files (a NUL in the first 8000 bytes) are not read.
 *
 * Exit 0: nothing found (or no denylist). 1: matches, listed as path:line: text.
 * 2: the denylist cannot be read or holds an invalid expression.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { DEFAULT_CONFIG_ROOT, hostConfigDir } from '../gui/server/config/host-config.mjs'

const args = process.argv.slice(2)
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const root = path.resolve(value('--root') ?? DEFAULT_CONFIG_ROOT)
const denylist = path.resolve(value('--denylist') ?? path.join(hostConfigDir({ root }), 'publish-denylist.txt'))

let text
try { text = await fs.readFile(denylist, 'utf8') } catch (error) {
  if (error.code === 'ENOENT' && !value('--denylist')) { console.log(`no denylist at ${denylist}; nothing to check`); process.exit(0) }
  console.error(`publish-check: ${denylist}: ${error.message}`)
  process.exit(2)
}
const sources = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
let pattern
try { pattern = sources.length ? new RegExp(sources.map((s) => `(?:${s})`).join('|'), 'i') : null } catch (error) {
  console.error(`publish-check: ${denylist}: ${error.message}`)
  process.exit(2)
}
if (!pattern) { console.log(`the denylist ${denylist} holds no expression; nothing to check`); process.exit(0) }

/** What a commit would contain: Git's tracked and unignored files, else every regular file. */
async function files () {
  try {
    const listed = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean)
    return [...new Set(listed)]
  } catch {
    const out = []
    const walk = async (rel) => {
      for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
        const p = path.join(rel, entry.name)
        if (entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name)) await walk(p)
        else if (entry.isFile()) out.push(p)
      }
    }
    await walk('')
    return out
  }
}

const found = []
for (const rel of (await files()).sort()) {
  if (pattern.test(rel)) found.push(`${rel}: the path`)
  let bytes
  try { bytes = await fs.readFile(path.join(root, rel)) } catch { continue } // deleted in the work tree: not in a commit
  if (bytes.subarray(0, 8000).includes(0)) continue
  bytes.toString('utf8').split('\n').forEach((line, i) => { if (pattern.test(line)) found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`) })
}
if (!found.length) { console.log(`nothing in ${root} matches ${denylist}`); process.exit(0) }
console.log(found.join('\n'))
console.error(`publish-check: ${found.length} match(es) of ${denylist}`)
process.exit(1)

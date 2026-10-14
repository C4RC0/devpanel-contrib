#!/usr/bin/env node
/*
 * One-off: pack every archived issue that is still a folder into its bundle
 * under issues/.archive/<project>/ (server/issue-bundle.mjs), as archiving
 * now does by itself. Dry run unless --apply.
 *
 *   node tools/pack-archived.mjs            list them with their sizes
 *   node tools/pack-archived.mjs --apply    pack them
 *
 * Each issue is packed on its own and verified before its folder is removed;
 * one that cannot be packed (a worktree whose changes cannot be saved, say) is
 * reported and left exactly as it was.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { ISSUES_DIR, packArchived } from '../server/issues.js'
import { archiveState } from '../server/issue-archive.mjs'

const exec = promisify(execFile)
const apply = process.argv.includes('--apply')
const human = (n) => n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`
const du = async (dir) => { try { return Number((await exec('du', ['-sb', dir], { maxBuffer: 1 << 20 })).stdout.split('\t')[0]) } catch { return 0 } }

let before = 0; let after = 0; let packed = 0; let failed = 0; let found = 0
for (const project of (await fs.readdir(ISSUES_DIR, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)) {
  for (const id of (await fs.readdir(path.join(ISSUES_DIR, project), { withFileTypes: true })).filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}-/.test(e.name)).map((e) => e.name)) {
    const dir = path.join(ISSUES_DIR, project, id)
    if (!await archiveState(dir)) continue
    found++
    const size = await du(dir)
    before += size
    if (!apply) { console.log(`would pack  ${human(size).padStart(9)}  ${project}/${id}`); continue }
    try {
      const summary = await packArchived(project, id)
      after += summary.bundle.bytes
      packed++
      console.log(`packed  ${human(size).padStart(9)} → ${human(summary.bundle.bytes).padStart(8)}  ${project}/${id}`)
    } catch (error) {
      failed++
      console.log(`LEFT AS IS  ${project}/${id}: ${error.message}`)
    }
  }
}
console.log(apply
  ? `\nPacked ${packed} of ${found} archived issue(s): ${human(before)} → ${human(after)} for those packed${failed ? `; ${failed} left as they were (see above)` : ''}.`
  : `\n${found} archived issue(s), ${human(before)} on disk (worktrees included). Run with --apply to pack them.`)

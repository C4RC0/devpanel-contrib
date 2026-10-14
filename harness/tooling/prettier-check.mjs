#!/usr/bin/env node
/*
 * `prettier --check` exactly as an application's own formatter formats, never a
 * second config.
 *
 *   node /run/devpanel/tooling/prettier-check.mjs --settings <formatter module> --check <file>...
 *
 * The formatter module is the application's own formatting handler, mounted
 * read-only into the seat by the project's workspace.tooling.mounts. It is a
 * handler, not an options object: its default export takes { filepath, content }
 * and returns { content } (formatted), { mistakes } (a parse error) or null (an
 * extension it does not format). Calling the handler itself keeps its options
 * and per-extension parser choice in one place, and its own `import "prettier"`
 * resolves from its own directory, so the Prettier is the application's install too.
 *
 * Exit 0: every file is formatted (or of a type the formatter does not format,
 * listed as skipped). 1: some are not, or do not parse (listed). 2: the module
 * could not be loaded or exposes no handler. It only checks; it never writes a file.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function main (argv, { out = console.log, err = console.error } = {}) {
  const at = argv.indexOf('--settings')
  const settings = at >= 0 ? argv[at + 1] : null
  const files = argv.filter((a, i) => a !== '--check' && a !== '--settings' && i !== at + 1)
  if (!settings || !argv.includes('--check') || !files.length) { err('usage: prettier-check.mjs --settings <formatter module> --check <file>...'); return 2 }
  const file = path.resolve(settings)
  let mod
  try { mod = await import(pathToFileURL(file).href) } catch (error) { err(`cannot load the formatter module ${file}: ${error.message}`); return 2 }
  if (typeof mod.default !== 'function') { err(`the formatter module ${file} has no default-exported handler; its exports: ${Object.keys(mod).join(', ') || '(none)'}`); return 2 }
  const unformatted = [], broken = [], skipped = []
  for (const f of files) {
    const content = await fs.readFile(f, 'utf8')
    const result = await mod.default({ filepath: path.resolve(f), content })
    if (result === null || result === undefined) skipped.push(f)
    else if (result.mistakes) broken.push(`${f}: ${result.mistakes.message ?? result.mistakes}`)
    else if (result.content !== content) unformatted.push(f)
  }
  for (const f of unformatted) out(`[warn] ${f}`)
  for (const line of broken) out(`[error] ${line}`)
  for (const f of skipped) out(`[skip] ${f} (the formatter does not format this type)`)
  const bad = unformatted.length + broken.length
  out(bad ? `${bad} of ${files.length} file(s) are not formatted with the application's formatter` : `all ${files.length - skipped.length} checked file(s) are formatted with the application's formatter`)
  return bad ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2))

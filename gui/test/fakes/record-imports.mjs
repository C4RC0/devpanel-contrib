/*
 * Loaded with `node --import` into a CLI under test: appends every module URL
 * the process resolves (static and dynamic imports) to DEVPANEL_IMPORT_LOG, so
 * a suite can say which code a command reached.
 */
import { registerHooks } from 'node:module'
import { appendFileSync } from 'node:fs'

const log = process.env.DEVPANEL_IMPORT_LOG
registerHooks({
  resolve (specifier, context, next) {
    const resolved = next(specifier, context)
    appendFileSync(log, resolved.url + '\n')
    return resolved
  }
})

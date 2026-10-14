#!/usr/bin/env node
import path from 'node:path'
import { retireLegacyJournal } from './legacy-journal.mjs'

const [issuePath, runId, flag, reason, ...extra] = process.argv.slice(2)
if (!issuePath || !runId || flag !== '--reason' || !reason?.trim() || extra.length) {
  console.error('Usage: node gui/server/runtime/legacy-journal-cli.mjs <issue-directory> <run-id> --reason "forensic explanation"')
  process.exitCode = 2
} else {
  try {
    const record = await retireLegacyJournal(path.resolve(issuePath), runId, reason)
    console.log(JSON.stringify({ runId, ...record }, null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

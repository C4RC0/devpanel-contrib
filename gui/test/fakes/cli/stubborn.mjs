#!/usr/bin/env node
/*
 * A deliberately uncooperative agent runtime.
 *
 * Ignores SIGTERM and spawns a child that ignores it too, both staying in the
 * invocation's process group. Records every pid so a test can prove that
 * cancellation actually terminated the tree rather than merely stopped waiting.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pidFile = process.env.PID_FILE
const role = process.argv[2] ?? 'parent'

process.on('SIGTERM', () => { /* deliberately ignored */ })
process.on('SIGINT', () => { /* deliberately ignored */ })

const record = (entry) => {
  if (!pidFile) return
  fs.appendFileSync(pidFile, JSON.stringify(entry) + String.fromCharCode(10))
}

record({ role, pid: process.pid, pgid: process.pid === process.ppid ? process.pid : null })

if (role === 'parent') {
  // A tool process, as an agent runtime would spawn. Not detached, so it stays
  // in the group — which is exactly what a group-wide signal must reach.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child'], {
    env: process.env,
    stdio: 'ignore'
  })
  record({ role: 'child', pid: child.pid })
  process.stdout.write('working' + String.fromCharCode(10))
}

// Never finish on our own.
setInterval(() => {}, 1 << 30)

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import * as codex from '../../harness/codex.mjs'

export const name = 'host file reads beneath seat-writable paths do not follow links (R8-1)'

const NL = String.fromCharCode(10)

/**
 * A fake codex CLI that, instead of writing its last message to `-o`, plants
 * something else there: a link to a host file, or a FIFO. The event stream
 * still carries the real final message.
 */
async function fakeCodex (dir, plant) {
  const file = path.join(dir, 'codex')
  await fs.writeFile(file, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs'); const { execSync } = require('node:child_process')",
    "const i = process.argv.indexOf('-o'); const out = i >= 0 ? process.argv[i + 1] : null",
    `if (out) { ${plant} }`,
    "const events = [{ type: 'thread.started', thread_id: '00000000-0000-4000-8000-000000000001' },",
    "  { type: 'item.completed', item: { type: 'agent_message', text: 'the real final message' } },",
    "  { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }]",
    "for (const e of events) process.stdout.write(JSON.stringify(e) + '\\n')"
  ].join(NL) + NL)
  await fs.chmod(file, 0o755)
  return file
}

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hostio-'))
  const canary = path.join(dir, 'host-secret.txt')
  await fs.writeFile(canary, 'HOST-CANARY-must-not-become-the-response')
  const saved = process.env.DEVPANEL_CODEX_BIN
  const run = async (plant) => {
    process.env.DEVPANEL_CODEX_BIN = await fakeCodex(await fs.mkdtemp(path.join(dir, 'bin-')), plant)
    const work = await fs.mkdtemp(path.join(dir, 'work-'))
    return codex.invoke({ model: 'm', cwd: work, prompt: 'hi', ledgerDir: await fs.mkdtemp(path.join(dir, 'ledger-')) })
  }
  try {
    t.section('a link planted at the last-message path')
    {
      const r = await run(`fs.symlinkSync(${JSON.stringify(canary)}, out)`)
      t.ok('the host file is not read into the response', !r.response.includes('HOST-CANARY'), r.response)
      t.eq('the event stream supplies the final message', r.response, 'the real final message')
    }
    t.section('a FIFO planted at the last-message path')
    {
      const started = Date.now()
      const r = await run("execSync('mkfifo ' + JSON.stringify(out))")
      t.ok('the read does not block', Date.now() - started < 10000)
      t.eq('the event stream supplies the final message', r.response, 'the real final message')
    }
    t.section('an ordinary last-message file is still read')
    {
      const r = await run("fs.writeFileSync(out, 'from the file')")
      t.eq('the file wins when it is a regular file', r.response, 'from the file')
    }
  } finally {
    if (saved === undefined) delete process.env.DEVPANEL_CODEX_BIN; else process.env.DEVPANEL_CODEX_BIN = saved
    await fs.rm(dir, { recursive: true, force: true })
  }
}

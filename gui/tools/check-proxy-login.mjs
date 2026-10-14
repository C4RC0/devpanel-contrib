#!/usr/bin/env node
/*
 * Would the panel accept this reverse-proxy basic-auth login? Asks for a user and a password (not echoed) and
 * runs the server's own check (server/proxy-user.mjs examineLogin) against the proxy's users directory.
 *
 *   node tools/check-proxy-login.mjs [user]
 *
 * "verified" here while the browser still gets the token page means the credential is fine and the
 * Authorization header does not reach the panel; a reason code (bad-password, no-credential, …) means
 * no published digest (the host settings' proxyLogin.digestFiles, default .hash) matches. Prints codes only, never the password or a digest. Needs a terminal.
 */
import readline from 'node:readline'

import { examineLogin } from '../server/proxy-user.mjs'

function ask (question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (hidden) rl._writeToOutput = (text) => { if (text.startsWith(question)) process.stdout.write(text) }
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer) })
  })
}

if (!process.stdin.isTTY) {
  console.error('run this in a terminal: it reads the password without echoing it')
  process.exit(2)
}
const user = process.argv[2] ?? await ask('user: ', false)
const password = await ask('password: ', true)
const header = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')
const outcome = await examineLogin({ authorization: header })
console.log(outcome.login?.verified ? `verified: ${user}` : `not verified: ${outcome.reason ?? 'unverified (no users directory)'}`)

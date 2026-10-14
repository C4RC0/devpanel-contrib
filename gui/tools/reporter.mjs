#!/usr/bin/env node
/*
 * Manage reporters: deployments that report to POST /api/report/:project as themselves (server/reporters.mjs).
 *
 *   node tools/reporter.mjs list
 *   node tools/reporter.mjs add <name> <project> [--fault any|assess|none] [--request any|assess|none]
 *   node tools/reporter.mjs policy <name> [--fault …] [--request …]
 *   node tools/reporter.mjs remove <name>
 *
 * `add` prints the key ONCE; on an existing name it replaces the key (the old one stops working) and
 * keeps the policy unless flags change it. The key goes into the deployment's secrets, never into Git.
 * Run as the panel's owner: the store is issues/.reporters.json, 0600.
 */
import { addReporter, readReporters, removeReporter, setPolicy } from '../server/reporters.mjs'

const [command, ...rest] = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--fault' || rest[i] === '--request') flags[rest[i].slice(2)] = rest[++i]
  else positional.push(rest[i])
}

try {
  if (command === 'list') {
    const reporters = await readReporters()
    if (!Object.keys(reporters).length) console.log('no reporters')
    for (const [name, r] of Object.entries(reporters)) console.log(`${name}\t${r.project}\tfault: ${r.policy.fault}\trequest: ${r.policy.request}\tsince ${r.createdAt}`)
  } else if (command === 'add' && positional.length === 2) {
    const key = await addReporter({ name: positional[0], project: positional[1], policy: flags })
    console.log(`reporter ${positional[0]} for ${positional[1]}; key (shown once):\n${key}`)
  } else if (command === 'policy' && positional.length === 1) {
    const r = await setPolicy(positional[0], flags)
    console.log(`${positional[0]}: fault ${r.policy.fault}, request ${r.policy.request}`)
  } else if (command === 'remove' && positional.length === 1) {
    console.log((await removeReporter(positional[0])) ? `removed ${positional[0]}` : `no reporter ${positional[0]}`)
  } else {
    console.error('usage: reporter.mjs list | add <name> <project> [--fault L] [--request L] | policy <name> [--fault L] [--request L] | remove <name>   (L: any, assess, none)')
    process.exitCode = 2
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}

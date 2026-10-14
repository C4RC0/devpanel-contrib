#!/usr/bin/env node
/*
 * Connect one Boilerplate deployment to devpanel as a reporter, end to end.
 *
 *   node tools/provision-reporter.mjs <name> <project> <ssh-target> <deployment-root> [--fault L] [--request L] [--url URL]
 *   e.g. node tools/provision-reporter.mjs example-production example-project deploy@production.example.invalid /opt/production.example.invalid
 *
 * 1. creates the reporter, or gives an existing one a new key (reporters.mjs; the old key stops working);
 * 2. writes, over SSH and through stdin so the key never appears on a command line or in a log:
 *      <root>/secrets/devpanel-reporter.json  {"key"}            0600  — read by the devpanel-reporter module
 *      <root>/config/devpanel-reporter.json   {"url","project"}  0600  — likewise; the framework keeps settings
 *                                                                        in config/ and credentials in secrets/
 * 3. proves it from the deployment: a keyed report with EMPTY input. The endpoint checks network, key and
 *    project before the input, so 400 "input … is required" proves all three and opens no issue; 403 names
 *    what failed.
 *
 * The URL is the panel's private address (report.mjs refuses the proxy): --url, else the host settings'
 * reporter.panelUrl (docs/host-config.md). Run as the panel owner.
 */
import { spawnSync } from 'node:child_process'

import { addReporter } from '../server/reporters.mjs'
import { hostSettings } from '../server/config/host-settings.mjs'

const args = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < args.length; i++) {
  if (['--fault', '--request', '--url'].includes(args[i])) flags[args[i].slice(2)] = args[++i]
  else positional.push(args[i])
}
const [name, project, target, root] = positional
if (!name || !project || !target || !root?.startsWith('/')) {
  console.error('usage: provision-reporter.mjs <name> <project> <ssh-target> <deployment-root> [--fault L] [--request L] [--url URL]')
  process.exit(2)
}
const url = flags.url ?? hostSettings().reporter.panelUrl
if (!url) {
  console.error('provision-reporter.mjs: no panel URL: pass --url <the panel\'s private address>, or set reporter.panelUrl in the host settings')
  process.exit(2)
}

const ssh = (script, input) => spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', target, script], { input, encoding: 'utf8', timeout: 60000 })
const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`

const policy = Object.fromEntries(['fault', 'request'].filter((k) => flags[k]).map((k) => [k, flags[k]]))
const key = await addReporter({ name, project, policy })
console.log(`reporter ${name} for ${project}: key created`)

// One remote shell reads two JSON documents from stdin, separated by a NUL-free marker line.
const payload = `${JSON.stringify({ key })}\n--devpanel-reporter--\n${JSON.stringify({ url, project }, null, 2)}\n`
const write = ssh(`set -e; umask 077; cd ${quote(root)}; test -d secrets && test -d config
awk 'BEGIN{f="secrets/devpanel-reporter.json.tmp"} /^--devpanel-reporter--$/{f="config/devpanel-reporter.json.tmp"; next} {print > f}'
mv secrets/devpanel-reporter.json.tmp secrets/devpanel-reporter.json; mv config/devpanel-reporter.json.tmp config/devpanel-reporter.json
stat -c '%a %n' secrets/devpanel-reporter.json config/devpanel-reporter.json`, payload)
if (write.status !== 0) {
  console.error(`writing to ${target}:${root} failed: ${write.stderr || write.error?.message}`)
  process.exit(1)
}
console.log(write.stdout.trim().replace(/^/gm, `  ${target}: `))

const probe = ssh(`cd ${quote(root)}; node -e 'const k=JSON.parse(require("fs").readFileSync("secrets/devpanel-reporter.json")).key, c=JSON.parse(require("fs").readFileSync("config/devpanel-reporter.json")); process.stdout.write(JSON.stringify({k,u:c.url+"/api/report/"+encodeURIComponent(c.project)}))' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const {k,u}=JSON.parse(s);process.env.NODE_TLS_REJECT_UNAUTHORIZED="0";fetch(u,{method:"POST",headers:{"content-type":"application/json","x-devpanel-reporter-key":k},body:JSON.stringify({input:""})}).then(async r=>console.log(r.status,await r.text()),e=>console.log("unreachable",e.cause?.code??e.message))})' 2>/dev/null`)
const answer = probe.stdout.trim()
const ok = answer.startsWith('400') && answer.includes('input')
console.log(`  probe from ${target}: ${answer || probe.stderr.trim()}`)
console.log(ok ? `  ${name} reaches devpanel and its key is accepted for ${project}` : `  ${name} is NOT working yet: see the probe answer above`)
process.exitCode = ok ? 0 : 1

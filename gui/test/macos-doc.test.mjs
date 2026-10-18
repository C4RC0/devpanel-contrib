import fs from 'node:fs/promises'
import path from 'node:path'

import { hostConfigDir } from '../server/config/host-config.mjs'
import { CONFIG_ROOT } from '../server/config/load.mjs'

export const name = 'docs/macos.md — the sections, the exact checklist, the agent environment install-on-osx.sh writes, neutral labels'

/** The body of a `## heading` section, up to the next one. */
const section = (text, heading) => {
  const start = text.indexOf(`\n## ${heading}\n`)
  if (start < 0) return null
  const rest = text.slice(start + heading.length + 5)
  const end = rest.indexOf('\n## ')
  return end < 0 ? rest : rest.slice(0, end)
}

export default async function (t) {
  const doc = await fs.readFile(path.join(CONFIG_ROOT, 'docs/macos.md'), 'utf8')
  const script = await fs.readFile(path.join(CONFIG_ROOT, 'install-on-osx.sh'), 'utf8')

  t.section('1. P4-sections: seats, fence labels, tooling, local checks, Gemini, local-auth risk, install/service, the checklist')
  for (const heading of ['Supported seats', 'Fence state and labels', 'Tooling and mounts', 'Local checks', 'Gemini', 'Local authentication and its risk', 'Install and service', 'Agent environment', 'Proof status', 'Mac proof checklist']) {
    t.ok(`## ${heading}`, section(doc, heading) !== null)
  }
  t.ok('the three labels are named', ['local-enforced', 'local-unconfined', 'local-refused'].every((l) => doc.includes(l)))

  t.section('2. P4-commands, P4-coverage: the checklist names exact commands')
  const checklist = section(doc, 'Mac proof checklist') ?? ''
  // The issue's `lock|process-reap|baseline-cache|selection` is four runs (one filter each), not a pipeline.
  for (const suite of ['lock', 'process-reap', 'baseline-cache', 'selection']) {
    t.ok(`cd ~/devpanel/gui && node test/run.mjs ${suite}`, checklist.includes(`cd ~/devpanel/gui && node test/run.mjs ${suite}\``))
  }
  t.ok('and says they are four separate runs', /four\s+separate runs/.test(checklist))
  for (const command of ['bash ~/devpanel/install-on-osx.sh', 'npm test', 'npm run contract', 'plutil -lint ~/Library/LaunchAgents/<label>.plist', 'launchctl print gui/$(id -u)/<label>']) {
    t.ok(command, checklist.includes(command))
  }
  // install-on-osx.sh reads DEVPANEL_SOURCE on every run and keeps nothing of it.
  const exported = 'export DEVPANEL_SOURCE=<user>@<panel-host>:<panel checkout>/'
  t.ok('the install section exports DEVPANEL_SOURCE before every run, and says it is not remembered', (section(doc, 'Install and service') ?? '').includes(exported) && /does not remember `DEVPANEL_SOURCE`/.test(doc))
  t.ok('so does checklist item 1, before the bare installer command', /1\. \*\*Install\.\*\* First `export DEVPANEL_SOURCE=<user>@<panel-host>:<panel checkout>\/`[\s\S]*?then `bash ~\/devpanel\/install-on-osx\.sh`/.test(checklist))
  t.ok('every item states what to expect', (checklist.match(/^\d+\. \*\*/gm) ?? []).length >= 10 && (checklist.match(/Expected/g) ?? []).length >= 10)
  for (const [topic, pattern] of [['identity formats', /kern\.bootsessionuuid/], ['escaped processes', /escaped\s+descendant/], ['case-insensitive APFS', /Case-insensitive APFS/i], ['paths with spaces', /tmp with space/], ['executable bits', /Executable bits/], ['archive metadata', /COPYFILE_DISABLE=1/], ['a local project check run', /target=local commands=fmt,clippy,test/]]) {
    t.ok(`covers ${topic}`, pattern.test(checklist))
  }

  t.section('3. P4-unproved: the skipped login assertions and Keychain isolation')
  // Wrapped lines read as one: a phrase may span them.
  const proof = (section(doc, 'Proof status') ?? '').replace(/\s+/g, ' ')
  t.ok('the two skipped Claude contract assertions are recorded as unproved', proof.includes('an empty CLAUDE_CONFIG_DIR reports no login') && proof.includes("claude's ambient login differs from the isolated one") && /unproved/.test(proof))
  t.ok('Keychain isolation is a stated limitation', /Keychain \(a stated limitation\)/.test(proof))
  t.ok('and a checklist step', /\*\*Keychain\.\*\*/.test(checklist))

  t.section('4. P4-env: install-on-osx.sh sets exactly the environment variables the document names')
  const plist = script.slice(script.indexOf('cat > "$PLIST" <<EOF'), script.indexOf('\nEOF\n'))
  const environment = plist.slice(plist.indexOf('<key>EnvironmentVariables</key>'), plist.indexOf('</dict>', plist.indexOf('<key>EnvironmentVariables</key>')))
  const written = [...environment.matchAll(/<key>([A-Z_]+)<\/key>/g)].map((m) => m[1]).sort()
  const named = [...(section(doc, 'Agent environment') ?? '').matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]).sort()
  t.ok('the installer writes some', written.length > 0, written.join(' '))
  t.eq('the document names exactly those', named, written)

  t.section('5. P4-neutral: launchd labels are the default or <label>; the installation\'s own denylist when there is one')
  const labels = [...doc.matchAll(/LaunchAgents\/([^/\s`]+)\.plist/g), ...doc.matchAll(/gui\/\$\(id -u\)\/([^\s`]+)/g)].map((m) => m[1])
  t.ok('every launchd label in the document is <label> or local.devpanel', labels.length > 0 && labels.every((l) => ['<label>', 'local.devpanel'].includes(l)), [...new Set(labels)].join(' '))
  // Resolved as tools/publish-check.mjs does. The test runner points the host
  // configuration at an empty directory (run.mjs), so under npm test this skips;
  // the tree's neutrality is npm run publish:check's, on the host.
  const denylist = path.join(hostConfigDir({ root: CONFIG_ROOT }), 'publish-denylist.txt')
  const text = await fs.readFile(denylist, 'utf8').catch(() => null)
  if (text === null) t.skip('docs/macos.md matches nothing in the installation\'s publish denylist', `no publish denylist at ${denylist}; the runner isolates host configuration (run.mjs), so neutrality is npm run publish:check's on the host`)
  else {
    const patterns = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    const found = patterns.filter((p) => new RegExp(p, 'i').test(doc))
    t.eq('docs/macos.md matches nothing in the installation\'s publish denylist', found.length, 0)
  }
}

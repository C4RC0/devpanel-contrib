// The README screenshots (docs/images), from an isolated stage: temporary projects and issues, the test
// suite's fake runtime (nothing real is invoked or spent) and an empty host configuration. The hostname
// the panel shows is the machine's, so run it in a UTS namespace with a neutral one, from gui/:
//   DEVPANEL_HOST_CONFIG_DIR=$(mktemp -d) DEVPANEL_FENCE=off DEVPANEL_DIST_DIR=<a vite build> \
//     unshare -Ur -u sh -c 'hostname devpanel.example.org && exec node tools/readme-screenshots.mjs ../docs/images'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const GUI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { startStage } = await import(GUI + '/test/browser/stage.mjs')
const { launchChromium, closeChromium } = await import(GUI + '/test/browser/chromium.mjs')
const exec = promisify(execFile)

// The stage's roster points every seat at the fake runtime; show the harness each model really runs on.
async function relabel (page) {
  await page.evaluate(() => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.nodeValue.includes('fake')) continue
      const row = n.parentElement?.closest('tr, .v-list-item, div')?.textContent ?? ''
      const harness = /gpt/i.test(row + n.nodeValue) ? 'codex' : 'claude'
      n.nodeValue = n.nodeValue.replace(/\bfake\b/g, harness)
    }
    for (const s of document.querySelectorAll('select')) for (const o of s.options) o.text = o.text.replace(/\bfake\b/g, /gpt/i.test(o.text) ? 'codex' : 'claude')
  })
}
const out = path.resolve(process.argv[2] ?? '.')
await fs.mkdir(out, { recursive: true })

const stage = await startStage({ project: 'webshop-project', control: { delayMs: 1500, writes: { implement: { file: 'address.js', text: 'export const HOUSE_NUMBER = /^\\d+(?:[\\/-]?[A-Za-z])?$/\n' } } } })
try {
  for (const p of ['billing-project', 'mobile-app-project']) {
    const dir = path.join(stage.projectsDir, p)
    await fs.mkdir(dir)
    await exec('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  }
  const issues = [
    '# Checkout rejects addresses with a house number suffix\n\n## Goal\nAddresses like "12/B" are accepted at checkout.',
    '# Show stock levels on the product page\n\n## Goal\nCustomers see whether an item ships today.',
    '# Export monthly orders as CSV\n\n## Goal\nAccounting gets one CSV per month.',
    '# Speed up the category listing\n\n## Goal\nThe listing renders in under 300 ms with 5 000 products.'
  ]
  const ids = []
  for (const input of issues) {
    const { body } = await stage.request(`/api/projects/${stage.project}/issues`, { method: 'POST', body: JSON.stringify({ input }) })
    ids.push(body.id)
  }

  const chrome = await launchChromium()
  if (!chrome.ok) throw new Error('no browser: ' + chrome.reason)
  const context = await chrome.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await page.goto(stage.origin)
  await page.evaluate(([token]) => sessionStorage.setItem('devpanel.token', token), [stage.token])

  // A completed implementation run on the first issue, started the way an operator does.
  const issueUrl = `${stage.origin}/projects/${stage.project}/${ids[0]}`
  await page.goto(issueUrl)
  await page.waitForSelector('button:has-text("Run a playbook")', { timeout: 20000 })
  await page.click('button:has-text("Run a playbook")')
  await page.waitForSelector('.pick', { timeout: 15000 })
  await page.click('.pick:has-text("implementation")')
  await page.waitForSelector('text=Participants', { timeout: 15000 })
  await page.waitForTimeout(500)
  await relabel(page)
  await page.screenshot({ path: path.join(out, 'start-run.png') })
  await page.click('button:has-text("Start run")')
  for (let i = 0; i < 120; i++) {
    const [run] = await stage.runs(ids[0])
    if (run && !['preflighting', 'pending', 'running', 'stopping'].includes(run.status)) { console.log('run', run.status, run.outcome); break }
    await new Promise((r) => setTimeout(r, 1000))
  }
  await page.goto(issueUrl)
  await page.waitForTimeout(2500)
  await relabel(page)
  await page.screenshot({ path: path.join(out, 'issue-run.png') })

  await page.goto(`${stage.origin}/projects/${stage.project}`)
  await page.waitForTimeout(2500)
  await page.screenshot({ path: path.join(out, 'issues.png') })

  await context.close()
  await closeChromium?.(chrome)
} finally {
  await stage.stop()
}
console.log('screenshots in', out)

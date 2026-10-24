import fs from 'node:fs/promises'
import path from 'node:path'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'

export const name = 'issue family — the list nests children, the issue page names parent and prerequisites'

export default async function (t) {
  const stage = await startStage()
  const parent = await stage.createIssue('Parent with a finding')
  const child = await stage.createIssue('Child finding')
  const rule = await stage.createIssue('Rule to settle first')
  // Provenance is written at creation by the engine; a folder edit stands in for a finding here.
  const file = path.join(stage.issuesDir, stage.project, child.id, 'issue.json')
  const meta = JSON.parse(await fs.readFile(file, 'utf8'))
  meta.openedBy = { user: 'engine', host: 'h', from: { project: stage.project, issueId: parent.id, runId: null, via: 'finding' } }
  await fs.writeFile(file, JSON.stringify(meta))
  await stage.request(`/api/projects/${stage.project}/issues/${child.id}/dependencies`, { method: 'POST', body: JSON.stringify({ dependsOn: [rule.id], reason: 'needs the rule' }) })

  let browser = await openBrowser(`${stage.origin}/projects/${stage.project}`, { token: stage.token })
  try {
    await browser.until(() => browser.has('Child finding'))
    const names = () => browser.all('tbody tr').map((tr) => tr.querySelector('.issues__name')?.textContent ?? '')
    const order = names()
    t.ok('the child is listed right under its parent', order.indexOf('Child finding') === order.indexOf('Parent with a finding') + 1, order.join(' | '))
    const node = browser.all('.issues__node').find((el) => el.textContent.includes('Child finding'))
    t.eq('indented one level', node?.style.getPropertyValue('--depth'), '1')
    t.ok('the parent says it has an open sub-issue', browser.has('1 open sub-issue'))
    t.ok('the child says what it waits for', browser.has('waits for Rule to settle first'))
    t.ok('the prerequisite says what it holds up', browser.has('holds up 1'))
    await browser.clickWhen(() => browser.all('button').find((el) => el.getAttribute('aria-label') === 'Hide the issues that came out of this one'))
    await browser.until(() => !names().includes('Child finding'))
    t.ok('collapsing hides the child', !names().includes('Child finding'))
    browser.close()

    browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${child.id}`, { token: stage.token })
    await browser.until(() => browser.has('Finding of'))
    const family = () => browser.all('.family')[0]?.textContent ?? ''
    t.ok('the issue page names its parent', family().includes('Parent with a finding'), family())
    t.ok('and its prerequisite with the reason', family().includes('Rule to settle first') && family().includes('needs the rule'), family())
    browser.close()

    browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${rule.id}`, { token: stage.token })
    await browser.until(() => browser.has('Waiting for this'))
    t.ok('the prerequisite lists what waits for it', family().includes('Child finding'), family())
  } finally { browser.close() }
}

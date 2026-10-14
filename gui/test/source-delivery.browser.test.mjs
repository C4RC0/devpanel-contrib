import fs from 'node:fs/promises'
import path from 'node:path'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'

export const name = 'source delivery UI — explicit patch choice and retained-patch application'

export default async function (t) {
  const stage = await startStage({ control: { writes: { implement: { file: 'source.txt', text: 'approved UI change\n' } } } })
  const issue = await stage.createIssue('Deliver approved source')
  const browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${issue.id}`, { token: stage.token })
  try {
    const starts=[]
    const fetch=browser.window.fetch
    browser.window.fetch=(url,options)=>{
      if(options?.method==='POST'&&String(url).endsWith(`/issues/${issue.id}/runs`))starts.push(JSON.parse(options.body))
      return fetch(url,options)
    }
    await browser.clickWhen(() => browser.find('button', 'Run a playbook'))
    await browser.clickWhen(() => browser.all('.pick').find(p => p.querySelector('.pick__id')?.textContent === 'implementation'))
    const select = () => browser.all('select').find(s => s.getAttribute('aria-label') === 'Delivery')
    await browser.until(() => select(), { label: 'delivery choice' })
    t.eq('source update is the default', select().value, 'apply-to-source')
    t.ok('destination visible before start', browser.window.document.body.textContent.includes(path.join(stage.projectsDir, stage.project)))
    select().value = 'worktree-diff'
    select().dispatchEvent(new browser.window.Event('change', { bubbles: true }))
    await browser.until(() => browser.find('button', 'Start run')?.disabled === false && !browser.window.document.body.textContent.includes('Starting this run authorizes'), { label: 'patch-only preview' })
    await browser.clickWhen(() => browser.find('button', 'Start run'))
    await browser.until(()=>starts.length===1,{label:'normal Start click sends its request'})
    t.eq('ordinary click does not request a pre-gate override',starts[0].pregate,undefined)
    await browser.until(()=>!browser.find('button','Start run'),{label:'start dialog closes'})
    await browser.until(() => browser.window.document.body.textContent.includes('Patch ready — source not updated'), { label: 'patch delivered', timeout: 30000 })
    const [record] = await stage.runs(issue.id)
    const run = await stage.run(issue.id, record.runId)
    t.eq('source unchanged in patch mode', await fs.readFile(path.join(stage.projectsDir, stage.project, 'source.txt'), 'utf8'), 'original\n')
    t.ok('download offered', Boolean(browser.find('button', 'Download patch')))
    const base = `/api/projects/${stage.project}/issues/${issue.id}/runs/${run.runId}`
    t.eq('patch downloadable', (await stage.request(`${base}/patch`)).status, 200)
    t.eq('wrong revision refused by HTTP endpoint', (await stage.request(`${base}/apply-artifact`, { method: 'POST', body: JSON.stringify({ expectedRevision: 'wrong' }) })).status, 409)
    await browser.clickWhen(() => browser.find('button', 'Apply patch to project'))
    await browser.until(() => browser.window.document.body.textContent.includes('The patch was applied to the project at'), { label: 'source applied', timeout: 30000 })
    t.eq('original project updated', await fs.readFile(path.join(stage.projectsDir, stage.project, 'source.txt'), 'utf8'), 'approved UI change\n')
    t.eq('no browser errors', browser.problems.length, 0)
  } finally { browser.close() }
}

import fs from 'node:fs/promises'
import path from 'node:path'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'
import { acquire } from '../server/runtime/lock.mjs'

export const name = 'issue close — interrupted and active execution'
export default async function (t) {
  const stage = await startStage()
  const issue = await stage.createIssue('Close interrupted execution')
  const root = `/api/projects/${stage.project}/issues/${issue.id}`
  // Closed means packed: a run's record is read from the archived issue's summary.
  const packedRun = async (id, runId) => (await stage.request(`/api/projects/${stage.project}/issues/${id}`)).body.archive?.runs?.find((r) => r.runId === runId)
  await stage.setControl({ delayMs: 8000 })
  const { body: started } = await stage.request(`${root}/runs`, { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
  await stage.request(`${root}/runs/${started.runId}/stop`, { method: 'POST' })
  const deadline = Date.now() + 30000
  while (['pending', 'preflighting', 'running', 'stopping'].includes((await stage.run(issue.id, started.runId)).status)) {
    if (Date.now() > deadline) throw new Error('run did not stop')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const file = path.join(stage.issuesDir, stage.project, issue.id, 'runs', started.runId, 'run.json')
  const record = JSON.parse(await fs.readFile(file, 'utf8'))
  record.status = 'failed'
  record.blockedReason = 'CLI exited before recording the outcome'
  record.recovery = { required: false }
  const participant = Object.values(record.participants)[0]
  participant.state = 'recovery-required'
  participant.pendingInvocation = { invocationId: 'unfinished', startedAt: new Date().toISOString() }
  await fs.writeFile(file, JSON.stringify(record))
  // A list response arriving after navigation must not start a run request
  // using the destination route's missing issue id.
  const raceBrowser = await openBrowser(`${stage.origin}/projects/${stage.project}/${issue.id}`, { token: stage.token })
  try {
    await raceBrowser.until(() => raceBrowser.has('Abandon run'))
    const requests = []
    let requested = false
    let release
    let delivered
    const gate = new Promise(resolve => { release = resolve })
    const delivery = new Promise(resolve => { delivered = resolve })
    const fetch = raceBrowser.window.fetch
    raceBrowser.window.fetch = async (...args) => {
      requests.push(String(args[0]))
      if (String(args[0]) === `${root}/runs`) {
        requested = true
        await gate
        const response = await fetch(...args)
        delivered()
        return response
      }
      return fetch(...args)
    }
    await raceBrowser.clickWhen(() => raceBrowser.all('button').find(el => el.getAttribute('aria-label') === 'Reload'))
    await raceBrowser.until(() => requested)
    await raceBrowser.clickWhen(() => raceBrowser.all('.issue__crumb a')[0])
    await raceBrowser.until(() => raceBrowser.window.location.pathname === `/projects/${stage.project}`)
    release()
    await delivery
    await new Promise(resolve => setTimeout(resolve, 150))
    t.eq('late issue response never requests a run after leaving', requests.filter(url => /\/runs\//.test(url)), [])
    t.eq('navigation never requests an undefined issue', requests.filter(url => url.includes('/undefined/')), [])
  } finally { raceBrowser.close() }

  let browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${issue.id}`, { token: stage.token })
  try {
    await browser.until(() => browser.has('Interrupted — needs recovery'))
    t.eq('loading run details produces no null access errors', browser.problems.filter(problem => problem.includes('supportedActions')), [])
    t.ok('interrupted status is explicit', browser.has('Interrupted — needs recovery'))
    t.ok('separate abandonment is offered', Boolean(browser.find('button', 'Abandon run')))
    const close = () => browser.all('button').find(el => el.getAttribute('aria-label') === 'Close issue')
    t.ok('Close is enabled for interrupted work', close() && !close().disabled)
    await browser.clickWhen(close)
    await browser.until(() => browser.has('Close and abandon interrupted work?'))
    const confirm = () => browser.all('button').find(el => el.textContent.trim() === 'Close issue')
    const held = await acquire(path.join(stage.issuesDir, stage.project, issue.id, '.run.lock'), { purpose: 'test-owner' })
    try {
      await browser.clickWhen(confirm)
      await browser.until(() => browser.has('Abandonment refused.'))
      t.ok('ownership error appears inside the dialog', browser.all('.v-dialog .v-alert').some(el => el.textContent.includes('Abandonment refused.')))
    } finally { await held.release() }
    await browser.clickWhen(confirm)
    await browser.until(() => browser.window.location.pathname === `/projects/${stage.project}`)
    t.eq('Close abandons and archives without a reason', (await stage.request(root)).body.archived, true)
    t.eq('the run is explicitly cancelled', (await packedRun(issue.id, started.runId))?.status, 'cancelled')

    const active = await stage.createIssue('Stop and close execution')
    const activeRoot = `/api/projects/${stage.project}/issues/${active.id}`
    const { body: next } = await stage.request(`${activeRoot}/runs`, { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
    browser.close()
    browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${active.id}`, { token: stage.token })
    await browser.until(() => browser.has('Stop and close execution'))
    await browser.clickWhen(close)
    await browser.until(() => browser.has('Stop and close this issue?'))
    t.ok('active run Close remains enabled', confirm() && !confirm().disabled)
    await browser.clickWhen(confirm)
    await browser.until(() => browser.window.location.pathname === `/projects/${stage.project}`, { timeout: 40000 }).catch(async error => { throw new Error(error.message + ': ' + browser.all('.v-alert').map(el => el.textContent).join(' | ') + ' run=' + JSON.stringify((await stage.run(active.id, next.runId)).status)) })
    t.eq('active run finishes before archive', (await packedRun(active.id, next.runId))?.status, 'cancelled')
    t.eq('stopped issue is archived', (await stage.request(activeRoot)).body.archived, true)
  } finally { browser.close() }
}

import fs from 'node:fs/promises'
import path from 'node:path'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'
import { patch, occupySeat } from './helpers.mjs'

export const name = 'playbook readiness — blockers, outcomes and execution details'

export default async function (t) {
  const stage = await startStage()
  // implementation, audited by an unverified model and demanding verified
  // evidence; plan-and-implement stays the routine review-only choice.
  const playbook = path.join(stage.configRoot, 'playbooks/implementation.yaml')
  await patch(playbook, 'minimumVerification: review-only', 'minimumVerification: verified')
  await occupySeat(playbook, '  auditor-1:\n    model: gpt-6-astra')
  const roster = path.join(stage.configRoot, 'roster/gpt-6-astra.yaml')
  await patch(roster, 'status: verified', 'status: unverified')
  const issue = await stage.createIssue('Readiness preview')
  const browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${issue.id}`, { token: stage.token })
  try {
    await browser.until(() => browser.has('Readiness preview'))
    await browser.click(browser.find('button', 'Run a playbook'))
    // The dialog lists playbooks alphabetically; the one under test is chosen explicitly.
    await browser.until(() => browser.all('.pick').some((el) => el.textContent.includes('implementation')))
    await browser.click(browser.all('.pick').find((el) => el.textContent.includes('implementation')))
    await browser.until(() => browser.has('Cannot start'))
    t.ok('unverified model disables Start', browser.find('button', 'Start run').disabled)
    t.ok('blocker names the model', browser.has('gpt-6-astra roster entry is unverified'))
    t.ok('completion warning is separately labelled', browser.has('Will not close automatically'))
    t.ok('warning explains cost and unresolved outcome', browser.has('incur costs') && browser.has('leave the issue unresolved'))
    t.eq('routine details are shown expanded', browser.all('.execution-details')[0].open, true)
    t.ok('configured delivery is shown as available', browser.has('Delivery is configured'))
    t.ok('old ambiguous heading removed', !browser.has('Before it can run'))

    await browser.clickWhen(() => browser.find('button', 'Change playbook'))
    await browser.clickWhen(() => browser.all('.pick').find((el) => el.textContent.includes('plan-and-implement')))
    await browser.until(() => !browser.find('button', 'Start run').disabled)
    t.ok('routine notices do not disable Start', !browser.has('Cannot start'))
    t.ok('review-only policy has no unreachable-closure warning', !browser.has('Will not close automatically'))

    await patch(roster, 'status: unverified', 'status: verified')
    await browser.clickWhen(() => browser.find('button', 'Change playbook'))
    await browser.clickWhen(() => browser.all('.pick').find((el) => el.textContent.includes('implementation')))
    await browser.until(() => browser.has('Will not close automatically') && !browser.find('button', 'Start run').disabled)
    t.ok('completion warning alone does not disable Start', !browser.has('Cannot start'))
    t.eq('previewing never invoked the runtime', await fs.readFile(stage.ledger, 'utf8').catch(() => ''), '')
  } finally { browser.close() }
}

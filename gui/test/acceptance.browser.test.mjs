import path from 'node:path'

import { openBrowser } from './browser/harness.mjs'
import { startStage } from './browser/stage.mjs'
import { patch, occupySeat } from './helpers.mjs'

export const name = 'end to end — a person selects, previews, starts and stops a playbook'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const flat = (s) => s.replace(/\s+/g, ' ')

/*
 * The preview has resolved when its participant rows exist.
 *
 * Deliberately not "the page contains the word coordinator": that word belongs to
 * the dialog today and to something else tomorrow — it already moved onto the
 * issue page itself — and a wait that is satisfied by unrelated copy stops
 * waiting for anything.
 */
const previewResolved = (browser) => () => browser.all('.row__role').length >= 3

export default async function (t) {
  const stage = await startStage({ control: { delayMs: 0 } })
  // The stage copies the live playbooks. implementation is run audited and
  // delivered as a patch, not applied to the stage's project checkout; the
  // preview race below tells it from plan-and-implement by their step limits,
  // which are equal in the live catalogue.
  const playbooks = path.join(stage.configRoot, 'playbooks')
  await occupySeat(path.join(playbooks, 'implementation.yaml'), '  auditor-1:\n    model: gpt-6-sol')
  await patch(path.join(playbooks, 'implementation.yaml'), 'action: apply-to-source', 'action: worktree-diff')
  await patch(path.join(playbooks, 'plan-and-implement.yaml'), 'maxSteps: 120', 'maxSteps: 96')
  const page = (id) => `${stage.origin}/projects/${stage.project}/${id}`

  // ------------------------------------------------------------------ 1. auth
  t.section('1. the panel is closed until a token is supplied')
  {
    const issue = await stage.createIssue('Locked out')
    const browser = await openBrowser(page(issue.id))
    await browser.until(() => browser.has('token'), { label: 'the sign-in gate' })

    t.ok('an untokened browser is asked to sign in', browser.has('token'), flat(browser.text()).slice(0, 90))
    t.ok('and no agent content is on the page', !browser.has('Locked out'))
    t.ok('the token is not in the address bar', !browser.window.location.href.includes(stage.token))
    browser.close()
  }

  // ------------------------------------------- 2. selection, preview and start
  t.section('2. select, preview, start')
  const issue = await stage.createIssue('The whole loop')
  const browser = await openBrowser(page(issue.id), { token: stage.token })

  await browser.until(() => browser.has('The whole loop'), { label: 'the issue page' })
  t.ok('the issue opens', browser.has('The whole loop'))
  t.ok('with no runs yet', browser.has('No runs yet'))

  await browser.clickWhen(() => browser.find('button', 'Run a playbook'), { label: 'Run a playbook' })
  await browser.until(() => browser.all('.pick').length > 0, { label: 'the playbook list' })
  t.ok('the first step is the choice, nothing previewed yet', browser.has('Choose a playbook') && !browser.has('Participants'))
  t.ok('and offers no start yet', !browser.find('button', 'Start run'))

  const options = browser.all('.pick').map((el) => flat(el.textContent).trim())
  t.ok('every configured playbook is offered', options.length >= 2, options.join(' | '))
  t.ok('including the one about to be run', options.some((o) => o.startsWith('implementation')))

  // Preview the one that is actually going to run.
  await browser.clickWhen(() => browser.all('.pick').find((el) => el.textContent.includes('implementation')), { label: 'the implementation option' })
  await browser.until(previewResolved(browser), { label: 'resolved participants' })
  t.ok('one click moves on to the settings step', browser.has('Settings for this run') && !browser.all('.pick').length)
  t.ok('which names the chosen playbook', browser.all('.chosen__id')[0]?.textContent === 'implementation')
  const preview = flat(browser.text())

  t.ok('the preview names every participant',
    ['coordinator', 'implementer', 'auditor-1'].every((role) => preview.includes(role)))
  t.ok('with the model each one uses', preview.includes('opus-5-5') && preview.includes('gpt-6-sol'))
  t.ok('and the wire model, which is what is actually sent', preview.includes('claude-opus-5-5'))
  t.ok('the limits it will run under', /maxSteps=\d+/.test(preview) && /wallClockMinutes=\d+/.test(preview))
  t.ok('the round caps per phase', /≤\d/.test(preview))
  t.ok('what completion requires', preview.includes('requires') && preview.includes('sameRevisionApproval'))
  t.ok('routine preflight details are separate', preview.includes('Execution details'))
  t.ok('it says plainly that starting spends money',
    preview.includes('spends money'))
  t.ok('and that the preview itself did not', preview.includes('invoked nothing'))

  // A preview must not have touched the runtime.
  const { readFile } = await import('node:fs/promises')
  const ledgerAfterPreview = await readFile(stage.ledger, 'utf8').catch(() => '')
  t.eq('nothing was invoked to produce it', ledgerAfterPreview, '')

  // Slow the runtime down, so the run is observable while it is running and so
  // that "stopping" lasts long enough to be a state a person could see.
  await stage.setControl({ delayMs: 1500, hangOnAbortMs: 2500 })

  await browser.clickWhen(() => browser.find('button', 'Start run'), { label: 'Start run' })
  await browser.until(() => !browser.has('Starting invokes real agents'), { label: 'the dialog to close' })

  // A run exists, and is stoppable, before the paid probes have finished.
  await browser.until(() => browser.has('preflighting') || browser.has('running'),
    { label: 'a live run' })
  t.ok('the run is visible before it has spent anything',
    browser.has('preflighting') || browser.has('running'))
  await browser.until(() => browser.has('running'), { label: 'the first turn' })

  const [listed] = await stage.runs(issue.id)
  t.ok('a run exists on the server', Boolean(listed), listed?.runId)
  t.ok('and the page shows its id', browser.has(listed.runId), listed.runId)
  t.ok('reporting it as running', browser.has('running'))
  t.ok('with the playbook that was chosen', browser.has('implementation'))
  t.ok('and a stop control', Boolean(browser.find('button', 'Stop run')))
  t.ok('no start control while one is live', !browser.find('button', 'Start run'))

  // ------------------------------------------------- 3. it is not the browser
  t.section('3. the run belongs to the server, not to this browser')
  {
    const before = (await stage.run(issue.id, listed.runId)).timeline.length
    browser.close()

    // Progress, not merely survival: the turn count has to move while no browser
    // is attached at all.
    const advanced = await (async () => {
      const deadline = Date.now() + 20000
      for (;;) {
        const run = await stage.run(issue.id, listed.runId)
        if (run.timeline.length > before) return run
        if (run.status !== 'running') return run
        if (Date.now() > deadline) throw new Error('the run made no progress unattended')
        await sleep(150)
      }
    })()

    t.ok('closing the browser does not stop it', ['running', 'stopping'].includes(advanced.status), advanced.status)
    t.ok('and it kept working while nothing was watching', advanced.timeline.length > before,
      `${before} turns before, ${advanced.timeline.length} after`)
  }

  // --------------------------------------------------------- 4. a new browser
  t.section('4. a browser that arrives mid-run reconstructs the run')
  const second = await openBrowser(page(issue.id), { token: stage.token })
  await second.until(() => second.has(listed.runId), { label: 'the run to be found again' })

  const server = await stage.run(issue.id, listed.runId)
  t.ok('it finds the run it never started', second.has(listed.runId))
  t.ok('and its status', second.has(server.status), server.status)
  t.ok('the turns already recorded are all there',
    server.timeline.every((turn) => second.has(String(turn.number))),
    `${server.timeline.length} turns`)
  t.ok('an in-flight turn is shown as awaited, not as partial output',
    !server.active.length || second.has('awaiting a reply'))

  // ---------------------------------------------------------- 5. stop, slowly
  t.section('5. stop stays "Stopping" until termination is confirmed')
  {
    await second.until(() => Boolean(second.find('button', 'Stop run')), { label: 'a stop control' })
    await second.clickWhen(() => second.find('button', 'Stop run'), { label: 'Stop run' })

    await second.until(() => second.has('Stopping'), { label: 'the stopping state' })
    t.ok('the button becomes Stopping', second.has('Stopping'))
    t.ok('and says what it is waiting for', second.has('confirm they have stopped'))

    const disabled = second.all('button').filter((b) => b.textContent.includes('Stopping'))
    t.ok('the control is spent while it settles',
      disabled.every((b) => b.disabled || b.getAttribute('aria-disabled') === 'true'))

    // Clicking again is the normal impatient case and must change nothing.
    for (const button of disabled) await second.click(button)
    const repeated = await stage.request(
      `/api/projects/${stage.project}/issues/${issue.id}/runs/${listed.runId}/stop`, { method: 'POST' })
    t.eq('a repeated stop is accepted', repeated.status, 200)

    await second.until(() => second.has('cancelled'), { label: 'the run to settle', timeout: 20000 })
    t.ok('it settles as cancelled', second.has('cancelled'))
    t.ok('and the stopping notice is gone', !second.has('Stopping'))
    t.ok('a new run is offered again', Boolean(second.find('button', 'Run a playbook')))
    second.close()
  }

  // ----------------------------------------- 6. losing the socket mid-stopping
  t.section('6. a connection lost while stopping does not lose the run')
  {
    const other = await stage.createIssue('Lost while stopping')
    await stage.setControl({ delayMs: 1500, hangOnAbortMs: 2500 })

    const view = await openBrowser(page(other.id), { token: stage.token })
    await view.until(() => view.has('Lost while stopping'), { label: 'the issue page' })
    await view.clickWhen(() => view.find('button', 'Run a playbook'), { label: 'Run a playbook' })
    await view.clickWhen(() => view.all('.pick').find((el) => el.textContent.includes('implementation')), { label: 'the implementation option' })
    await view.until(previewResolved(view), { label: 'resolved participants' })
    await view.clickWhen(() => view.find('button', 'Start run'), { label: 'Start run' })
    await view.until(() => view.has('running'), { label: 'a live run', timeout: 20000 })

    const [live] = await stage.runs(other.id)
    await view.until(() => Boolean(view.find('button', 'Stop run')), { label: 'a stop control' })
    await view.clickWhen(() => view.find('button', 'Stop run'), { label: 'Stop run' })
    await view.until(() => view.has('Stopping'), { label: 'the stopping state' })

    // The connection dies mid-stop — both transports, so socket.io cannot fall
    // back to polling. The server is never told.
    view.setOffline(true)

    await view.until(() => view.has('Connection lost'), { label: 'the stale-view notice', timeout: 15000 })
    t.ok('the page says its view has gone stale', view.has('Connection lost'))
    t.ok('and that the run is still going on the server', view.has('run continues on the server'))
    t.ok('it still shows the run it was watching', view.has(live.runId))
    t.ok('and does not pretend the run ended', !view.has('cancelled'))

    // Meanwhile, the run settles on the server regardless of who is watching.
    const settled = await (async () => {
      const deadline = Date.now() + 25000
      for (;;) {
        const run = await stage.run(other.id, live.runId)
        if (run.status !== 'stopping' && run.status !== 'running') return run
        if (Date.now() > deadline) throw new Error('the run never settled')
        await sleep(120)
      }
    })()
    t.eq('the stop completed without a browser', settled.status, 'cancelled')

    // The cable is reconnected. Nothing was buffered for this page; it re-reads.
    view.setOffline(false)
    await view.until(() => view.has('cancelled'), { label: 'the reconnected view', timeout: 25000 })
    t.ok('reconnecting converges on the true state', view.has('cancelled'))
    t.ok('and the stale notice clears', !view.has('Connection lost'))
    t.ok('with the turns that ran while it was cut off', view.has(live.runId))

    // And a browser that was never here reconstructs the same thing from disk.
    const fresh = await openBrowser(page(other.id), { token: stage.token })
    await fresh.until(() => fresh.has('cancelled'), { label: 'the settled state', timeout: 20000 })
    t.ok('a fresh browser reconstructs the same run', fresh.has(live.runId))
    t.ok('in the same state', fresh.has('cancelled'))
    t.ok('with no leftover stopping notice', !fresh.has('Stopping'))
    fresh.close()
    view.close()
  }

  // ------------------------------------------------------- 7. a start that fails
  t.section('7. a start that cannot happen says so, inside the run')
  {
    const broken = await stage.createIssue('Start refused')
    await stage.setControl({ delayMs: 0, modelAccess: 'unreachable', modelDetail: 'no route to the provider' })

    const view = await openBrowser(page(broken.id), { token: stage.token })
    await view.until(() => view.has('Start refused'), { label: 'the issue page' })
    await view.clickWhen(() => view.find('button', 'Run a playbook'), { label: 'Run a playbook' })
    await view.clickWhen(() => view.all('.pick').find((el) => el.textContent.includes('implementation')), { label: 'the implementation option' })
    await view.until(previewResolved(view), { label: 'resolved participants' })
    await view.clickWhen(() => view.find('button', 'Start run'), { label: 'Start run' })

    // The refusal is only knowable by probing, which costs — so the run exists
    // first, and fails inside itself where the receipt can be kept.
    await view.until(() => view.has('failed'), { label: 'the failed run', timeout: 20000 })
    const shown = flat(view.text())
    t.ok('the page shows a failed run', shown.includes('failed'))
    // Said in words rather than as the code: the page explains the refusal.
    t.ok('naming preflight as the reason', shown.includes('failed their pre-start check'))
    // Read the cell, not the whole page: adjacent block elements concatenate
    // without spaces in textContent, and a regex over that is a coin toss.
    const cell = view.all('.kv').find((el) => el.textContent.includes('Preflight'))
    t.ok('the preflight cell reports the refusal', /refused/.test(cell?.textContent ?? ''), flat(cell?.textContent ?? ''))
    t.ok('and how many probes it made', /\d+ probe/.test(cell?.textContent ?? ''))

    const [recorded] = await stage.runs(broken.id)
    t.eq('the run is recorded, not discarded', recorded.status, 'failed')
    t.ok('with the probe attempts kept', recorded.preflight.attempts > 0, `${recorded.preflight.attempts}`)
    t.ok('and the issue is offered a new run', Boolean(view.find('button', 'Run a playbook')))
    view.close()
  }

  // ------------------------------------------- 7b. previews that answer late
  t.section('7b. the preview on screen is the preview of what would start')
  {
    const quiet = await stage.createIssue('Preview races')
    await stage.setControl({ delayMs: 0 })

    const view = await openBrowser(page(quiet.id), { token: stage.token })
    await view.until(() => view.has('Preview races'), { label: 'the issue page' })

    // plan-and-implement answers slowly; implementation answers at once.
    view.stall(/\/api\/playbooks\/plan-and-implement\/preview/, 2500)

    await view.clickWhen(() => view.find('button', 'Run a playbook'), { label: 'Run a playbook' })

    // Pick the slow one first.
    await view.clickWhen(() => view.all('.pick').find((el) => el.textContent.includes('plan-and-implement')), { label: 'the plan-and-implement option' })
    await view.until(() => view.has('Resolving'), { label: 'a preview in flight' })
    t.ok('Start is refused while the preview is in flight',
      view.find('button', 'Start run')?.disabled === true)

    // Go back and pick the fast one while the slow one is still outstanding.
    await view.clickWhen(() => view.find('button', 'Change playbook'), { label: 'Change playbook' })
    t.ok('the list is back with the earlier choice marked', view.all('.pick--on')[0]?.textContent.includes('plan-and-implement'))
    await view.clickWhen(() => view.all('.pick').find((el) => el.textContent.includes('implementation')), { label: 'the implementation option' })
    await view.until(() => view.has('maxSteps=120'), { label: "implementation's limits" })
    t.ok('the fast preview is shown', view.has('maxSteps=120'))
    t.ok('and Start is available again', view.find('button', 'Start run')?.disabled === false)

    // Now let the slow one land. It is an answer to a question nobody is asking.
    await sleep(3000)
    const after = flat(view.text())
    t.ok('the late reply does not replace what is shown', after.includes('maxSteps=120'))
    t.ok('and the other playbook\u2019s limits never appear', !after.includes('maxSteps=96'))

    // Reopening on the same selection must refetch, not show an empty preview.
    view.clearStalls()
    await view.clickWhen(() => view.find('button', 'Cancel'), { label: 'Cancel' })
    await view.until(() => !view.has('Participants'), { label: 'the dialog to close' })
    await view.clickWhen(() => view.find('button', 'Run a playbook'), { label: 'Run a playbook' })
    await view.until(() => view.all('.pick').length > 0, { label: 'the playbook list again' })
    t.ok('a reopened dialog starts at the choice again', view.has('Choose a playbook') && !view.all('.pick--on').length)
    await view.clickWhen(() => view.all('.pick').find((el) => el.textContent.includes('implementation')), { label: 'the implementation option' })
    await view.until(() => view.has('Participants'), { label: 'the preview again' })
    t.ok('a reopened dialog shows a preview', view.has('coordinator'))
    t.ok('and Start is usable', view.find('button', 'Start run')?.disabled === false)
    view.close()
  }

  // --------------------------------------- 7c. a preview that stops matching
  t.section('7c. a start is bound to the configuration that was previewed')
  {
    const issueC = await stage.createIssue('Config moved')
    await stage.setControl({ delayMs: 0 })

    const stale = await stage.request(`/api/projects/${stage.project}/issues/${issueC.id}/runs`, {
      method: 'POST',
      body: JSON.stringify({ playbook: 'implementation', configHash: 'sha256:not-the-hash-you-were-shown' })
    })
    t.eq('a start pinned to a different configuration is refused', stale.status, 409)
    t.ok('and says to look again', /previewed|changed/.test(stale.body.error), stale.body.error)
    t.eq('nothing was reserved for it', (await stage.runs(issueC.id)).length, 0)

    const preview = await stage.request(
      `/api/playbooks/implementation/preview?project=${stage.project}&issue=${issueC.id}`)
    const good = await stage.request(`/api/projects/${stage.project}/issues/${issueC.id}/runs`, {
      method: 'POST',
      body: JSON.stringify({ playbook: 'implementation', configHash: preview.body.configHash })
    })
    t.eq('the hash from the preview is accepted', good.status, 201)
    await (async () => {
      const deadline = Date.now() + 25000
      for (;;) {
        const [run] = await stage.runs(issueC.id)
        if (run && !['preflighting', 'pending', 'running', 'stopping'].includes(run.status)) return
        if (Date.now() > deadline) throw new Error('the run never settled')
        await sleep(120)
      }
    })()
  }

  // ------------------------------------------------- 7d. the dashboard overview
  t.section('7d. the dashboard lists the agents that are working right now')
  {
    const watched = await stage.createIssue('Seen from the dashboard')
    // Long turns, so the agent is reliably still working when the page is read.
    await stage.setControl({ delayMs: 15000, hangOnAbortMs: 200 })

    t.eq('no run is live before this starts', (await stage.request('/api/agents')).body.length, 0)

    const dash = await openBrowser(`${stage.origin}/`, { token: stage.token })
    await dash.until(() => dash.has('Running agents'), { label: 'the overview panel' })
    // The panel heading renders before its contents arrive; asserting on the
    // heading alone would read the empty state that has not been decided yet.
    await dash.until(() => !dash.has('Looking…'), { label: 'the list to load' })
    t.ok('the overview says so when nothing is running', dash.has('No agents are running'))

    await stage.request(`/api/projects/${stage.project}/issues/${watched.id}/runs`, {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    const [live] = await stage.runs(watched.id)

    // Started from somewhere else entirely: the dashboard has to notice.
    await dash.until(() => dash.has('coordinator'), { label: 'an agent to appear', timeout: 30000 })
    const shown = flat(dash.text())

    t.ok('the issue it is working on is named', shown.includes('Seen from the dashboard'))
    t.ok('and the playbook', shown.includes('implementation'))
    t.ok('the role of the agent', shown.includes('coordinator'))
    t.ok('the model it is using', shown.includes('opus-5-5'))
    t.ok('the model actually sent to the runtime', shown.includes('claude-opus-5-5'))
    t.ok('and what it is working on', shown.includes('triage'))
    t.ok('no partial output is implied', !shown.includes('…streaming'))

    // Inspectable: the row opens the run it names, not merely the issue.
    const link = dash.all('a').find((el) => el.textContent.includes('Seen from the dashboard'))
    t.ok('the entry links somewhere', Boolean(link), link?.getAttribute('href'))
    t.ok('to that exact run', (link?.getAttribute('href') ?? '').includes(live.runId), link?.getAttribute('href'))

    await dash.click(link)
    await dash.until(() => dash.has(live.runId), { label: 'the run page', timeout: 20000 })
    t.ok('and opens it', dash.has(live.runId))
    await dash.until(() => dash.has('awaiting a reply'), { label: 'the in-flight turn', timeout: 20000 })
    t.ok('showing the turn as awaited, not as output', dash.has('awaiting a reply'))

    // Stopping it removes it from the dashboard rather than leaving a spinner.
    await stage.request(
      `/api/projects/${stage.project}/issues/${watched.id}/runs/${live.runId}/stop`, { method: 'POST' })
    await dash.goto('/')
    await dash.until(() => dash.has('No agents are running'), { label: 'the list to empty', timeout: 30000 })
    t.ok('a run that stopped is no longer listed as working', dash.has('No agents are running'))
    dash.close()
  }

  // ----------------------------------------------- 7e. the measurement is readable
  t.section('7e. every turn shows how long the agent took')
  {
    const timed = await stage.createIssue('Timed turns')
    await stage.setControl({ delayMs: 400 })

    await stage.request(`/api/projects/${stage.project}/issues/${timed.id}/runs`, {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    const settled = await (async () => {
      const deadline = Date.now() + 40000
      for (;;) {
        const [run] = await stage.runs(timed.id)
        if (run && !['preflighting', 'pending', 'running', 'stopping'].includes(run.status)) return run
        if (Date.now() > deadline) throw new Error('the run never settled')
        await sleep(150)
      }
    })()
    t.eq('the run completed', settled.status, 'completed')

    const detail = await stage.run(timed.id, settled.runId)
    t.ok('every turn carries a start', detail.timeline.every((x) => Boolean(x.timing.startedAt)))
    t.ok('an end', detail.timeline.every((x) => Boolean(x.timing.endedAt)))
    t.ok('and a duration', detail.timeline.every((x) => Number.isFinite(x.timing.durationMs)))
    t.ok('measured near what the runtime actually took',
      detail.timeline.every((x) => x.timing.durationMs >= 380 && x.timing.durationMs < 3000),
      [...new Set(detail.timeline.map((x) => x.timing.durationMs))].join(', '))
    t.eq('and the run total is their sum', detail.timing.agentMs,
      detail.timeline.reduce((n, x) => n + x.timing.durationMs, 0))

    const view = await openBrowser(page(timed.id), { token: stage.token })
    await view.until(() => view.has('Timed turns'), { label: 'the issue page' })
    await view.until(() => view.has('in agents'), { label: 'the run summary' })

    const shown = flat(view.text())
    t.ok('the summary reports time spent in agents', /\d\d:\d\d:\d\d in agents/.test(shown),
      shown.match(/[^ ]+ in agents/)?.[0])

    // Every row in the timeline carries its own measurement.
    const durations = view.all('.turn__took').map((el) => el.textContent.trim())
    t.eq('every turn in the timeline shows one', durations.length, detail.timeline.length)
    t.ok('as a real figure rather than a dash, in hh:mm:ss', durations.every((d) => /^\d\d:\d\d:\d\d( · [<\d.]+ M tokens)?$/.test(d)),
      durations.join(' '))

    // And the detail panel gives the two timestamps behind it.
    await view.clickWhen(() => view.all('.turn').find((el) => el.textContent.includes('triage')),
      { label: 'the first turn' })
    await view.until(() => view.has('Took'), { label: 'the turn detail' })
    const facts = view.all('.facts__row').find((el) => el.textContent.includes('Took'))
    t.ok('the detail names how long it took', /\d/.test(facts?.textContent ?? ''), flat(facts?.textContent ?? ''))
    t.ok('and the two clock times behind it', (facts?.textContent ?? '').includes('→'), flat(facts?.textContent ?? ''))
    view.close()
  }

  // ------------------------------------------------------------ 8. no surprises
  t.section('8. the page behaved')
  {
    const view = await openBrowser(page(issue.id), { token: stage.token })
    await view.until(() => view.has(listed.runId), { label: 'the run' })
    // Agent Markdown uses safe Vue nodes; embedded source HTML remains text.
    t.eq('nothing was logged as an error', view.problems, [])
    view.close()
  }

  await stage.stop()
}

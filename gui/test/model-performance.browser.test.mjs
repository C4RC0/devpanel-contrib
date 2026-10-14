import fs from 'node:fs/promises'
import path from 'node:path'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'

export default async function (t) {
  const stage = await startStage()
  // Only this isolated stage's fake adapter; no production adapter is present.
  await fs.writeFile(path.join(stage.harnessDir, 'fake.mjs'), `
    import fs from 'node:fs/promises'
    export async function invoke(args) {
      await fs.appendFile(${JSON.stringify(stage.ledger)}, JSON.stringify({model:args.model})+'\\n')
      args.observe.onActivity({kind:'system'})
      await new Promise(resolve=>setTimeout(resolve,80))
      args.observe.onActivity({kind:'text'})
      return {response:'A peaceful walk in the park. '.repeat(34),outcome:'completed',usage:{tokens:300,outputTokens:280,costUsd:null}}
    }
  `)
  const first = (await stage.request('/api/availability')).body
  t.eq('GET does not measure', first.performance.refresh, null)
  const held = first.models[0].id
  await stage.request(`/api/availability/${held}`, { method:'POST', body:JSON.stringify({ until:new Date(Date.now()+3600000).toISOString(),actor:'test',reason:'hold' }) })
  const browser = await openBrowser(`${stage.origin}/models`, {token:stage.token})
  try {
    await browser.until(()=>browser.has('Not measured'))
    t.ok('timing and token rate columns shown', ['Startup','Response','Total','Tokens/s','Response length'].every(label=>browser.has(label)))
    await browser.clickWhen(()=>browser.all('button').find(el=>el.getAttribute('aria-label')==='Refresh and measure models'))
    await browser.until(()=>browser.has('Measuring'))
    t.ok('refresh disabled during batch', browser.all('button').find(el=>el.getAttribute('aria-label')==='Refresh and measure models')?.disabled)
    let ongoing
    const deadline = Date.now() + 8000
    while (!ongoing) {
      ongoing=(await stage.request('/api/availability')).body.performance.refresh
      if (Date.now() > deadline) throw new Error('Refresh did not start')
      if (!ongoing) await new Promise(resolve=>setTimeout(resolve,10))
    }
    const duplicate=await stage.request('/api/availability/refresh',{method:'POST'})
    t.eq('POST accepted asynchronously',duplicate.status,202)
    t.eq('duplicate POST joins same refresh',duplicate.body.performance.refresh.id,ongoing.id)
    await browser.until(()=>browser.has('Last refresh: completed'),{timeout:20000})
    const done=(await stage.request('/api/availability')).body
    const eligible=done.models.filter(m=>m.id!==held)
    t.ok('eligible models have successful samples',eligible.every(m=>m.performance?.status==='ok'))
    t.eq('held model skipped',done.models.find(m=>m.id===held).performance,null)
    t.eq('each model invoked once',(await fs.readFile(stage.ledger,'utf8')).trim().split('\n').length,eligible.length)
    t.ok('timings rendered in seconds',browser.all('.models__timing').some(el=>/\d+\.\d+ s/.test(el.textContent)))
    t.ok('output token rates rendered',browser.all('.models__timing').some(el=>/\d+\.\d+ tok\/s/.test(el.textContent)))
    t.ok('actual response length rendered', browser.has('204 words') && browser.has('280 output tokens'))
    t.eq('no render errors',browser.problems.filter(p=>/TypeError|ReferenceError/.test(p)),[])
    const before=done.models.find(m=>m.performance)?.performance.measuredAt
    await stage.restart({signal:'SIGTERM'})
    const after=(await stage.request('/api/availability')).body
    t.eq('restart preserves measurements',after.models.find(m=>m.performance)?.performance.measuredAt,before)
  } finally {browser.close();await stage.stop()}
}

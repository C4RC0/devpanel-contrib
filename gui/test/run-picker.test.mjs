import { startStage } from './browser/stage.mjs'
import { launchChromium } from './browser/chromium.mjs'
export default async function (t) {
 const stage=await startStage({control:{script:{fitVerdict:false}}})
 const issue=await stage.createIssue('Run picker')
 for(let i=0;i<2;i++) {
  const res=await stage.request(`/api/projects/${stage.project}/issues/${issue.id}/runs`,{method:'POST',body:JSON.stringify({playbook:'implementation'})})
  if(res.status!==201) throw Error(JSON.stringify(res))
  const end=Date.now()+15000
  while((await stage.run(issue.id,res.body.runId)).status!=='completed') {if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,50))}
 }
 const chrome=await launchChromium();if(!chrome.ok){t.skip('run picker in Chromium',chrome.reason);await stage.stop();return}
 const context=await chrome.browser.newContext();const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message))
 try {
 await page.goto(stage.origin);await page.evaluate(token=>sessionStorage.setItem('devpanel.token',token),stage.token)
 await page.goto(`${stage.origin}/projects/${stage.project}/${issue.id}`)
 await page.waitForSelector('.runs__select');
 const runs=await stage.runs(issue.id)
 t.ok('selected run uses a readable playbook title',await page.locator('.runs__select').textContent().then(s=>s.includes('Implementation') && !s.includes(runs[0].runId)))
 await page.locator('.runs__select').click();
 await page.waitForSelector('[role="option"]',{timeout:3000})
 t.ok('menu titles are readable', (await page.locator('[role="option"]').allTextContents()).every(s=>s.includes('Implementation') && !runs.some(r=>s.includes(r.runId))))
 t.eq('both runs are selectable',await page.locator('[role="option"]').count(),2)
 await page.locator('[role="option"]').nth(1).click()
 await page.waitForFunction(id=>document.querySelector('.runs__select input[type=hidden]')?.value === id,runs[1].runId)
 t.ok('older run selected',true)
 t.eq('no browser errors',errors,[])
 }finally{await context.close();await stage.stop()}
}

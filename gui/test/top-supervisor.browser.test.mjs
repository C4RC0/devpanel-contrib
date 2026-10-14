import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'
export default async function(t){
 const stage=await startStage()
 const modelFile=path.join(stage.configRoot,'roster/opus-5.yaml')
 const model=YAML.parse(await fs.readFile(modelFile,'utf8'));model.harness='claude';model.verification.status='verified';await fs.writeFile(modelFile,YAML.stringify(model))
 await fs.writeFile(path.join(stage.harnessDir,'claude.mjs'),`export async function invoke(args){return {session:args.session??{id:'browser-supervisor-session'},response:JSON.stringify({message:'I am coordinating your issues.',action:null}),usage:{costUsd:null}}}`)
 const api=(url,body)=>stage.request('/api/supervisor'+url,body?{method:'POST',body:JSON.stringify(body)}:{})
 const until=async fn=>{const end=Date.now()+8000;while(!await fn()){if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,20))}}
 try{
 t.eq('supervisor begins stopped',(await api('')).body.status,'stopped')
 t.eq('supervisor API requires auth',(await fetch(stage.origin+'/api/supervisor')).status,401)
 t.eq('model endpoint lists verified coordinator',(await api('/models')).body[0].id,'opus-5')
 const browser=await openBrowser(stage.origin+'/supervisor',{token:stage.token})
 const dashboard=await openBrowser(stage.origin+'/',{token:stage.token})
 try{
  const overview=()=>dashboard.window.document.querySelector('[aria-label="Supervisor overview"]')
  await dashboard.until(()=>overview()?.textContent.includes('No supervisor session yet'))
  t.ok('dashboard includes supervisor and agents',dashboard.has('Running agents'))
  t.eq('dashboard links to supervisor',overview().querySelector('a').getAttribute('href'),'/supervisor')
  await browser.until(()=>browser.has('Start supervisor'))
  t.ok('top-level navigation visible',browser.has('Supervisor'))
  t.ok('scope required to start',browser.find('button','Start supervisor').disabled)
  const result=await api('/start',{model:'opus-5',projects:[stage.project],message:'Look after the queue',limits:{maxCalls:4,maxRuns:1,maxConcurrent:1}})
  t.eq('start returns promptly',result.status,201)
  await browser.until(()=>browser.has('I am coordinating your issues.'))
  await dashboard.until(()=>overview()?.textContent.includes('I am coordinating your issues.'))
  t.ok('dashboard shows supervisor mission',overview().textContent.includes('Look after the queue'))
  t.ok('dashboard shows supervisor model and scope',overview().textContent.includes('opus-5')&&overview().textContent.includes(stage.project))
  await dashboard.clickWhen(()=>dashboard.find('button','Refresh'))
  t.ok('overview refresh is available',true)
  t.ok('assistant response appears in chat',true)
  const realFetch=browser.window.fetch
  let failRefresh=true
  browser.window.fetch=(input,init)=>String(input)==='/api/supervisor' && failRefresh
    ? Promise.resolve(new browser.window.Response(JSON.stringify({error:'503 temporary outage'}),{status:503,headers:{'Content-Type':'application/json'}}))
    : realFetch(input,init)
  await browser.until(()=>browser.has('503 temporary outage'),{timeout:12000})
  failRefresh=false
  await browser.until(()=>!browser.has('503 temporary outage'),{timeout:12000})
  t.ok('transient 503 clears after successful refresh',!browser.has('503 temporary outage'))
  browser.window.fetch=realFetch

  await api('/messages',{text:'Explain your priorities'})
  await until(async()=>(await api('')).body.messages.filter(m=>m.role==='assistant').length===2)
  await browser.until(()=>browser.has('Explain your priorities'))
  t.ok('user chat persists on page',true)
  await browser.clickWhen(()=>browser.find('button','Stop supervisor'))
  await browser.until(()=>browser.has('Continue supervisor'))
  await dashboard.until(()=>overview()?.querySelector('[role="status"]')?.textContent==='stopped')
  t.ok('dashboard follows supervisor stop and retains latest update',overview().textContent.includes('I am coordinating your issues.'))
  t.eq('stopped session identity retained',(await api('')).body.session.id,'browser-supervisor-session')
  await stage.restart()
  t.eq('restart retains chat',(await api('')).body.messages.filter(m=>m.role==='assistant').length,2)
  t.eq('restart does not spend',(await api('')).body.status,'stopped')
 }finally{dashboard.close();browser.close()}
 }finally{await stage.stop()}
}

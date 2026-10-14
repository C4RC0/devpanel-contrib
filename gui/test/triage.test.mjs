import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { engineFixture } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { runResult } from '../server/runtime/run-result.mjs'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'

const start = f => startRun({ playbookId:f.playbookId, issue:{...f.issue,project:'devpanel-project'}, issuePath:f.issuePath, projectPath:f.projectPath, harnesses:f.harnesses, stepStore:f.stepStore, workspaceProvider:f.workspaceProvider, configRoot:f.configRoot, probe:f.probe, clock:f.clock, deliveryProvider:f.delivery })
const brief = {targetRole:'investigator',prompt:'Verify the reported write and cite the source evidence.'}
const withBrief = fn => turn => turn.role === 'coordinator' ? JSON.stringify(brief) : fn(turn)
const response = disposition => ({disposition,reasoning:'Source establishes the claim.',response:disposition === 'needs-information' ? 'Which source revision contains the reported write?' : 'Checked the reported write at source.txt:1.',issues:[]})

export default async function(t) {
  t.section('coordinate once, then return the investigator result directly')
  let f
  const seen=[]
  f=await engineFixture({playbook:'triage',script:turn=>{
    seen.push(turn)
    if (turn.role === 'coordinator') return JSON.stringify(brief)
    return JSON.stringify({...response('accepted'),issues:[{key:'reported-write',kind:'bug',title:'Missing mode',description:'The key write has no mode.',evidence:['source.txt:1'],acceptanceCriteria:['Write keys with restricted permissions'],existingIssue:f.issue.id}]})
  }})
  const invoked=[]
  const invoke=f.harnesses.fake.invoke
  f.harnesses.fake.invoke=options=>{invoked.push(options);return invoke(options)}
  const e=await start(f)
  await e.drive()
  t.eq('exactly one handoff and one investigation',seen.map(s=>[s.role,s.stepId]),[['coordinator','brief'],['investigator','investigate']])
  t.eq('coordinator tools disabled through adapter mode',invoked[0].supervisorOnly,true)
  t.eq('coordinator starts outside source',invoked[0].cwd,path.join(e.run.workspace.scratchPath,'coordinator'))
  t.eq('coordinator receives no source tooling policy',invoked[0].tooling,null)
  t.eq('investigator retains tools',invoked[1].supervisorOnly,false)
  t.ok('investigator receives the handoff',seen[1].prompt.includes(brief.prompt))
  t.eq('coordinator does not receive scratch or infrastructure work instructions',seen[0].prompt.includes('Scratch directory for temporary files'),false)
  t.eq('coordinator is not instructed to read the manifest',seen[0].prompt.includes('Read window.json'),false)
  t.eq('run completes without implementing acceptance criteria',e.run.status,'completed')
  t.eq('recorded disposition satisfies closure',e.run.closure.conditions,{reportDispositionRecorded:true,deliveryCompleted:true})
  t.eq('no code candidate',e.run.revisions,[])
  t.eq('no closing candidate fingerprint',e.run.closure.revision,null)
  t.eq('no delivery calls',f.delivery.calls.length,0)
  t.eq('report links original issue',e.run.reportDisposition.issues[0].issueId,f.issue.id)
  t.eq('issue stays open',(await f.issues.getIssue('devpanel-project',f.issue.id)).status,'open')
  t.eq('human result',runResult(e.run,e.outputs).resultLabel,'Confirmed — ready for implementation')
  t.ok('prompt exposes output limits',seen[1].prompt.includes('at most 800 characters'))
  t.eq('default run guard is five minutes',e.run.budgets.limits.wallClockMinutes,5)
  // Effects replay must not append the same finding again.
  const before=(await fs.readdir(f.issuePath)).length
  await e.applyCoordinatorEffects()
  t.eq('publication is replay safe',(await fs.readdir(f.issuePath)).length,before)
  const legacy={...e.run,status:'blocked',outcome:'unresolved',blockedReason:'closure-conditions-unmet',closure:{conditions:{coordinatorConfirmation:false}}}
  t.eq('historical failure is explained without rewriting outcome',runResult(legacy,e.outputs).resultReason,'triage-completion-mismatch')
  t.eq('historical run reads incomplete',runResult(legacy,e.outputs).result,'incomplete')
  t.eq('runtime failures never become accepted',runResult({...legacy,blockedReason:'recovery-required'},e.outputs).result,'incomplete')
  await releaseWorkspace(e)

  t.section('the browser leads with a short result and collapses technical detail')
  const stage=await startStage()
  const copied=path.join(stage.issuesDir,stage.project,f.issue.id)
  await fs.cp(f.issuePath,copied,{recursive:true})
  let browser=await openBrowser(`${stage.origin}/projects/${stage.project}/${f.issue.id}`,{token:stage.token})
  try {
    await browser.until(()=>browser.has('Confirmed — ready for implementation'))
    t.ok('result includes evidence',browser.all('.status')[0]?.textContent.includes('source.txt:1'))
    t.eq('technical details start collapsed',browser.all('.tech')[0]?.open,false)
    t.ok('the timeline is on screen without expanding anything',browser.all('.turn').length>0)
    t.eq('no client errors',browser.problems,[])
  } finally { browser.close() }
  const old={...legacy,workspace:{...e.run.workspace,state:'retained',retainedReason:'unsuccessful tactical run retained for recovery'}}
  await fs.writeFile(path.join(copied,'runs',e.runId,'run.json'),JSON.stringify(old))
  browser=await openBrowser(`${stage.origin}/projects/${stage.project}/${f.issue.id}`,{token:stage.token})
  try {
    await browser.until(()=>browser.has('Confirmed — triage completion blocked'))
    t.ok('old closure bug is explained',browser.all('.status')[0]?.textContent.includes('implementation criteria'))
    browser.all('.tech')[0].open=true
    t.ok('retained snapshot is not called a candidate',browser.has('No code candidate was produced.'))
    t.eq('no false candidate claim',browser.has('The candidate this run produced'),false)
  } finally { browser.close();await stage.stop() }

  t.section('unanswered questions and invalid reports end without more agents')
  for (const disposition of ['needs-information','rejected','no-findings']) {
    const f=await engineFixture({playbook:'triage',script:withBrief(()=>JSON.stringify(response(disposition)))})
    const e=await start(f);await e.drive()
    t.eq(`${disposition} completes without coordinator re-review`,e.run.steps.length,2)
    t.eq(`${disposition} is a completed assessment`,e.run.status,'completed')
    t.eq(`${disposition} creates no issues`,e.run.reportDisposition.issues,[])
    t.eq(`${disposition} is preserved in the result`,runResult(e.run,e.outputs).result,disposition)
    await releaseWorkspace(e)
  }

  t.section('verbosity is bounded and repair cannot loop')
  const bad={...response('no-findings'),response:'x'.repeat(801)}
  const b=await engineFixture({playbook:'triage',script:withBrief(()=>JSON.stringify(bad))})
  const be=await start(b);await be.drive()
  t.eq('one handoff and at most one investigator repair',be.run.steps.length,3)
  t.eq('exhausted repair is a real failure',be.run.blockedReason,'protocol-repair-exhausted')
  t.eq('invalid output publishes nothing',be.run.reportDisposition,undefined)
  await releaseWorkspace(be)
  let calls=0
  const r=await engineFixture({playbook:'triage',script:withBrief(()=>++calls===1?'invalid':JSON.stringify(response('no-findings')))})
  const re=await start(r);await re.drive()
  t.eq('valid investigator repair completes',re.run.status,'completed')
  t.eq('no extra confirmation invocation',calls,2)
  await releaseWorkspace(re)

  t.section('both seats can repair once without an extra confirmation')
  const repaired=await engineFixture({playbook:'triage',script:turn=>turn.attempt===1?'invalid':JSON.stringify(turn.role==='coordinator'?brief:response('no-findings'))})
  const repairedEngine=await start(repaired);await repairedEngine.drive()
  t.eq('four turns, including two repairs',repairedEngine.run.steps.length,4)
  t.eq('final answer at the turn cap completes',repairedEngine.run.status,'completed')
  await releaseWorkspace(repairedEngine)

  t.section('disposition-only completion cannot authorize code delivery')
  const configFile=path.join(f.configRoot,'playbooks/triage.yaml')
  const config=YAML.parse(await fs.readFile(configFile,'utf8'));config.delivery={action:'commit'}
  await fs.writeFile(configFile,YAML.stringify(config))
  t.eq('code delivery override rejected',(await resolvePlaybook('triage',{root:f.configRoot})).ok,false)
}

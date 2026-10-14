import fs from 'node:fs/promises'
import path from 'node:path'
import { loadConfig, resolvePlaybook } from '../server/config/load.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { boundedReports } from '../server/runtime/engine.mjs'
import { coordinationInput } from '../server/runtime/coordination.mjs'
import { engineFixture, scriptFor, blocking } from './fakes/fixture.mjs'
import { CONFIG_ROOT } from './helpers.mjs'

const fence = out => JSON.stringify(out)
const revision = prompt => (prompt.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
const start = f => startRun({playbookId:f.playbookId,issue:{...f.issue,project:'devpanel-project'},issuePath:f.issuePath,projectPath:f.projectPath,harnesses:f.harnesses,stepStore:f.stepStore,workspaceProvider:f.workspaceProvider,configRoot:f.configRoot,probe:f.probe,clock:f.clock,deliveryProvider:f.delivery})

export default async function(t) {
  t.section('every playbook resolves to a coordination-only coordinator')
  const cfg=await loadConfig({root:CONFIG_ROOT})
  for (const id of cfg.playbooks.keys()) {
    const {ok,resolved,errors}=await resolvePlaybook(id,{root:CONFIG_ROOT})
    t.ok(`${id} resolves`,ok,errors?.map(e=>e.message).join('; '))
    // The invariant is about the SEAT, not about every playbook having one: a
    // single-seat strategy has no coordination to disable. Where a coordinator
    // exists it is always coordination-only; where none does, that is a shape,
    // not a violation.
    if (resolved?.participants.coordinator) t.eq(`${id} disables coordinator tools`,resolved.participants.coordinator.coordinationOnly,true)
    else t.ok(`${id} has no coordinator seat to disable`,true,'single-seat strategy')
    t.ok(`${id} leaves worker tools enabled`,Object.values(resolved?.participants??{}).filter(p=>p.role!=='coordinator').every(p=>!p.coordinationOnly))
  }
  t.eq('refactoring reuses the existing plan/implementation strategy',cfg.playbooks.get('refactoring').strategy,'plan-and-implement')

  t.section('refactoring is audited for preserved functionality before delivery')
  const seen=[];const original=scriptFor()
  const f=await engineFixture({playbook:'refactoring',script:turn=>{
    seen.push(turn)
    if(turn.stepId.startsWith('brief')) return fence({targetRole:'planner',prompt:'Simplify the scoped code while preserving behavior.'})
    if(turn.stepId.startsWith('audit-')) {
      const findings=turn.stepId.startsWith('audit-implement')&&turn.round===0?[blocking('changed-default')]:[
        {id:'retained-residual',severity:'minor',blocking:false,description:'Detailed evidence. '.repeat(1500)+'RESIDUAL-END',criterion:'AC1',location:'source.txt:1'}
      ]
      return fence({verdict:findings.some(f=>f.blocking)?'changes-needed':'approved',artifactRevision:turn.stepId.startsWith('audit-implement')?revision(turn.prompt):null,findings,priorFindings:[]})
    }
    if(turn.stepId==='implement') return fence({summary:'Simplified implementation with behavior evidence.',basedOnRevision:revision(turn.prompt)})
    return original(turn)
  }})
  const invocationOptions=[];const invoke=f.harnesses.fake.invoke
  f.harnesses.fake.invoke=opts=>{invocationOptions.push(opts);return invoke(opts)}
  const inputDir=path.join(f.issuePath,'000-input');await fs.mkdir(inputDir)
  const inputFile=path.join(inputDir,'request.md');await fs.writeFile(inputFile,'Preserve empty-input handling and public API compatibility.\n'+'x'.repeat(7000))
  const reportDir=path.join(f.issuePath,'000-report');await fs.mkdir(reportDir)
  await fs.writeFile(path.join(reportDir,'response.md'),'SETTLED-SCOPE: migrate selected entities only.')
  const approvalDir=path.join(f.issuePath,'010-operator-decisions');await fs.mkdir(approvalDir)
  await fs.writeFile(path.join(approvalDir,'note.md'),'APPROVED-DECISIONS: catalog skipped; Jev optional.')
  const input=await coordinationInput({inputs:[{file:inputFile}]},80)
  t.eq('input excerpts are bounded',input.excerpts[0].text.length,80)
  t.eq('missing input is explicit',input.excerpts[0].truncated,true)
  const e=await start(f)
  await fs.writeFile(path.join(approvalDir,'note.md'),'LIVE-EDIT-MUST-NOT-ENTER-FROZEN-RUN')
  await e.drive()
  t.eq('completed after audited correction',e.run.status,'completed')
  t.eq('auditor is occupied by default',Boolean(e.run.participants['auditor-1']),true)
  t.eq('behavior finding requires another implementation',seen.filter(s=>s.stepId==='implement').length,2)
  t.ok('planner receives behavior-preservation guidance',seen.find(s=>s.stepId==='plan')?.prompt.includes('public APIs'))
  t.ok('implementer receives test-preservation requirement',seen.find(s=>s.stepId==='implement')?.prompt.includes('Do not weaken'))
  t.ok('auditor receives independent equivalence guidance',seen.find(s=>s.stepId==='audit-implement-1')?.prompt.includes('unsupported deletions'))
  t.ok('coordinator sees captured human constraints',seen.find(s=>s.stepId==='triage')?.prompt.includes('Preserve empty-input handling'))
  t.ok('every coordinator turn retains initial report and approved decisions',seen.filter(s=>s.role==='coordinator').every(s=>s.prompt.includes('SETTLED-SCOPE')&&s.prompt.includes('APPROVED-DECISIONS')))
  t.ok('coordinator never reads later live edits',seen.every(s=>!s.prompt.includes('LIVE-EDIT-MUST-NOT-ENTER-FROZEN-RUN')))
  t.ok('closure receives the end of the long structured audit',seen.find(s=>s.stepId==='confirm')?.prompt.includes('RESIDUAL-END'))
  t.ok('all coordinator turns use tool-free mode',invocationOptions.filter(o=>o.meta.role==='coordinator').every(o=>o.supervisorOnly && o.tooling===null && o.cwd===path.join(e.run.workspace.scratchPath,'coordinator')))
  t.ok('all workers keep tools',invocationOptions.filter(o=>o.meta.role!=='coordinator').every(o=>!o.supervisorOnly && o.tooling))
  t.ok('coordinator receives finding before routing correction',seen.find(s=>s.stepId==='brief-implement'&&s.round===1)?.prompt.includes('changed-default'))
  t.eq('delivery happens once, after correction',f.delivery.calls.length,1)
  await releaseWorkspace(e)

  t.section('coordinator report view omits duplication without dropping evidence')
  const steps=[{number:'1',role:'coordinator',phase:'brief',stepId:'brief',round:0,response:'old coordination'},{number:'2',role:'auditor-1',phase:'audit',stepId:'audit',round:0,response:'duplicated narrative'}]
  const outputs={'1':{valid:true,output:{prompt:'old instructions'}},'2':{valid:true,output:{verdict:'changes-needed',findings:[blocking('evidence-gap')]}}}
  const reports=boundedReports({}, {}, steps, outputs, {coordinationOnly:true})
  t.eq('own earlier messages omitted',reports.length,1)
  t.eq('report contains structured finding',reports[0].output.findings[0].id,'evidence-gap')
  t.eq('duplicate prose omitted',Object.hasOwn(reports[0],'response'),false)
  const small=boundedReports({windowLimits:{maxPromptChars:10}}, {}, steps, outputs, {coordinationOnly:true})
  t.eq('structured findings survive a tiny narrative budget',small[0].output,outputs['2'].output)
  t.eq('complete structured reports are not labelled truncated',small[0].truncated,undefined)
  const invalid=boundedReports({}, {}, steps, {'2':{valid:false,output:{verdict:'approved'}}}, {coordinationOnly:true})
  t.eq('invalid review never supplies an approval',invalid[0].output,null)
  t.eq('invalid review is explicit',invalid[0].valid,false)
}

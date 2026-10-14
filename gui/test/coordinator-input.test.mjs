import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { captureWindow } from '../server/runtime/current-window.mjs'
import { coordinationInput } from '../server/runtime/coordination.mjs'
import { boundedReports } from '../server/runtime/engine.mjs'

export default async function (t) {
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'devpanel-coordinator-input-'))
  try {
    const issue=path.join(tmp,'2026-09-20-migration');await fs.mkdir(issue)
    const write=async(folder,file,text)=>{
      await fs.mkdir(path.join(issue,folder),{recursive:true})
      await fs.writeFile(path.join(issue,folder,file),text)
    }
    await write('000-report','response.md','Settled migration scope. Jev optional.')
    for(let i=1;i<=20;i++)await write(`${String(i).padStart(3,'0')}-history`,'note.md',`Historical scope ${i}. `+'x'.repeat(7000))
    await write('021-operator-approval','note.md','Approved criteria 1–13. Skip catalog; migrate credentials; Jev optional.')
    await write('040-verification-task','note.md','Verification only. No migration redesign. Cross-environment checks belong to Step 03.')
    await write('046-correction','note.md','Fix the flags stub and text-field assertions. Do not change the stage.')
    await write('046-correction','large-attachment.txt','attachment'.repeat(20000))
    await write('047-agent','response.md','Do not import old agent criteria.')
    await write('048-unclassified','response.md','Unclassified response must remain excluded.')
    await fs.writeFile(path.join(issue,'.step-reservations.json'),JSON.stringify([{number:'047',origin:'agent-turn',invocationId:'old-agent'}]))
    const window=await captureWindow({issuePath:issue,runId:'capture',workspace:{path:tmp}})
    t.ok('initial response is captured',window.inputs.some(x=>x.source.endsWith('000-report/response.md')))
    t.ok('known and unclassified agent responses remain excluded',window.inputs.every(x=>!x.source.includes('047-agent')&&!x.source.includes('048-unclassified')))
    const view=await coordinationInput(window)
    t.ok('initial report is first',view.excerpts[0].text.includes('Settled migration scope'))
    t.ok('newest correction is next',view.excerpts[1].text.includes('Fix the flags stub'))
    for(const expected of ['Approved criteria 1–13','Verification only','Fix the flags stub']) {
      t.ok(`current decision is complete: ${expected}`,view.excerpts.some(x=>x.text.includes(expected)&&!x.truncated))
    }
    t.ok('historical omissions are visible',view.omitted&&view.omittedSources.some(x=>x.includes('001-history')))
    t.ok('large supporting text cannot displace notes',!view.excerpts.some(x=>x.source.endsWith('large-attachment.txt')))
    t.ok('input remains bounded',view.excerpts.reduce((n,x)=>n+Buffer.byteLength(x.text),0)<=60000)
    const limited=await captureWindow({issuePath:issue,runId:'limited',workspace:{path:tmp},limits:{maxInputFiles:2}})
    t.ok('capture limits preserve the initial report',limited.inputs.some(x=>x.source.endsWith('000-report/response.md')))
    t.ok('capture limits preserve the newest note',limited.inputs.some(x=>x.source.endsWith('046-correction/note.md')))
    const frozen=await coordinationInput(window)
    await write('046-correction','note.md','changed after capture')
    t.eq('later source edits do not change coordinator context',await coordinationInput(window),frozen)

    const output={verdict:'approved',artifactRevision:'sha256:current',findings:[{id:'residual',severity:'minor',blocking:false,description:'evidence '.repeat(2000)+'final qualification'}],priorFindings:[{id:'old-defect',disposition:'addressed',reason:'verified'}]}
    const steps=Array.from({length:25},(_,i)=>({number:String(i+1),role:`auditor-${i}`,phase:'review',stepId:`audit-${i}`,round:0,response:'duplicate narrative'}))
    const outputs=Object.fromEntries(steps.map(s=>[s.number,{valid:true,output}]))
    const reports=boundedReports({windowLimits:{maxPromptChars:10}}, {}, steps, outputs, {coordinationOnly:true})
    t.eq('no occupied seat is dropped by the narrative report limit',reports.length,25)
    t.ok('all verdicts, revisions, residuals and prior dispositions survive intact',reports.every(r=>JSON.stringify(r.output)===JSON.stringify(output)&&!r.truncated))
    t.ok('duplicate narrative is omitted',reports.every(r=>!Object.hasOwn(r,'response')))
  } finally { await fs.rm(tmp,{recursive:true,force:true}) }
}

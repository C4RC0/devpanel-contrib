import { checkSummary } from '../server/runtime/check-summary.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { engineFixture } from './fakes/fixture.mjs'

export default async function (t) {
  const check = { revision: 'sha256:approved', result: 'passed', materialization: { verified: true, remoteEntries: Array.from({length:10000},(_,i)=>({path:`module/${i}.mjs`,contentHash:'x'.repeat(64)})) }, commands: [{id:'readiness',passed:true,exitCode:0}] }
  const summary=checkSummary(check,'/retained/evidence/check.json')
  t.ok('large manifest is excluded from prompt',JSON.stringify(summary).length<3000)
  t.eq('manifest count retained',summary.materialization.remoteEntryCount,10000)
  t.eq('full evidence reference retained',summary.fullEvidence,'/retained/evidence/check.json')
  t.eq('original evidence not mutated',check.materialization.remoteEntries.length,10000)
  const f=await engineFixture()
  let reject=true
  const engine=await startRun({...f,deliveryProvider:f.delivery,harnesses:{fake:{...f.fake,invoke:async args=>{
    if(/audit/.test(args.meta.stepId) && reject) { reject=false;throw Object.assign(Error('input rejected'),{stderr:'input_too_large: Input exceeds the maximum length of 1048576 characters.'}) }
    return f.fake.invoke(args)
  }}}})
  await engine.drive().catch(()=>{})
  engine.run.status='failed' // The service records terminal runtime failures.
  const completed=engine.run.steps.map(s=>s.invocationId)
  t.ok('completed work exists before rejection',completed.length>0)
  f.clock.advance(5 * 60 * 60 * 1000) // Time waiting for an engine fix is not agent execution.
  await engine.retryInputFailure()
  await engine.drive()
  t.eq('retained run completes',engine.run.status,'completed')
  t.eq('completed invocations are preserved exactly',engine.run.steps.slice(0,completed.length).map(s=>s.invocationId),completed)
  t.eq('rejection evidence is retained',engine.run.failures.length,1)
  t.eq('terminal success cannot be retried',await engine.retryInputFailure().then(()=>false,()=>true),true)
  await releaseWorkspace(engine)
}

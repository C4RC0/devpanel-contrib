import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { resolveCommand } from '../server/runtime/command.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import * as claude from '../../harness/claude.mjs'
import * as codex from '../../harness/codex.mjs'
export default async function(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'supervisor-spawn-'))
 const oldClaude=process.env.DEVPANEL_CLAUDE_BIN,oldCodex=process.env.DEVPANEL_CODEX_BIN
 let supervisor
 try{
 const bin=path.join(dir,'.local/bin');await fs.mkdir(bin,{recursive:true})
 await fs.writeFile(path.join(bin,'claude'),'#!/bin/sh\nexit 0\n',{mode:0o755})
 t.eq('service PATH falls back to user installation',resolveCommand('claude',null,{home:dir,envPath:'/missing'}),path.join(bin,'claude'))
 t.eq('explicit missing override never falls back',resolveCommand('claude','/explicit/missing',{home:dir,envPath:bin}),'/explicit/missing')
 for(const [harness,adapter]of [['claude',claude],['codex',codex]]){
 process.env['DEVPANEL_'+harness.toUpperCase()+'_BIN']=path.join(dir,'missing-'+harness)
 let failure
 try{await adapter.invoke({cwd:dir,prompt:'never sent',ledgerDir:dir,meta:{invocationId:'missing-'+harness}})}catch(e){failure=e}
 t.eq(harness+' spawn has explicit classification',failure?.kind,'spawn-error')
 t.eq(harness+' reports process never started',failure?.started,false)
 t.eq(harness+' ledger proves not-started',(await adapter.reconcile('missing-'+harness,{ledgerDir:dir})).phase,'not-started')
 }
 const models=async()=>[{id:'test',harness:'claude',model:'test',verification:{status:'verified'}}]
 const tools={projects:async()=>[{id:'test-project'}],listIssues:async()=>[],playbooks:async()=>[]}
 const stateDir=path.join(dir,'supervisor')
 supervisor=await createTopSupervisor({dir:stateDir,models,tools,adapter:claude})
 await supervisor.start({model:'test',projects:['test-project'],message:'Keep this mission'})
 const end=Date.now()+3000
 while(supervisor.get().status!=='stopped'){if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,10))}
 t.eq('missing runtime is retryable',supervisor.get().status,'stopped')
 t.eq('pending operation cleared on proof',supervisor.get().pending,null)
 t.eq('missing executable has no unknown bill',supervisor.get().unknownCostCalls,0)
 t.eq('failed attempt preserved',supervisor.get().spawnFailures,1)
 t.eq('mission preserved',supervisor.get().mission,'Keep this mission')
 await supervisor.shutdown()
 const legacy=supervisor.get();legacy.status='recovery-required';legacy.reason='could not start "claude": spawn claude ENOENT';legacy.pending={kind:'model',invocationId:'legacy-failure'};legacy.unknownCostCalls=1;legacy.messages.push({role:'system',text:legacy.reason})
 await fs.writeFile(path.join(stateDir,'state.json'),JSON.stringify(legacy))
 supervisor=await createTopSupervisor({dir:stateDir,models,tools,adapter:claude})
 t.eq('legacy ENOENT recovered without retrying',supervisor.get().status,'stopped')
 t.eq('legacy cost corrected',supervisor.get().unknownCostCalls,0)
 t.ok('legacy pending preserved as evidence',supervisor.get().failureHistory.some(f=>f.invocationId==='legacy-failure'&&f.started===false))
 await supervisor.shutdown()
 legacy.reason='agent response lost';legacy.messages.at(-1).text=legacy.reason
 await fs.writeFile(path.join(stateDir,'state.json'),JSON.stringify(legacy))
 supervisor=await createTopSupervisor({dir:stateDir,models,tools,adapter:claude})
 t.eq('ambiguous failures still require recovery',supervisor.get().status,'recovery-required')
 }finally{await supervisor?.shutdown();if(oldClaude===undefined)delete process.env.DEVPANEL_CLAUDE_BIN;else process.env.DEVPANEL_CLAUDE_BIN=oldClaude;if(oldCodex===undefined)delete process.env.DEVPANEL_CODEX_BIN;else process.env.DEVPANEL_CODEX_BIN=oldCodex;await fs.rm(dir,{recursive:true,force:true})}
}

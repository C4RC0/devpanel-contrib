import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runProcess } from '../server/runtime/process.mjs'
import { managedRemoteCommand, stopRemoteCommands } from '../server/runtime/remote-check-process.mjs'
import { installRemoteManager } from './fakes/remote-manager.mjs'
import { startProjectAction } from '../server/project-actions.mjs'
import { sandbox } from './helpers.mjs'

export default async function (t) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devpanel-process-regression-'))
 try {
  t.section('remote cancellation terminates an independently owned process group')
  const managerDir=path.join(dir,'manager'), candidate=path.join(dir,'candidate'), pidFile=path.join(dir,'pid')
  await fs.mkdir(managerDir); await fs.mkdir(candidate)
  const managerEnv=await installRemoteManager(managerDir)
  const controller=new AbortController()
  const pending=runProcess({command:'/bin/bash',args:['-c',`${managerEnv}\n${managedRemoteCommand(candidate,{id:'hold',run:`echo $$ > '${pidFile}'; sleep 120`,timeoutSeconds:130})}`],signal:controller.signal})
  for(let n=0;n<300 && !await fs.stat(pidFile).then(()=>true,()=>false);n++) await new Promise(r=>setTimeout(r,10))
  const pid=Number(await fs.readFile(pidFile,'utf8'))
  for(let n=0;n<300 && await fs.stat(path.join(candidate,'.registration-uncertain')).then(()=>true,()=>false);n++) await new Promise(r=>setTimeout(r,10))
  controller.abort()
  const stopped=await runProcess({command:'/bin/bash',args:['-c',`${managerEnv}\n${stopRemoteCommands(candidate)}`]})
  await pending
  t.eq('independent cancellation command confirms termination',stopped.code,0)
  const alive=await fs.readFile(`/proc/${pid}/stat`,'utf8').then(s=>!s.slice(s.lastIndexOf(')')+2).startsWith('Z'),()=>false)
  t.eq('remote command process is no longer running',alive,false)
  const late=await runProcess({command:'/bin/bash',args:['-c',`${managerEnv}\n${managedRemoteCommand(candidate,{id:'late',run:'touch late',timeoutSeconds:5})}`]})
  t.ok('late launch is fenced after cancellation',late.code!==0)
  t.eq('late command did not run',await fs.stat(path.join(candidate,'late')).then(()=>true,()=>false),false)
  await fs.writeFile(path.join(candidate,'.registration-uncertain'),'')
  const uncertain=await runProcess({command:'/bin/bash',args:['-c',`${managerEnv}\n${stopRemoteCommands(candidate)}`]})
  t.ok('uncertain registration cannot authorize cleanup',uncertain.code!==0)

  t.section('project-action locks survive bookkeeping failures')
  const root=await sandbox(), projectsDir=path.join(dir,'srv'), issuesDir=path.join(dir,'issues'), project='fixture-project'
  await fs.mkdir(path.join(projectsDir,project),{recursive:true})
  await fs.writeFile(path.join(projectsDir,project,'checkpoint.sh'),'#!/bin/bash\nsleep 0.1\necho done\n',{mode:0o755})
  const opts={root,projectsDir,issuesDir,project,actionId: 'checkpoint'}
  const exists=()=>fs.stat(path.join(issuesDir,project,'.actions','.lock')).then(()=>true,()=>false)
  for(const phase of ['mkdir','emit','final-write']) {
   const originalMkdir=fs.mkdir, originalRename=fs.rename
   let failure
   try {
    if(phase==='mkdir')fs.mkdir=async(file,...args)=>{if(String(file).includes('/.actions/20'))throw new Error('injected setup failure');return originalMkdir(file,...args)}
    const started=await startProjectAction({...opts,emit:event=>{if(phase==='emit'&&event.type==='started')throw new Error('injected emit failure')}})
    if(phase==='final-write')fs.rename=async(from,to)=>{if(String(to).endsWith('/operation.json'))throw new Error('injected final write failure');return originalRename(from,to)}
    await started.done
   }catch(error){failure=error}finally{fs.mkdir=originalMkdir;fs.rename=originalRename}
   t.ok(`${phase} surfaces its failure`,failure?.message.includes('injected'))
   t.eq(`${phase} releases the lock`,await exists(),false)
  }
  const retry=await startProjectAction(opts)
  t.eq('a subsequent action can finish', (await retry.done).status,'completed')
 } finally {await fs.rm(dir,{recursive:true,force:true})}
}

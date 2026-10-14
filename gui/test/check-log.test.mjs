import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readCheckLog } from '../server/runtime/check-log.mjs'
export default async function(t){
 const issuePath=await fs.mkdtemp(path.join(os.tmpdir(),'check-log-test-'))
 try{
  const dir=path.join(issuePath,'runs/r1/checks/004');await fs.mkdir(dir,{recursive:true})
  await fs.writeFile(path.join(issuePath,'runs/r1/run.json'),JSON.stringify({checkResults:[{dir:'checks/004',revision:'approved',result:'failed',commands:[{id:'admin',log:'admin.log',exitCode:1}]}]}))
  await fs.writeFile(path.join(dir,'admin.log'),'x'.repeat(40000)+'\nFAIL (suite-busy)')
  const result=await readCheckLog({issuePath,runId:'r1',check:'004',command:'admin'})
  t.ok('bounded evidence contains actual failure',result.truncated&&result.text.length<=32000&&result.text.includes('suite-busy'))
  t.eq('bound to checked revision',result.revision,'approved')
  t.eq('unknown command refused',await readCheckLog({issuePath,runId:'r1',check:'004',command:'other'}).then(()=>false,()=>true),true)
  t.eq('traversal refused',await readCheckLog({issuePath,runId:'../r1',check:'004',command:'admin'}).then(()=>false,()=>true),true)
  await fs.rm(path.join(dir,'admin.log'));await fs.symlink('/etc/hostname',path.join(dir,'admin.log'))
  t.eq('external symlink refused',await readCheckLog({issuePath,runId:'r1',check:'004',command:'admin'}).then(()=>false,()=>true),true)
 }finally{await fs.rm(issuePath,{recursive:true,force:true})}
}

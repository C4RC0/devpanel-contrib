import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createFileLogger } from '../server/logging.mjs'
import { startStage } from './browser/stage.mjs'
const exec=promisify(execFile)
export default async function(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devpanel-logging-'))
 try{
 const secret='secret-value-for-test'
 const logger=createFileLogger({dir,maxBytes:1024,backups:2,secrets:[secret]})
 logger.write('error',`credential=${secret}; Bearer another-secret-value`)
 let rows=(await fs.readFile(logger.file,'utf8')).trim().split('\n').map(JSON.parse)
 t.eq('records severity',rows[0].level,'error')
 t.ok('records timestamp and pid',Boolean(rows[0].at)&&rows[0].pid===process.pid)
 t.ok('known secrets removed',!rows[0].message.includes(secret))
 t.ok('bearer value removed',!rows[0].message.includes('another-secret-value'))
 t.eq('log file is owner-only',(await fs.stat(logger.file)).mode&0o777,0o600)
 for(let i=0;i<60;i++)logger.write('info','entry '+i+' '+('x'.repeat(90)))
 const names=await fs.readdir(dir)
 t.eq('only current log and two backups retained',names.sort(),['devpanel.jsonl','devpanel.jsonl.1','devpanel.jsonl.2'])
 t.ok('all files stay within the configured bound',(await Promise.all(names.map(n=>fs.stat(path.join(dir,n))))).every(s=>s.size<=1024))
 t.ok('latest event retained',(await fs.readFile(logger.file,'utf8')).includes('entry 59'))
 const crashDir=path.join(dir,'crash')
 const moduleUrl=new URL('../server/logging.mjs',import.meta.url).href
 let failed=false
 try{await exec(process.execPath,['--input-type=module','-e',`import {installLogging} from ${JSON.stringify(moduleUrl)};installLogging({dir:${JSON.stringify(crashDir)}});throw Error('deliberate fixture crash')`])}catch(e){failed=e.code===1}
 t.ok('crash remains a nonzero exit',failed)
 t.ok('uncaught exception recorded',(await fs.readFile(path.join(crashDir,'devpanel.jsonl'),'utf8')).includes('deliberate fixture crash'))
 const stage=await startStage()
 try{
 const file=path.join(stage.logDir,'devpanel.jsonl')
 t.ok('real server startup writes its file',(await fs.readFile(file,'utf8')).includes('Service starting'))
 const result=await stage.request('/api/supervisor/start',{method:'POST',body:JSON.stringify({model:'not-a-model'})})
 t.eq('invalid request fails',result.status,400)
 const text=await fs.readFile(file,'utf8')
 t.ok('request failure has its route',text.includes('POST /api/supervisor/start'))
 t.ok('service token is not logged',!text.includes(stage.token))
 await stage.restart({signal:'SIGTERM'})
 t.ok('graceful shutdown captured',(await fs.readFile(file,'utf8')).includes('stopping supervised runs'))
 }finally{await stage.stop()}
 }finally{await fs.rm(dir,{recursive:true,force:true})}
}

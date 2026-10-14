import fs from 'node:fs/promises'
import path from 'node:path'
export async function installRemoteManager (dir) {
 const source=`#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
const args=process.argv.slice(2), dir=process.env.DEVPANEL_TEST_UNITS
fs.mkdirSync(dir,{recursive:true})
const alive=pid=>{try{const text=fs.readFileSync('/proc/'+pid+'/stat','utf8');return !text.slice(text.lastIndexOf(')')+2).startsWith('Z')}catch{return false}}
if(path.basename(process.argv[1])==='systemd-run'){
 const unit=args.find(a=>a.startsWith('--unit=')).slice(7),file=path.join(dir,unit+'.json')
 const cwd=args.find(a=>a.startsWith('--property=WorkingDirectory=')).slice('--property=WorkingDirectory='.length)
 // The confined kinds (0e) run for real where they can: bubblewrap with the
 // ambient capabilities dropped, and the privileged mask inside a user
 // namespace mapped to root (a real root is not available to the suite).
 const index=args.findIndex(a=>a==='/usr/bin/bwrap'||a==='/usr/bin/unshare'||a==='/usr/bin/nsenter'||a==='/bin/sh')
 // systemd's own command-line expansion: \$\$ is a literal dollar.
 let command=args[index],rest=args.slice(index+1).map(a=>a.replaceAll('$$','$'))
 if(command==='/usr/bin/bwrap'){rest=['--ambient-caps','-all','--inh-caps','-all','bwrap',...rest.filter(a=>args.includes('--wait')||a!=='--die-with-parent')];command='setpriv'}
 if(command==='/usr/bin/unshare')rest=['--user','--map-root-user',...rest]
 const env={...process.env};for(const a of args.slice(0,index))if(a.startsWith('--setenv=')){const kv=a.slice(9),i=kv.indexOf('=');env[kv.slice(0,i)]=kv.slice(i+1)}
 fs.appendFileSync(path.join(dir,'invocations.jsonl'),JSON.stringify({unit,args})+'\\n')
 const service=!args.includes('--wait')
 const child=spawn(command,rest,{cwd,env,stdio:['ignore',service?'ignore':'pipe',service?'ignore':'pipe'],detached:true})
 fs.writeFileSync(file,JSON.stringify({pid:child.pid}))
 if(service){child.unref();process.exit(0)}
 child.stdout.on('data',bytes=>process.stdout.write(bytes));child.stderr.on('data',bytes=>process.stderr.write(bytes))
 const seconds=Number(args.find(a=>a.startsWith('--property=RuntimeMaxSec=')).match(/=(\\d+)s$/)[1])
 const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGTERM')}catch{}},seconds*1000)
 child.on('exit',(code)=>{clearTimeout(timer);fs.writeFileSync(file,JSON.stringify({pid:0}));process.exit(code??1)})
}else{
 const unit=args.find(a=>a.startsWith('devpanel-check-')),file=path.join(dir,unit+'.json')
 let entry;try{entry=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}
 if(args.includes('stop')){
  if(entry?.pid&&alive(entry.pid)){try{process.kill(-entry.pid,'SIGTERM')}catch{};for(let n=0;n<100&&alive(entry.pid);n++)await new Promise(r=>setTimeout(r,20));if(alive(entry.pid))process.exit(1)}
 }else{
  const prop=args[args.indexOf('-p')+1],running=entry?.pid&&alive(entry.pid)
  process.stdout.write((prop==='LoadState'?(entry?'loaded':'not-found'):prop==='ActiveState'?(running?'active':'inactive'):prop==='MainPID'?String(running?entry.pid:0):'')+'\\n')
 }
}
`
 for(const name of ['systemd-run','systemctl'])await fs.writeFile(path.join(dir,name),source,{mode:0o755})
 return `export PATH='${dir}':"$PATH"\nexport DEVPANEL_TEST_UNITS='${dir}/units'`
}

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { probeProjectSandbox } from '../server/runtime/sandbox-probe.mjs'
import { resolveProjectPath } from '../server/project-path.mjs'
import { preflight } from '../server/config/preflight.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { asVerified } from './helpers.mjs'
import { engineFixture } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace, resumeRun } from '../server/runtime/launch.mjs'

export default async function (t) {
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'devpanel-sandbox-preflight-'))
 try {
  const f=await engineFixture()
  const alias=path.join(tmp,'alias-project')
  await fs.symlink(f.projectPath,alias)
  t.eq('project boundary resolves aliases',await resolveProjectPath('alias-project',{projectsDir:tmp}),f.projectPath)
  const previous=process.env.DEVPANEL_PROJECTS_DIR
  let issues
  try {process.env.DEVPANEL_PROJECTS_DIR=tmp;issues=await import(`../server/issues.js?sandbox-path=${Date.now()}`)}
  finally {if(previous===undefined)delete process.env.DEVPANEL_PROJECTS_DIR;else process.env.DEVPANEL_PROJECTS_DIR=previous}
  const listing=await issues.listProjects()
  t.eq('discovery retains logical project identity',listing[0].id,'alias-project')
  t.eq('discovery exposes canonical source path',listing[0].path,f.projectPath)
  const calls=[]
  const execute=async options=>{calls.push(options);return {code:0,stdout:'',stderr:'',cancelled:false}}
  const smoke=await probeProjectSandbox({projectPath:alias,allowedRoots:[alias,f.projectPath]},{execute,platform:'linux'})
  t.eq('local smoke probe passes',smoke.status,'pass')
  const bwrap=calls.find(c=>c.command==='bwrap')
  t.ok('mount probe uses canonical path only',bwrap.args.includes(f.projectPath)&&!bwrap.args.includes(alias))
  t.eq('canonical probe roots deduplicate',smoke.roots,[f.projectPath])
  t.eq('probe runs only a trivial sandbox command',bwrap.args.slice(-2),['--','/usr/bin/true'])
  const scratch=bwrap.args[bwrap.args.indexOf('--bind')+1]
  t.eq('probe scratch is removed',await fs.stat(scratch).then(()=>true,()=>false),false)
  const failed=await probeProjectSandbox({projectPath:alias},{platform:'linux',execute:async options=>options.command==='bwrap'?{code:1,stderr:'bwrap: mount refused'}:{code:0}})
  t.ok('mount failure is explicit',failed.status==='fail'&&failed.message.includes('bwrap: mount refused'))
  const broken=await probeProjectSandbox({projectPath:path.join(tmp,'missing')},{execute})
  t.eq('missing project fails before command execution',broken.status,'fail')
  const {resolved}=await resolvePlaybook('implementation')
  const verified=asVerified(resolved)
  // Ensure this gate applies even if defaults change to an all-Codex roster.
  Object.values(verified.participants)[0].model.harness='claude'
  for(const status of ['fail','unknown']) {
   let paid=0
   const result=await preflight(verified,{projectPath:alias,probe:async()=>{paid++;throw new Error('must not probe models')},sandboxProbe:async()=>({status,message:'sandbox unavailable'})})
   t.eq(`${status} sandbox evidence prevents launch`,result.launchReady,false)
   t.eq(`${status} sandbox evidence spends no model probes`,paid,0)
   t.ok('finding identifies sandbox level',result.findings.some(f=>f.level==='sandbox'&&f.status===status))
  }
  const engine=await startRun({playbookId:f.playbookId,issue:{project:'devpanel-project',id:f.issue.id},issuePath:f.issuePath,projectPath:alias,harnesses:f.harnesses,stepStore:f.stepStore,workspaceProvider:f.workspaceProvider,configRoot:f.configRoot,probe:f.probe,clock:f.clock,deliveryProvider:f.delivery})
  t.eq('direct run provisioning records canonical project path',engine.projectPath,f.projectPath)
  t.eq('original alias retained for file-tool policy',engine.toolingPolicy().liveCheckoutAliases,[alias])
  const pointer=await fs.readFile(path.join(engine.run.workspace.path,'.git'),'utf8')
  // Private repositories (0d): the pointer names the run's worker directory;
  // the source it was fetched from is recorded canonically.
  const repo=engine.run.workspace.repository
  if(repo?.kind==='private') t.ok('worktree Git pointer names the worker directory, the source canonically',pointer.trim()===`gitdir: ${repo.worker}`&&repo.source.startsWith(f.projectPath)&&!repo.source.includes(alias))
  else t.ok('worktree Git pointer names canonical source',pointer.includes(f.projectPath)&&!pointer.includes(alias))
  await engine.drive({maxTurns:1})
  t.ok('prompt tooling names canonical live checkout',engine.toolingPolicy().liveCheckout===f.projectPath)
  await engine.runLock.release();engine.runLock=null
  const restored=await resumeRun({issuePath:f.issuePath,runId:engine.runId,harnesses:f.harnesses,stepStore:f.stepStore,projectPath:alias,configRoot:f.configRoot,clock:f.clock,deliveryProvider:f.delivery})
  t.eq('resume canonicalizes project path',restored.projectPath,f.projectPath)
  t.eq('resume retains the alias denial',restored.toolingPolicy().liveCheckoutAliases,[alias])
  await restored.drive()
  await releaseWorkspace(restored)
 } finally {await fs.rm(tmp,{recursive:true,force:true})}
}

import { archiveState } from '../issue-archive.mjs'
import { packedSummary } from '../issue-bundle.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { writeJson } from './persistence.mjs'
import { withLock } from './lock.mjs'
import { openedBy } from '../opened-by.mjs'

// Scoped to the source issue's project directory. Stable identities survive a
// crash between creating an issue and recording the coordinator's receipt.
export async function publishFindings ({ issuePath, runId, project, output }) {
  const projectDir = path.dirname(issuePath)
  return withLock(path.join(projectDir, '.tactical-issues.lock'), {purpose:'finding-publication',waitMs:10000}, async () => {
    const receipts = []
    const keys = new Set()
    for (const finding of output.issues) {
      if (!/^[a-z0-9-]+$/.test(finding.key)) throw new Error('invalid finding key')
      if (keys.has(finding.key)) throw new Error(`duplicate finding key: ${finding.key}`)
      keys.add(finding.key)
      const identity = crypto.createHash('sha256').update(`${path.basename(issuePath)}\0${finding.key}`).digest('hex')
      let id = finding.existingIssue
      if (id) {
        if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(id)) throw new Error('invalid existing issue identity')
        const stat = await fs.lstat(path.join(projectDir,id)).catch(error=>{if(error.code==='ENOENT')return null;throw error})
        // An archived issue packed out of the folder still exists; it takes no new steps.
        const packed = !stat && await packedSummary(path.dirname(projectDir),path.basename(projectDir),id)
        if (!packed && (!stat || !stat.isDirectory() || stat.isSymbolicLink())) throw new Error('existing issue must belong to this project')
      } else {
        for (const entry of await fs.readdir(projectDir,{withFileTypes:true})) {
          if (!entry.isDirectory()) continue
          const record = await fs.readFile(path.join(projectDir,entry.name,'issue.json'),'utf8').then(JSON.parse).catch(()=>null)
          if (record?.findingIdentity === identity) { id=entry.name; break }
        }
        if (!id) {
          const now = new Date()
          const date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
          const slug = finding.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,45) || finding.kind
          id=`${date}-${slug}-${identity.slice(0,10)}`
          const dir=path.join(projectDir,id)
          try { await fs.mkdir(dir) } catch(error) {
            if(error.code!=='EEXIST')throw error
            const stat=await fs.lstat(dir)
            if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('finding issue path is not a directory')
            const existing=await fs.readFile(path.join(dir,'issue.json'),'utf8').then(JSON.parse).catch(()=>null)
            if(existing?.findingIdentity!==identity && (await fs.readdir(dir)).length)throw new Error('finding issue identity collides with existing issue; choose a different stable key')
          }
          await writeJson(path.join(dir,'issue.json'),{name:finding.title,slug:id.slice(11),project,status:'open',kind:finding.kind,openedOn:date,openedAt:new Date().toISOString(),findingIdentity:identity,origin:{issue:path.basename(issuePath),runId,key:finding.key},openedBy:openedBy({user:'engine',from:{project,issueId:path.basename(issuePath),runId,via:'finding'}})})
        }
      }
      const report = `# ${finding.title}\n\n${finding.description}\n\nKind: ${finding.kind}\n\nEvidence:\n${finding.evidence.map(x=>`- ${x}`).join('\n')}\n\nAcceptance criteria:\n${finding.acceptanceCriteria.map(x=>`- ${x}`).join('\n')}\n\nSource: ${path.basename(issuePath)}, run ${runId}, finding ${finding.key}.\n`
      // Attach via the normal allocator, which handles numbering and replay.
      const { createStepAt } = await import('./tactical-step-store.mjs')
      const archived=Boolean(await archiveState(path.join(projectDir,id))) || Boolean(await packedSummary(path.dirname(projectDir),path.basename(projectDir),id))
      if (!archived) await createStepAt(path.join(projectDir,id),{name:'investigation',response:report,origin:'external-report',invocationId:`finding:${runId}:${identity}`})
      receipts.push({key:finding.key,kind:finding.kind,title:finding.title,issueId:id,linked:Boolean(finding.existingIssue),archived,evidenceOnSourceIssue:archived})
    }
    return receipts
  })
}

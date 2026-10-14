import fs from 'node:fs/promises'
import path from 'node:path'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'
export default async function (t) {
 const stage=await startStage()
 const create=input=>stage.request(`/api/projects/${stage.project}/issues`,{method:'POST',body:JSON.stringify({input})})
 try {
 const title='A long issue title that exceeds the previous sixty-four character limit without being truncated'
 const one=await create(title)
 t.eq('long title accepted',one.status,201)
 t.eq('long title preserved',one.body.name,title)
 const report='# Report title\n\n'+'Detailed findings.\n'.repeat(5000)
 const two=await create(report)
 t.eq('multiline report above old body limit accepted',two.status,201)
 t.eq('heading is the title',two.body.name,'Report title')
 const reportPath=path.join(stage.issuesDir,stage.project,two.body.id,'000-report/response.md')
 t.eq('full report is preserved',await fs.readFile(reportPath,'utf8'),report)
 const source=path.join(stage.projectsDir,stage.project,'audit.md')
 await fs.writeFile(source,'# Imported audit\n\nFinding details.\n')
 const three=await create(source)
 t.eq('absolute path imported',three.status,201)
 t.eq('file heading is title',three.body.name,'Imported audit')
 t.eq('file is copied verbatim',await fs.readFile(path.join(stage.issuesDir,stage.project,three.body.id,'000-report/response.md'),'utf8'),await fs.readFile(source,'utf8'))
 await fs.writeFile(source,'First line title\nDetails')
 const four=await create('audit.md')
 t.eq('relative path imported',four.status,201)
 t.eq('first line fallback title',four.body.name,'First line title')
 t.eq('missing path fails clearly',(await create('/missing/report.md')).status,400)
 t.eq('blank input refused',(await create('   ')).status,400)
 const browser=await openBrowser(`${stage.origin}/projects/${stage.project}`,{token:stage.token})
 try {
 await browser.clickWhen(()=>browser.find('button','New issue'))
 await browser.until(()=>browser.all('textarea').length>0)
 const field=browser.all('textarea')[0]
 t.ok('input has no character maxlength',!field.hasAttribute('maxlength'))
 field.value='# Browser report\n\nBody from browser';field.dispatchEvent(new browser.window.Event('input',{bubbles:true}))
 await browser.clickWhen(()=>browser.find('button','Open issue'))
 await browser.until(()=>browser.has('Browser report') && browser.has('Add to this issue'))
 t.ok('multiline browser creation succeeds',true)
 }finally{browser.close()}
 }finally{await stage.stop()}
}

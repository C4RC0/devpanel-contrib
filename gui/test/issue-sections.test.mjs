import { readFolder, readHidden, writeFolder, writeHidden } from '../src/issue-sections.js'

export const name = 'issue sections — what this browser hides, and what an unreadable record means'

/** A localStorage stand-in that records which keys were written. */
function memory (initial = {}) {
  const values = new Map(Object.entries(initial))
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)) } }
}
const broken = { getItem () { throw new Error('storage disabled') }, setItem () { throw new Error('storage disabled') } }
const hiddenFrom = (value) => readHidden(memory({ 'devpanel.issue.hidden': value }))
const folderFrom = (value) => readFolder(memory({ 'devpanel.issue.folder': value }))

export default async function (t) {
  t.section('1. hidden sections: anything but a list of known ids is the default view')
  {
    t.eq('nothing stored hides nothing', readHidden(memory()), [])
    t.eq('unparsable JSON hides nothing', hiddenFrom('{not json'), [])
    t.eq('an object hides nothing', hiddenFrom('{"a":1}'), [])
    t.eq('a bare string hides nothing', hiddenFrom('"status"'), [])
    // No partial recovery: one bad entry means the record is not ours.
    t.eq('a list with a number and an unknown id hides nothing', hiddenFrom('["detail",3,"bogus","issue"]'), [])
    t.eq('a list with an unknown id hides nothing', hiddenFrom('["issue","bogus"]'), [])
    t.eq('a list with a number hides nothing', hiddenFrom('["issue",3]'), [])
    t.eq('known ids come back in page order', hiddenFrom('["tech","issue","outcome"]'), ['issue', 'outcome', 'tech'])
  }

  t.section('2. hidden sections: one global key, written in page order')
  {
    const storage = memory()
    writeHidden(['timeline', 'issue'], storage)
    t.eq('one key, with no issue in its name', [...storage.values.keys()], ['devpanel.issue.hidden'])
    t.eq('stored in page order', storage.values.get('devpanel.issue.hidden'), '["issue","timeline"]')
    t.eq('and read back', readHidden(storage), ['issue', 'timeline'])
    writeHidden([], storage)
    t.eq('showing everything again stores an empty list', readHidden(storage), [])
  }

  t.section('3. the folder: an explicit choice, or none')
  {
    t.eq('nothing stored is no choice', readFolder(memory()), null)
    t.eq('"open" is opened', folderFrom('open'), true)
    t.eq('"closed" is closed', folderFrom('closed'), false)
    for (const value of ['true', 'OPEN', '', '{']) t.eq(`${JSON.stringify(value)} is no choice`, folderFrom(value), null)
    const storage = memory()
    writeFolder(true, storage)
    t.eq('opening is stored under one global key', [...storage.values.entries()], [['devpanel.issue.folder', 'open']])
    t.eq('and read back', readFolder(storage), true)
    writeFolder(false, storage)
    t.eq('closing replaces it', readFolder(storage), false)
  }

  t.section('4. storage that refuses')
  {
    t.eq('reading hidden sections gives the default view', readHidden(broken), [])
    t.eq('reading the folder gives no choice', readFolder(broken), null)
    let threw = false
    try { writeHidden(['issue'], broken); writeFolder(true, broken) } catch { threw = true }
    t.ok('writing does not throw', !threw)
  }
}

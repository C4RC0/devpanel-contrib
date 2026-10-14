import fs from 'node:fs/promises'
import path from 'node:path'

import { openBrowser } from './browser/harness.mjs'
import { startStage } from './browser/stage.mjs'

export const name = 'issue material — adding text, links and files to an open issue'

const flat = (s) => s.replace(/\s+/g, ' ')

export default async function (t) {
  const stage = await startStage()
  const root = `/api/projects/${stage.project}/issues`
  const upload = (id, number, filename, body, headers = {}) =>
    fetch(`${stage.origin}${root}/${id}/steps/${number}/files/${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${stage.token}`, 'Content-Type': 'application/octet-stream', ...headers },
      body
    })

  // ------------------------------------------------------------------ 1. text
  t.section('1. text and links land in the issue folder')
  const issue = await stage.createIssue('Something is broken')
  const dir = path.join(stage.issuesDir, stage.project, issue.id)

  const created = await stage.request(`${root}/${issue.id}/steps`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'report',
      text: 'It crashes when the file is saved twice.',
      links: ['https://example.com/ticket/7', 'http://logs.internal/run/3']
    })
  })
  t.eq('the step is created', created.status, 201)
  t.eq('numbered from zero', created.body.number, '000')
  t.eq('and named', created.body.name, 'report')
  t.eq('holding the note and the links', created.body.files.map((f) => f.name), ['links.md', 'note.md'])

  const note = await fs.readFile(path.join(dir, created.body.id, 'note.md'), 'utf8')
  t.ok('the text is on disk verbatim', note.includes('crashes when the file is saved twice'), note.trim())
  const links = await fs.readFile(path.join(dir, created.body.id, 'links.md'), 'utf8')
  t.ok('both links are recorded', links.includes('example.com/ticket/7') && links.includes('logs.internal/run/3'))
  t.ok('as markdown links', /^- \[.+]\(https?:\/\//m.test(links), links.split('\n')[2])

  // The coordinator's prompt tells it to read the issue folder, so this is the
  // whole point: what a person adds is material the run can use.
  t.ok('and it sits directly in the issue folder the agents are told to read',
    (await fs.readdir(dir)).includes(created.body.id))

  // ------------------------------------------------- 1b. names and formats
  t.section('1b. a note needs no title, and can be written in more than one form')
  {
    const unnamed = await stage.request(`${root}/${issue.id}/steps`, {
      method: 'POST', body: JSON.stringify({ text: 'Something I noticed, with no title for it.' })
    })
    t.eq('a note without a name is accepted', unnamed.status, 201)
    t.ok('and is simply called a note', unnamed.body.id.endsWith('-note'), unnamed.body.id)
    t.eq('holding the text', unnamed.body.files.map((f) => f.name), ['note.md'])

    for (const [format, filename] of [['txt', 'note.txt'], ['html', 'note.html'], ['md', 'note.md']]) {
      const written = await stage.request(`${root}/${issue.id}/steps`, {
        method: 'POST', body: JSON.stringify({ name: `as ${format}`, text: '<b>content</b>', format })
      })
      t.eq(`${format} is written as ${filename}`, written.body.files.map((f) => f.name), [filename])
    }

    const unknown = await stage.request(`${root}/${issue.id}/steps`, {
      method: 'POST', body: JSON.stringify({ name: 'bad', text: 'x', format: 'exe' })
    })
    t.eq('an unknown format is refused', unknown.status, 400)
    t.ok('listing the ones that work', /md, txt, html/.test(unknown.body.error), unknown.body.error)

    // The extension records what the author meant. It changes nothing about how
    // the file is handled — .html is still bytes, served as a download.
    const htmlStep = (await stage.request(`${root}/${issue.id}`)).body.steps.find((x) => x.name === 'as html')
    const served = await fetch(
      `${stage.origin}${root}/${issue.id}/steps/${htmlStep.number}/files/note.html`,
      { headers: { Authorization: `Bearer ${stage.token}` } })
    t.ok('an .html note is not served as HTML',
      !(served.headers.get('content-type') ?? '').includes('text/html'), served.headers.get('content-type'))
    t.eq('its content is untouched', (await served.text()).trim(), '<b>content</b>')
  }

  // ------------------------------------------------- 1c. paths as references
  t.section('1c. a reference can be a path, not only a URL')
  {
    const step = await stage.request(`${root}/${issue.id}/steps`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'where to look',
        links: [
          '/projects/example.invalid-project/logs/today.log',
          'https://example.com/ticket/9',
          '~/notes.txt',
          './relative/path.txt',
          'file:///etc/hosts'
        ]
      })
    })
    t.eq('a mixture of both is accepted', step.status, 201)

    const written = await fs.readFile(path.join(dir, step.body.id, 'links.md'), 'utf8')
    t.ok('the absolute path is recorded', written.includes('/projects/example.invalid-project/logs/today.log'))
    t.ok('a home-relative path too', written.includes('~/notes.txt'))
    t.ok('and a relative one', written.includes('./relative/path.txt'))
    t.ok('a file:// URL is recorded as the path it names',
      written.includes('`/etc/hosts`'), written.split('\n').find((l) => l.includes('hosts')))

    // A path is written as code rather than as a link: a browser cannot follow
    // it, and making it look clickable would promise that it could.
    t.ok('paths are literal text, not links', /^- `\/projects\//m.test(written),
      written.split('\n').find((l) => l.includes('/projects/')))
    t.ok('while the URL stays followable', /^- \[.+]\(https:\/\//m.test(written),
      written.split('\n').find((l) => l.includes('example.com')))
  }

  // ----------------------------------------------------------------- 2. files
  t.section('2. files are attached to a step')
  {
    const response = await upload(issue.id, created.body.number, 'server.log', Buffer.from('line one\nline two\n'))
    t.eq('the upload is accepted', response.status, 201)
    const step = await response.json()
    t.ok('and the file joins the step', step.files.some((f) => f.name === 'server.log'))

    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10])
    await upload(issue.id, created.body.number, 'screenshot.png', binary)
    const onDisk = await fs.readFile(path.join(dir, created.body.id, 'screenshot.png'))
    t.ok('binary content survives unchanged', onDisk.equals(binary), `${onDisk.length} bytes`)

    const empty = await upload(issue.id, created.body.number, 'nothing.txt', Buffer.alloc(0))
    t.eq('an empty file is refused', empty.status, 400)
  }

  // -------------------------------------------------------------- 3. download
  t.section('3. attachments come back as downloads, never as pages')
  {
    const response = await fetch(
      `${stage.origin}${root}/${issue.id}/steps/${created.body.number}/files/server.log`,
      { headers: { Authorization: `Bearer ${stage.token}` } })

    t.eq('the file is served', response.status, 200)
    t.eq('the bytes are unchanged', await response.text(), 'line one\nline two\n')

    /*
     * The operator's token is in this origin's sessionStorage. An uploaded .html
     * or .svg served with its own type would run as same-origin script with
     * access to it, so nothing uploaded may be given a type a browser executes.
     */
    t.ok('served as an opaque download', (response.headers.get('content-type') ?? '').includes('application/octet-stream'),
      response.headers.get('content-type'))
    t.ok('as an attachment', (response.headers.get('content-disposition') ?? '').startsWith('attachment'),
      response.headers.get('content-disposition'))
    t.eq('with sniffing disabled', response.headers.get('x-content-type-options'), 'nosniff')

    await upload(issue.id, created.body.number, 'trap.html', Buffer.from('<script>alert(1)<\/script>'))
    const html = await fetch(
      `${stage.origin}${root}/${issue.id}/steps/${created.body.number}/files/trap.html`,
      { headers: { Authorization: `Bearer ${stage.token}` } })
    t.ok('an uploaded HTML file is not served as HTML',
      !(html.headers.get('content-type') ?? '').includes('text/html'), html.headers.get('content-type'))

    const anonymous = await fetch(`${stage.origin}${root}/${issue.id}/steps/${created.body.number}/files/server.log`)
    t.eq('and none of it is readable without the token', anonymous.status, 401)
  }

  // ------------------------------------------------------------ 4. what is refused
  t.section('4. what cannot be added')
  {
    const number = created.body.number
    for (const [label, filename] of [
      ['a path', '../escape.txt'],
      ['a backslash path', '..\\escape.txt'],
      // `..` alone never reaches the handler: the URL is normalised before
      // routing, so it is refused a step earlier and answers 404 instead of 400.
      ['a bare parent', '..'],
      ['a dotfile', '.bashrc']
    ]) {
      const response = await upload(issue.id, number, filename, Buffer.from('x'))
      t.ok(`${label} is refused`, response.status >= 400 && response.status < 500, `${response.status}`)
    }

    const escaped = await fs.readdir(path.dirname(dir))
    t.ok('and nothing was written outside the step folder',
      !escaped.includes('escape.txt'), escaped.join(' '))

    for (const [label, link] of [
      ['a javascript: link', 'javascript:alert(1)'],
      ['a data: link', 'data:text/html,<script>alert(1)</script>'],
      ['an ssh: link', 'ssh://box/etc/passwd']
    ]) {
      const response = await stage.request(`${root}/${issue.id}/steps`, {
        method: 'POST', body: JSON.stringify({ name: 'bad', links: [link] })
      })
      t.eq(`${label} is refused`, response.status, 400)
      t.ok('naming the scheme it refused', /cannot be added/.test(response.body.error), response.body.error)
    }

    const ambiguous = await stage.request(`${root}/${issue.id}/steps`, {
      method: 'POST', body: JSON.stringify({ name: 'bad', links: ['example.com/no-scheme'] })
    })
    t.eq('and something that is neither is refused', ambiguous.status, 400)
    t.ok('asking for a scheme or an absolute path',
      /full http\(s\) URL or an absolute path/.test(ambiguous.body.error), ambiguous.body.error)

    const huge = await upload(issue.id, number, 'huge.bin', Buffer.alloc(26 * 1024 * 1024))
    t.ok('a file over the size limit is refused', huge.status === 413, `${huge.status}`)

    // Archiving is meant to freeze an issue, including against this.
    await stage.request(`${root}/${issue.id}/archive`, { method: 'POST', body: JSON.stringify({ overrideReason: 'test: archiving without a disposition' }) })
    const afterArchive = await stage.request(`${root}/${issue.id}/steps`, {
      method: 'POST', body: JSON.stringify({ name: 'late', text: 'too late' })
    })
    t.eq('an archived issue accepts nothing further', afterArchive.status, 409)
    const lateFile = await upload(issue.id, number, 'late.txt', Buffer.from('x'))
    t.eq('not even a file into an existing step', lateFile.status, 409)
    await stage.request(`${root}/${issue.id}/restore`, { method: 'POST' })
  }

  // --------------------------------------------------------------- 5. in the UI
  t.section('5. adding it from the panel')
  {
    const browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${issue.id}`,
      { token: stage.token })
    try {
      await browser.until(() => browser.has('Something is broken'), { label: 'the issue page' })
      t.ok('the issue folder is shown', browser.has('Issue folder'))
      t.ok('with the step already in it', browser.has('report'))
      t.ok('and a way to add more', browser.has('Add to this issue'))

      /*
       * Fields are found through their labels, not by position. An auto-growing
       * textarea renders a hidden sizer alongside the real one, so indexing into
       * the DOM types into something invisible — and a form whose labels do not
       * address its fields is broken for anyone using a screen reader anyway.
       */
      const byLabel = (text) => {
        const label = browser.all('label').find((el) => (el.textContent ?? '').trim() === text)
        if (!label?.htmlFor) return null
        return browser.window.document.getElementById(label.htmlFor)
      }

      const set = (el, value) => {
        const proto = el.tagName === 'TEXTAREA'
          ? browser.window.HTMLTextAreaElement.prototype
          : browser.window.HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
        el.dispatchEvent(new browser.window.Event('input', { bubbles: true }))
      }

      const nameField = byLabel('What is this? (optional)')
      const textField = byLabel('Text')
      const linkField = byLabel('Links and paths')
      t.ok('every field is reachable through its label',
        Boolean(nameField && textField && linkField),
        `name=${Boolean(nameField)} text=${Boolean(textField)} links=${Boolean(linkField)}`)

      const addButton = () => browser.all('button').find((el) => (el.textContent ?? '').trim() === 'Add')
      t.eq('Add is refused while the form is empty', addButton()?.disabled, true)

      // Content is what makes it submittable — not a title for the content.
      set(textField, 'x')
      await browser.until(() => addButton()?.disabled === false, { label: 'Add without a name' })
      t.eq('text alone is enough, with no name', addButton()?.disabled, false)
      set(textField, '')

      set(nameField, 'more detail')
      set(textField, 'The second save is the one that fails.')
      set(linkField, 'https://example.com/repro')
      await browser.until(() => addButton()?.disabled === false, { label: 'Add to become usable' })

      await browser.clickWhen(addButton, { label: 'Add' })
      await browser.until(() => browser.has('more detail'), { label: 'the new step', timeout: 15000 })

      const steps = (await stage.request(`${root}/${issue.id}`)).body.steps
      const added = steps.find((s) => s.name === 'more detail')
      t.ok('the step reaches the server', Boolean(added), steps.map((s) => s.name).join(', '))
      t.eq('carrying the note and the link', added.files.map((f) => f.name), ['links.md', 'note.md'])

      const text = await fs.readFile(path.join(dir, added.id, 'note.md'), 'utf8')
      t.ok('with the text as typed', text.includes('second save is the one that fails'), text.trim())

      // Reading it back in place is the other half of adding it.
      await browser.clickWhen(
        () => browser.all('.material__row').find((el) => el.textContent.includes('more detail')),
        { label: 'the step' })
      await browser.until(() => browser.has('second save is the one that fails'),
        { label: 'the note to be shown', timeout: 15000 })
      t.ok('and the panel shows it without a download', browser.has('second save is the one that fails'))
      t.ok('embedded source HTML is not executed',
        !flat(browser.window.document.body.innerHTML).includes('<script>alert(1)'))
    } finally {
      browser.close()
    }
  }

  await stage.stop()
}

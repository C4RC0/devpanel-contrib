import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { parseBasic, proxyLogin, examineLogin, identify, proxyActor } from '../server/proxy-user.mjs'
import { requireToken } from '../server/auth.mjs'
import { hostSettings } from '../server/config/host-settings.mjs'

export const name = 'proxy user — a verified reverse-proxy basic-auth login is the actor and stands in for the token'

const header = (text) => ({ authorization: 'Basic ' + Buffer.from(text).toString('base64') })
const sha = (text) => crypto.createHash('sha512').update(text).digest('hex')
const run = (mw, req) => new Promise((resolve, reject) => mw(req, null, (e) => (e ? reject(e) : resolve())))

export default async function (t) {
  const usersDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-users-'))
  await fs.mkdir(path.join(usersDir, 'alice'))
  await fs.writeFile(path.join(usersDir, 'alice', '.hash'), sha('secret') + '\n')
  await fs.mkdir(path.join(usersDir, 'anna'))
  await fs.writeFile(path.join(usersDir, 'anna', '.password'), 'a:b:c\n')
  await fs.writeFile(path.join(usersDir, 'anna', '.hash'), sha('older') + '\n')
  await fs.symlink(path.join(usersDir, 'alice'), path.join(usersDir, 'mallory'))
  try {
    t.section('1. the header is parsed at the first colon and names are checked')
    t.eq('user:password', parseBasic(header('alice:secret').authorization), { user: 'alice', password: 'secret' })
    t.eq('a Bearer header is no login', parseBasic('Bearer abc'), null)
    t.eq('a name with a space is refused', parseBasic(header('bad name:x').authorization), null)
    t.eq('no colon is refused', parseBasic(header('alice').authorization), null)

    t.section('2. a login is verified against the proxy\'s users directory')
    t.eq('.hash matches', await proxyLogin(header('alice:secret'), { usersDir }), { user: 'alice', verified: true })
    t.eq('a wrong password is no one', await proxyLogin(header('alice:guess'), { usersDir }), null)
    t.eq('an empty password is no one', await proxyLogin(header('alice:'), { usersDir }), null)
    t.eq('a .password admits, colons kept', await proxyLogin(header('anna:a:b:c'), { usersDir }), { user: 'anna', verified: true })
    t.eq('a .hash beside a .password admits too: two credentials', await proxyLogin(header('anna:older'), { usersDir }), { user: 'anna', verified: true })
    t.eq('an unknown user is no one', await proxyLogin(header('nobody:secret'), { usersDir }), null)
    t.eq('a symlinked user directory is refused', await proxyLogin(header('mallory:secret'), { usersDir }), null)
    t.eq('without a users directory the name is unverified', await proxyLogin(header('alice:x'), { usersDir: path.join(usersDir, 'none') }), { user: 'alice', verified: false })

    t.section('2a. the digest files are configured: the proxy\'s own login and the user\'s own credential, both admit')
    await fs.mkdir(path.join(usersDir, 'kati'))
    await fs.writeFile(path.join(usersDir, 'kati', '.proxy.hash'), sha('proxy-login') + '\n')
    await fs.writeFile(path.join(usersDir, 'kati', '.hash'), sha('own-password') + '\n')
    const digestFiles = ['.proxy.hash', '.hash']
    t.eq('the proxy\'s login, named in the host settings', await proxyLogin(header('kati:proxy-login'), { usersDir, digestFiles }), { user: 'kati', verified: true })
    t.eq('the user\'s own credential', await proxyLogin(header('kati:own-password'), { usersDir, digestFiles }), { user: 'kati', verified: true })
    t.eq('neither', await proxyLogin(header('kati:other'), { usersDir, digestFiles }), null)
    t.eq('by default only .hash is read: the proxy\'s file admits nothing', await proxyLogin(header('kati:proxy-login'), { usersDir }), null)
    const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-users-settings-'))
    const published = path.join(hostDir, os.hostname(), 'users')
    await fs.mkdir(published, { recursive: true })
    await fs.cp(path.join(usersDir, 'kati'), path.join(published, 'kati'), { recursive: true })
    await fs.writeFile(path.join(hostDir, 'settings.json'), JSON.stringify({ proxyLogin: { usersDir: `${hostDir}/{hostname}/users`, digestFiles } }))
    const settings = hostSettings({ hostDir })
    t.eq('the host settings give the directory ({hostname} replaced) and the files', [settings.proxyLogin.usersDir, settings.proxyLogin.digestFiles], [published, digestFiles])
    t.eq('which admit as given', await proxyLogin(header('kati:proxy-login'), { usersDir: settings.proxyLogin.usersDir, digestFiles: settings.proxyLogin.digestFiles }), { user: 'kati', verified: true })
    t.eq('without any users directory a login is attribution only', await proxyLogin(header('kati:x'), { usersDir: null }), { user: 'kati', verified: false })
    await fs.rm(hostDir, { recursive: true, force: true })

    t.section('2b. a refused login says why, never with the secret')
    const why = async (headers) => (await examineLogin(headers, { usersDir })).reason
    t.eq('no header', await why({}), 'no-basic-header')
    t.eq('a Bearer header', await why({ authorization: 'Bearer x' }), 'no-basic-header')
    t.eq('garbage after Basic', await why({ authorization: 'Basic !!!' }), 'unparsable-header')
    t.eq('wrong password', await why(header('alice:guess')), 'bad-password')
    t.eq('unknown user', await why(header('nobody:x')), 'no-credential')
    t.eq('empty password', await why(header('alice:')), 'empty-password')
    t.eq('verified has no reason', await why(header('alice:secret')), null)

    t.section('3. the token gate admits a verified login, nothing less')
    const gate = requireToken('the-token')
    const status = async (headers, dir = usersDir) => {
      const req = { path: '/api/x', headers }
      await run(identify({ usersDir: dir }), req)
      let code = 200
      gate(req, { status: (c) => { code = c; return { json: () => {} } } }, () => {})
      return code
    }
    t.eq('verified login, no token', await status(header('alice:secret')), 200)
    t.eq('wrong password, no token', await status(header('alice:guess')), 401)
    t.eq('unverified name, no token', await status(header('alice:x'), path.join(usersDir, 'none')), 401)
    t.eq('the token alone still works', await status({ 'x-devpanel-token': 'the-token' }), 200)

    t.section('4. the login overrides whatever actor the body claims')
    {
      const req = { headers: header('alice:secret'), body: { actor: 'someone else', answer: 'yes' } }
      await run(identify({ usersDir }), req)
      proxyActor()(req, null, () => {})
      t.eq('req.actor', req.actor, 'alice')
      t.eq('body.actor replaced, the rest kept', req.body, { actor: 'alice', answer: 'yes' })
    }
    {
      const req = { headers: {}, body: { actor: 'typed' } }
      await run(identify({ usersDir }), req)
      proxyActor()(req, null, () => {})
      t.eq('without a login the typed actor stays', [req.actor, req.body.actor], [null, 'typed'])
    }
  } finally {
    await fs.rm(usersDir, { recursive: true, force: true })
  }
}

import net from 'node:net'

import { sandbox } from '../../helpers.mjs'

export const name = 'fixture: a listen the host denies, awaited without an error handler'

export default async function (t) {
  console.log(`SANDBOX ${await sandbox()}`)
  t.ok('before the listen', true)
  const server = net.createServer()
  await new Promise((resolve) => server.listen(process.env.DENIED_SOCKET, resolve))
  t.ok('never reached', true)
}

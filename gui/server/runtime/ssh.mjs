import fs from 'node:fs/promises'

export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`

export async function reference (ref) {
  if (!ref) return null
  const index = ref.indexOf(':')
  const kind = ref.slice(0, index), value = ref.slice(index + 1)
  if (kind === 'ssh-config') return value
  if (kind === 'env') return process.env[value] ?? null
  if (kind === 'file') return (await fs.readFile(value, 'utf8')).trim()
  return null
}

export async function sshConnection (ssh) {
  const host = await reference(ssh.hostRef)
  const user = await reference(ssh.userRef)
  if (!host || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(host)) throw new Error('SSH host reference is missing or invalid')
  if (ssh.userRef && (!user || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(user))) throw new Error('SSH user reference is missing or invalid')
  let identity = null
  if (ssh.identityRef?.startsWith('file:')) {
    identity = ssh.identityRef.slice(5)
    await fs.access(identity) // Check the key path without reading private key bytes.
  } else if (ssh.identityRef?.startsWith('env:')) {
    identity = await reference(ssh.identityRef)
    if (!identity) throw new Error('SSH identity path reference is missing')
  }
  return { command: process.env.DEVPANEL_SSH_BIN ?? 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', ...(identity ? ['-i', identity] : []), user ? `${user}@${host}` : host] }
}

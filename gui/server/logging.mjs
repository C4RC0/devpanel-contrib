import fs from 'node:fs'
import path from 'node:path'
import { format } from 'node:util'

export function createFileLogger ({ dir, maxBytes = 10 * 1024 * 1024, backups = 5, secrets = [] }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || !Number.isSafeInteger(backups) || backups < 1 || backups > 20) throw new Error('Invalid log rotation limits')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, 'devpanel.jsonl')
  const sensitive = new Set(secrets.filter(s => typeof s === 'string' && s.length >= 8))
  let warned = false
  const redact = (text) => {
    for (const secret of sensitive) text = text.split(secret).join('[REDACTED]')
    return text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
  }
  function write (level, message) {
    const clean = redact(String(message))
    const line = JSON.stringify({ at: new Date().toISOString(), level, pid: process.pid, message: clean.slice(0, Math.min(16000, Math.floor(maxBytes / 12))) }) + '\n'
    try {
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0
      if (size + Buffer.byteLength(line) > maxBytes) {
        for (let i = backups; i >= 1; i--) {
          const source = i === 1 ? file : `${file}.${i - 1}`
          const target = `${file}.${i}`
          if (fs.existsSync(source)) fs.renameSync(source, target)
        }
      }
      fs.appendFileSync(file, line, { mode: 0o600 })
      warned = false
    } catch (error) {
      if (!warned) process.stderr.write(`devpanel file logging failed: ${error.code ?? 'write error'}\n`)
      warned = true
    }
    return clean
  }
  return { file, write, redact, addSecret: value => { if (typeof value === 'string' && value.length >= 8) sensitive.add(value) } }
}

export function installLogging (options) {
  const secrets = Object.entries(process.env).filter(([key]) => /(?:TOKEN|KEY|SECRET|PASSWORD)$/.test(key)).map(([, value]) => value)
  const logger = createFileLogger({ ...options, secrets: [...secrets, ...(options.secrets ?? [])] })
  const originals = {}
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[level] = console[level]
    console[level] = (...args) => originals[level].call(console, logger.write(level === 'log' ? 'info' : level, format(...args)))
  }
  const fatal = (error, origin) => logger.write('fatal', `${origin}: ${error.stack ?? error}`)
  // Observe without suppressing Node's normal crash/exit behavior.
  process.on('uncaughtExceptionMonitor', fatal)
  return { ...logger, restore: () => { Object.assign(console, originals); process.off('uncaughtExceptionMonitor', fatal) } }
}

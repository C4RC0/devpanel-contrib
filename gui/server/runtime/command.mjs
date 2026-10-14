import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// A system service need not inherit the login shell's ~/.local/bin PATH.
// Explicit adapter overrides always win, including intentionally missing shims.
export function resolveCommand (name, override, { envPath = process.env.PATH ?? '', home = os.homedir() } = {}) {
  if (override) return override
  for (const dir of [...envPath.split(path.delimiter).filter(Boolean), path.join(home, '.local', 'bin')]) {
    const candidate = path.join(dir, name)
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate } catch { /* try the next installation */ }
  }
  return name
}

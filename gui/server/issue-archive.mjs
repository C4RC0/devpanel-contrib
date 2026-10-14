import fs from 'node:fs/promises'
import path from 'node:path'

export const ARCHIVE_FILE = '.archive.json'

// Keep archived issue trees in place: Git worktrees and native sessions can
// contain absolute paths into them. Archiving changes visibility, never files.
export async function archiveState (dir) {
  try {
    const text = await fs.readFile(path.join(dir, ARCHIVE_FILE), 'utf8')
    try { return JSON.parse(text) || { archivedAt: null } } catch { return { archivedAt: null } }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function requireUnarchived (dir) {
  if (await archiveState(dir)) {
    throw Object.assign(new Error('This issue is archived. Restore it before making changes.'), { status: 409 })
  }
}

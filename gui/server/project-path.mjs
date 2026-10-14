import fs from 'node:fs/promises'
import path from 'node:path'

import { hostSettings } from './config/host-settings.mjs'

/*
 * Where projects live and what makes a directory one, defined once for the
 * server and the harness: every `<name>-project` entry of the projects root
 * (DEVPANEL_PROJECTS_DIR, else the host settings' projectsRoot, else the
 * directory holding the panel's own checkout). The root is read on each call;
 * a module that keeps it in a constant (issues.js, supervisor.mjs) reads it at load.
 */
export const projectsRoot = () => process.env.DEVPANEL_PROJECTS_DIR ?? hostSettings().projectsRoot
export const PROJECT_SUFFIX = '-project'
export const isProjectName = (name) => name.endsWith(PROJECT_SUFFIX)
export const projectLabel = (name) => name.slice(0, -PROJECT_SUFFIX.length)

/** Where a project lives, unresolved (no realpath). */
export const projectPath = (project, root = projectsRoot()) => path.join(root, project)

export async function resolveProjectPath (project, { projectsDir = projectsRoot() } = {}) {
  if (!project || path.basename(project) !== project || ['.', '..'].includes(project)) throw new Error('Invalid project identity')
  const canonical = await fs.realpath(path.join(projectsDir, project))
  if (!(await fs.stat(canonical)).isDirectory()) throw new Error(`Project is not a directory: ${canonical}`)
  return canonical
}

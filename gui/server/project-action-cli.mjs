#!/usr/bin/env node
/*
 * Run a project action from a terminal, as the service account, with the same
 * record and streamed output the panel and the supervisor get:
 *
 *   node gui/server/project-action-cli.mjs <project> [action]     (default: checkpoint)
 *   node gui/server/project-action-cli.mjs <project> --list
 *
 * Exit status follows the script. The operation record and output are kept
 * under issues/<project>/.actions/<operation-id>/.
 */
import { CONFIG_ROOT } from './config/load.mjs'
import { listProjectActions, startProjectAction } from './project-actions.mjs'

const [project, arg = 'checkpoint'] = process.argv.slice(2)
if (!project) throw new Error('Usage: node gui/server/project-action-cli.mjs <project> [action|--list]')
const root = process.env.DEVPANEL_CONFIG_ROOT ?? CONFIG_ROOT

if (arg === '--list') {
  const listing = await listProjectActions(project, { root })
  console.log(JSON.stringify(listing, null, 2))
  process.exit(0)
}

const controller = new AbortController()
const stop = () => controller.abort()
process.once('SIGINT', stop); process.once('SIGTERM', stop)
try {
  const { operation, done } = await startProjectAction({
    project, actionId: arg, root, signal: controller.signal, actor: `cli (${process.env.USER ?? 'unknown'})`,
    emit: (event) => {
      if (event.type === 'output') (event.entry.kind === 'stderr' ? process.stderr : process.stdout).write(event.entry.text.endsWith('\n') || event.entry.kind === 'stdout' || event.entry.kind === 'stderr' ? event.entry.text : `${event.entry.text}\n`)
    }
  })
  console.error(`operation ${operation.id}: ${operation.run} (in ${operation.cwd})`)
  const result = await done
  console.error(`operation ${operation.id}: ${result.status}${result.exitCode !== null ? ` (exit ${result.exitCode})` : ''}`)
  process.exitCode = result.status === 'completed' ? 0 : (result.exitCode ?? 1) || 1
} finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }

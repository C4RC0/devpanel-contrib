import { runtimeErrors, runtimeResult } from '../../harness/claude.mjs'
import { codexErrors } from '../../harness/codex.mjs'
import { classifyFailure } from '../server/runtime/failure.mjs'

const line = (o) => JSON.stringify(o)

export default async function (t) {
  t.section('claude: the runtime\'s error messages are classified, the model\'s text is not')
  {
    const spend = [
      line({ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'Working on it.' }] } }),
      line({ type: 'assistant', error: 'rate_limit', is_api_error_message: true, message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your monthly spend limit. Switch to another model." }] } }),
      line({ type: 'result', stop_reason: 'stop_sequence', total_cost_usd: 6.01 })
    ].join('\n')
    t.eq('a monthly spend limit is quota', classifyFailure({ message: 'claude exited 1', stdout: runtimeErrors(spend) }).class, 'quota')

    const talk = [
      line({ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'I fixed the HTTP 429 too many requests path and the quota exceeded message.' }] } }),
      line({ type: 'result', is_error: false, result: 'Done: 429 rate limit handling and usage limit banner.' })
    ].join('\n')
    const talked = classifyFailure({ message: 'claude exited 1', stdout: runtimeErrors(talk), payload: runtimeResult({ type: 'result', is_error: false, result: 'handled 429 and quota exceeded' }) })
    t.eq('an agent describing a 429 is not a provider rate limit', talked.class, 'runtime')

    const failedResult = runtimeResult({ type: 'result', is_error: true, subtype: 'error_during_execution', result: 'API Error: 529 overloaded' })
    t.eq('a result the runtime marked as an error keeps its text', classifyFailure({ message: 'claude exited 1', payload: failedResult }).class, 'rate-limit')
  }

  t.section('codex: error and turn.failed events are read from the JSON stream')
  {
    const stream = [
      line({ type: 'thread.started', thread_id: 't' }),
      line({ type: 'item.completed', item: { type: 'agent_message', text: 'The insufficient_quota branch now retries.' } }),
      line({ type: 'turn.failed', error: { message: 'stream error: exceeded retry limit, last status: 429 Too Many Requests' } })
    ].join('\n')
    t.eq('a failed turn with a 429 is a rate limit', classifyFailure({ message: 'codex exited 1', stdout: codexErrors(stream) }).class, 'rate-limit')
    t.eq('the agent message is not evidence', codexErrors(stream).includes('insufficient_quota'), false)
  }
}

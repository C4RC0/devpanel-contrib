import { createRenderer, formatEvent, wrapLine } from '../src/terminal-format.js'
import { describeCommand } from '../server/runtime/command-line.mjs'
import { markdownLines, parseInline } from '../src/terminal-markdown.js'

// Colour codes are not what is being tested; the words and their order are.
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

export default async function (t) {
  t.section('the command line opens the terminal')
  const cmd = describeCommand({ command: 'claude', args: ['-p', '--model', 'claude-opus-5-5', '--append-system-prompt', 'x'.repeat(500), 'ANTHROPIC_API_KEY=sk-ant-abcdefghijkl'], cwd: '/work/w' })
  t.ok('a long argument is shortened and says how long it was', cmd.args[4].endsWith('(500 chars)'))
  t.ok('a key-looking argument is redacted', !cmd.args[5].includes('abcdefghijkl') && cmd.args[5].includes('[redacted]'), cmd.args[5])
  const opening = plain(createRenderer().write({ seq: 1, kind: 'spawn', text: 'process 7 started', ...cmd }))
  t.ok('it shows the directory', opening.includes('# /work/w'))
  t.ok('and the command as a prompt', opening.includes('$ claude -p --model claude-opus-5-5'))
  t.ok('an older spawn entry without a command still reads', plain(createRenderer().write({ seq: 1, kind: 'spawn', text: 'process 7 started' })).includes('process 7 started'))

  t.section('Claude Code events read like its transcript')
  const tool = plain(formatEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }))
  t.ok('a tool call is titled by its argument', tool.includes('● Bash(npm test)'), tool)
  const result = plain(formatEvent({ type: 'user', message: { content: [{ type: 'tool_result', content: 'a\nb\nc\nd\ne\nf' }] } }))
  t.ok('a result shows its first lines', result.includes('└ a') && result.includes('d'))
  t.ok('and counts the rest', result.includes('+2 lines'), result)
  t.ok('an error result is still shown', plain(formatEvent({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'boom' }] } })).includes('boom'))
  const done = plain(formatEvent({ type: 'result', subtype: 'success', num_turns: 3, duration_ms: 125000, total_cost_usd: 0.3141, usage: { input_tokens: 2, output_tokens: 1500, cache_read_input_tokens: 40000 } }))
  t.ok('the end names turns, time as hh:mm:ss and tokens in millions', done.includes('✓ success') && done.includes('3 turns') && done.includes('00:02:05') && done.includes('0.04 M tokens'), done)
  t.ok('and never money', !done.includes('$'), done)
  t.eq('thinking-token ticks are not printed', formatEvent({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 }), '')

  t.section('Codex events read the same way')
  t.ok('a command is a Shell call without the bash -lc wrapper',
    plain(formatEvent({ type: 'item.started', item: { type: 'command_execution', command: "/bin/bash -lc 'ls -la'" } })).includes('● Shell(ls -la)'))
  t.ok('a failed command is shown with its output',
    plain(formatEvent({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'no such file', exit_code: 2 } })).includes('no such file'))
  t.ok('an agent message is prose', plain(formatEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } })).includes('● Done.'))

  t.section('the renderer is incremental and wraps to the width')
  const r = createRenderer({ cols: 40 })
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'word '.repeat(30).trim() }] } }) + '\n'
  t.eq('half a line prints nothing yet', r.write({ seq: 2, kind: 'stdout', text: line.slice(0, 20) }), '')
  const prose = plain(r.write({ seq: 3, kind: 'stdout', text: line.slice(20) })).split('\r\n').filter(Boolean)
  t.ok('the completed line prints', prose.length > 1)
  t.ok('wrapped at words within the width', prose.every((l) => l.length <= 40 && !/wor$/.test(l)), prose.join('|'))
  t.eq('a long word is cut', wrapLine('x'.repeat(25), 10), ['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx'])
  t.ok('stderr is shown as it came', plain(r.write({ seq: 4, kind: 'stderr', text: 'warning: x\n' })).includes('warning: x'))
  t.ok('raw mode writes stdout unformatted', createRenderer({ raw: true }).write({ seq: 1, kind: 'stdout', text: '{"type":"x"}\n' }).includes('{"type":"x"}'))

  t.section('Markdown is drawn, not printed')
  const md = (text, width = 60) => markdownLines(text, width).map(plain)
  t.eq('markers are removed and the words kept', parseInline('the **resize** uses `fit()` and _old_ frames').text, 'the resize uses fit() and old frames')
  t.eq('snake_case is not italic', parseInline('a snake_case_name here').text, 'a snake_case_name here')
  t.ok('bold is styled', markdownLines('**yes**').join('').includes('\x1b[1m'))
  t.ok('code is styled', markdownLines('`x`').join('').includes('\x1b[36m'))
  t.eq('a link keeps its address', md('see [docs](https://a.b/c)'), ['see docs (https://a.b/c)'])
  t.eq('a heading loses its hashes', md('## Result'), ['Result'])
  t.eq('lists become bullets, nested ones indented', md('- one\n  - two\n3. three'), ['• one', '  ◦ two', '3. three'])
  t.eq('a wrapped list item hangs under its text', md('- ' + 'word '.repeat(8).trim(), 20), ['• word word word', '  word word word', '  word word'])
  const styled = markdownLines('a **bold phrase that wraps** here', 12)
  t.ok('a style broken by wrapping continues on the next line', styled.filter((l) => l.includes('\x1b[1m')).length >= 2, JSON.stringify(styled))
  t.ok('no wrapped line is wider than asked', md('word '.repeat(40), 30).every((l) => l.length <= 30))
  t.eq('a table becomes aligned columns', md('| A | Bee |\n|---|---|\n| **x** | y |'), ['A │ Bee', '──┼────', 'x │ y  '])
  t.eq('a table too wide for the terminal becomes lines', md('| alpha | beta |\n|---|---|\n| one | two |', 8), ['alpha ·', 'beta', 'one ·', 'two'])
  t.eq('fenced code keeps its text and names its language', md('```json\n{ "a": 1 }\n```'), ['  ┌ json', '  │ { "a": 1 }'])
  t.eq('a long code line is wrapped, not cut, and marked as continued', md('```\n' + 'x'.repeat(30) + '\n```', 20), ['  │ ' + 'x'.repeat(16), '  ┆ ' + 'x'.repeat(14)])
  const json = markdownLines('```json\n{ "verdict": "approved", "n": 3, "ok": true }\n```').join('')
  t.ok('JSON keys, strings and literals are coloured apart', json.includes('\x1b[34m"verdict"') && json.includes('\x1b[32m"approved"') && json.includes('\x1b[35m3') && json.includes('\x1b[35mtrue'))
  const wrappedString = markdownLines('```json\n{ "note": "' + 'word '.repeat(12) + '" }\n```', 30)
  t.ok('a wrapped JSON string stays coloured on its continuation', wrappedString.filter((l) => l.includes('\x1b[32m')).length >= 2, JSON.stringify(wrappedString))
  t.eq('two blank lines become one', md('a\n\n\nb'), ['a', '', 'b'])
}

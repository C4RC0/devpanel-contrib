import { contiguous, mergeEntries, parseRows } from '../src/live-log.js'

export const name = 'live log — merging without duplicates, and rows from event lines'

const e = (seq, kind = 'stdout', text = `${seq}\n`) => ({ seq, kind, text, at: null })

export default async function (t) {
  t.section('1. a chunk that arrives twice lands once')
  {
    // A socket event and the backlog page that also contained it.
    const a = mergeEntries([], [e(1)])
    const b = mergeEntries(a.entries, [e(1), e(2)])
    t.eq('sequence is 1,2 not 1,1,2', b.entries.map((x) => x.seq).join(','), '1,2')
    t.eq('next is the highest seq', b.next, 2)
    const c = mergeEntries(b.entries, [e(2)])
    t.eq('an exact repeat changes nothing', c.entries, b.entries)
  }

  t.section('2. order is by sequence, whatever the arrival order')
  {
    const m = mergeEntries([e(1), e(3)], [e(2)])
    t.eq('the late entry lands in place', m.entries.map((x) => x.seq).join(','), '1,2,3')
    t.eq('and the list is contiguous again', contiguous(m.entries), true)
    t.eq('a gap is detected', contiguous([e(1), e(3)]), false)
    t.eq('entries without a sequence are ignored', mergeEntries([], [{ kind: 'stdout', text: 'x' }]).entries.length, 0)
  }

  t.section('3. the list is bounded')
  {
    const many = Array.from({ length: 12 }, (_, i) => e(i + 1))
    const m = mergeEntries([], many, { max: 5 })
    t.eq('only the newest are kept', m.entries.map((x) => x.seq).join(','), '8,9,10,11,12')
    t.eq('next still names the last', m.next, 12)
  }

  t.section('4. event lines split across chunks parse once the line completes')
  {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { f: 'a' } }] } }) + '\n'
    const half = Math.floor(line.length / 2)
    const rows = parseRows([e(1, 'stdout', line.slice(0, half)), e(2, 'stdout', line.slice(half))])
    t.eq('one tool row', rows.length, 1)
    t.eq('of the right kind', rows[0].kind, 'tool')
    t.ok('naming the tool', rows[0].text.startsWith('Read '))
  }

  t.section('5. every kind of entry has a row')
  {
    const rows = parseRows([
      e(1, 'spawn', 'process 1 started'),
      e(2, 'stderr', 'warn a\nwarn b\n'),
      e(3, 'stdout', JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 65000, usage: { input_tokens: 2000, output_tokens: 500 } }) + '\n'),
      e(4, 'stdout', 'plain text line\n'),
      e(5, 'truncated', 'capped'),
      e(6, 'exit', 'done')
    ])
    t.eq('kinds in order', rows.map((r) => r.kind).join(','), 'spawn,stderr,stderr,done,stdout,truncated,exit')
    t.ok('the result row shows the cost as time and tokens', rows[3].text.includes('00:01:05') && rows[3].text.includes('0.0025 M tokens') && !rows[3].text.includes('$'), rows[3].text)
    const partial = parseRows([e(1, 'stdout', 'no newline yet')])
    t.eq('an unfinished line is shown as partial', partial[0].partial, true)
  }
}

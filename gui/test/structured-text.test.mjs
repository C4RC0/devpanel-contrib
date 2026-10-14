import { embeddedJson, scanJson, segments } from '../src/structured-text.js'

export default async function (t) {
  t.section('prose and JSON are told apart')
  const prompt = 'Audit this.\n\n### issue\n{\n  "id": "x",\n  "note": "a } inside a string"\n}\n\n### reports\n[\n  { "response": "```json\\n{\\"fit\\": true}\\n```" }\n]\nReturn JSON.'
  const parts = segments(prompt)
  t.eq('headings stay prose, bare JSON becomes data', parts.map((p) => p.type), ['markdown', 'json', 'markdown', 'json', 'markdown'])
  t.eq('a brace inside a string does not end the object', parts[1].value.note, 'a } inside a string')
  t.eq('nothing is lost', parts.map((p) => p.type === 'json' ? p.source : p.text).join('').replace(/\s/g, ''), prompt.replace(/\s/g, ''))
  t.eq('fenced JSON is data', segments('Result:\n```json\n{"verdict": "approved"}\n```\n').map((p) => p.type), ['markdown', 'json'])
  t.eq('an unlabelled fence that parses is data', segments('```\n[1, 2]\n```').map((p) => p.type), ['json'])
  t.eq('a fence that does not parse stays prose', segments('```json\n{ nope\n```').map((p) => p.type), ['markdown'])
  t.eq('a Markdown link at a line start is not JSON', segments('[docs](https://a.b)\nmore').map((p) => p.type), ['markdown'])
  t.eq('JSON followed by text on its closing line stays prose', segments('{"a": 1} and more').map((p) => p.type), ['markdown'])
  t.eq('an unbalanced bracket is found as such', scanJson('{"a": [1, 2}', 0), -1)

  t.section('strings holding JSON are recognised')
  t.eq('a JSON object in a string', embeddedJson(' {"a": 1} '), { a: 1 })
  t.eq('prose is not', embeddedJson('{not json}'), undefined)
  t.eq('a bare number is not unfolded', embeddedJson('3'), undefined)
}

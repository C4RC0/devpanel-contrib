export const name = 'fixture: a rejection nobody awaits, in a suite that completes'

export default async function (t) {
  Promise.reject(new Error('unawaited suite rejection'))
  t.ok('suite completes', true)
}

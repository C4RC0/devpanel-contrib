export const name = 'fixture: a rejection nobody awaits'

export default async function () {
  Promise.reject(new Error('stray rejection'))
  await new Promise(() => {})
}

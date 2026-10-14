import path from 'node:path'
import { withStepReservation } from '../step-allocation.mjs'
import { writeAtomic } from './persistence.mjs'
export async function createStepAt (dir, {name, response, invocationId, origin = 'agent-turn'}) {
  return withStepReservation(dir,{slug:name,invocationId,origin},async entry=>{
    await writeAtomic(path.join(dir,entry.folder,'response.md'),response)
    return entry
  })
}

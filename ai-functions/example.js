import { AI } from './ai.js'

const { ai, list, gpt } = AI()

for await (const item of list`fun things to do in Miami`) {
  console.log(item)
}
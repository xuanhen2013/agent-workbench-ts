import type { ReActModel } from '@/agent/react/model-adapter'
import { MemorySaver } from '@langchain/langgraph'
import { createInterruptGraph } from '@/agent/interrupt/interrupt-graph'

export class FakeJokeModel implements ReActModel {
  readonly calls: Array<{ historyLength: number }> = []
  private index = 0

  constructor(private readonly jokes: string[]) {}

  runTurn: ReActModel['runTurn'] = async (input) => {
    input.signal.throwIfAborted()
    this.calls.push({ historyLength: input.history.length })
    const finalText = this.jokes[this.index++]

    return {
      continuationItems: [],
      functionCalls: [],
      ...(finalText === undefined ? {} : { finalText }),
    }
  }
}

export function createJokeGraphFixture(
  jokes = ['第一个笑话', '第二个笑话', '第三个笑话'],
) {
  const model = new FakeJokeModel(jokes)
  const graph = createInterruptGraph({
    checkpointer: new MemorySaver(),
    model,
  })
  return { graph, model }
}

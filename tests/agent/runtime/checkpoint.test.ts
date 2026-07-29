import type {
  ModelTurn,
  ReActModel,
} from '@/agent/react/model-adapter'
import type { OpenAIResponseInputItem } from '@/clients/openai'
import type { WeatherData, WeatherProvider } from '@/tools/weather/provider'
import {
  END,
  MemorySaver,
  ReducedValue,
  START,
  StateGraph,
  StateSchema,
} from '@langchain/langgraph'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createReActGraph } from '@/agent/react/react-graph'
import { ReActStatus } from '@/agent/react/state'
import {
  ToolExecutor,
  ToolRegistry,
} from '@/tools/_core'
import { toResponseTool } from '@/tools/_core/adapters/openai-response'
import { createWeatherTool } from '@/tools/weather'

const CheckpointState = new StateSchema({
  history: new ReducedValue(
    z.array(z.string()).default(() => []),
    { reducer: (left, right) => left.concat(right) },
  ),
  status: z.enum(['pending', 'completed']).default('pending'),
})

function createCheckpointGraph(checkpointer: MemorySaver) {
  return new StateGraph(CheckpointState)
    .addNode('collect', state => ({
      history: [`collect:${state.history.at(-1) ?? 'missing'}`],
    }))
    .addNode('finish', () => ({ status: 'completed' as const }))
    .addEdge(START, 'collect')
    .addEdge('collect', 'finish')
    .addEdge('finish', END)
    .compile({ checkpointer })
}

class ScriptedReActModel implements ReActModel {
  readonly histories: OpenAIResponseInputItem[][] = []

  private readonly turns: ModelTurn[]

  constructor(turns: ModelTurn[]) {
    this.turns = [...turns]
  }

  async runTurn(input: Parameters<ReActModel['runTurn']>[0]): Promise<ModelTurn> {
    this.histories.push([...input.history])

    const turn = this.turns.shift()
    if (!turn) {
      throw new Error('The fake model received more turns than expected.')
    }

    return turn
  }
}

class FakeWeatherProvider implements WeatherProvider {
  readonly cities: string[] = []

  async getCurrentWeather(
    input: { city: string },
    _options: { signal: AbortSignal },
  ): Promise<WeatherData> {
    this.cities.push(input.city)
    return {
      city: input.city,
      temperatureC: 30,
      condition: 'Sunny',
      observedAt: '2026-07-28T00:00:00.000Z',
    }
  }
}

function functionCall(
  callId: string,
  name: string,
  arguments_: string,
): OpenAIResponseInputItem {
  return {
    type: 'function_call',
    call_id: callId,
    name,
    arguments: arguments_,
  }
}

describe('LangGraph checkpoint persistence', () => {
  test('同一 thread 合并 history、不同 thread 隔离，并保留多个 checkpoint', async () => {
    const checkpointer = new MemorySaver()
    const graph = createCheckpointGraph(checkpointer)
    const threadA = { configurable: { thread_id: 'checkpoint-thread-a' } }

    await graph.invoke({ history: ['first'] }, {
      ...threadA,
      durability: 'sync',
    })
    await graph.invoke({ history: ['second'] }, {
      ...threadA,
      durability: 'sync',
    })

    const threadAState = await graph.getState(threadA)
    expect(threadAState.values).toMatchObject({
      history: [
        'first',
        'collect:first',
        'second',
        'collect:second',
      ],
      status: 'completed',
    })
    expect(threadAState.next).toEqual([])

    const history = []
    for await (const snapshot of graph.getStateHistory(threadA)) {
      history.push(snapshot)
    }
    expect(history.length).toBeGreaterThan(1)

    const threadB = { configurable: { thread_id: 'checkpoint-thread-b' } }
    await graph.invoke({ history: ['only-b'] }, {
      ...threadB,
      durability: 'sync',
    })
    const threadBState = await graph.getState(threadB)
    expect(threadBState.values).toMatchObject({
      history: ['only-b', 'collect:only-b'],
      status: 'completed',
    })
    expect(threadBState.values).not.toMatchObject({
      history: expect.arrayContaining(['first']),
    })
  })

  test('启用 checkpointer 但缺少 thread_id 时拒绝执行', async () => {
    const graph = createCheckpointGraph(new MemorySaver())

    await expect(graph.invoke({ history: ['missing-thread-id'] }, {
      durability: 'sync',
    })).rejects.toThrow()
  })

  test('ReAct Graph 通过同一个 MemorySaver 保存本地 Fake Model/Fake Tool 的终态', async () => {
    const checkpointer = new MemorySaver()
    const weatherProvider = new FakeWeatherProvider()
    const weatherTool = createWeatherTool(weatherProvider)
    const registry = new ToolRegistry()
    registry.register(weatherTool)
    const toolCall = {
      callId: 'checkpoint-weather-call',
      name: 'get_weather',
      arguments: JSON.stringify({ city: '深圳' }),
    }
    const model = new ScriptedReActModel([
      {
        continuationItems: [
          functionCall(toolCall.callId, toolCall.name, toolCall.arguments),
        ],
        functionCalls: [toolCall],
      },
      {
        continuationItems: [],
        functionCalls: [],
        finalText: '深圳晴天，30°C。',
      },
    ])
    const graph = createReActGraph({
      model,
      executor: new ToolExecutor(registry),
      tools: [toResponseTool(weatherTool)],
      instructions: 'Checkpoint integration test.',
    }, { checkpointer })
    const threadId = 'react-checkpoint-thread'

    const output = await graph.invoke({
      goal: '查询深圳天气',
    }, {
      context: { runId: 'react-checkpoint-run' },
      configurable: { thread_id: threadId },
      durability: 'sync',
    })
    const snapshot = await graph.getState({
      configurable: { thread_id: threadId },
    })

    expect(output).toMatchObject({
      status: ReActStatus.Completed,
      answer: '深圳晴天，30°C。',
    })
    expect(weatherProvider.cities).toEqual(['深圳'])
    expect(snapshot.values).toMatchObject({
      status: ReActStatus.Completed,
      answer: '深圳晴天，30°C。',
    })
    expect(snapshot.values.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: '查询深圳天气' }),
      expect.objectContaining({
        type: 'function_call',
        call_id: toolCall.callId,
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: toolCall.callId,
      }),
    ]))
    expect(snapshot.next).toEqual([])
    expect(model.histories).toHaveLength(2)
  })
})

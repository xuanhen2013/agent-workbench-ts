import type {
  ModelTurn,
  ReActModel,
} from '@/agent/react/model-adapter'
import type { OpenAIResponseInputItem } from '@/clients/openai'
import type {
  ExecuteToolOptions,
  RequestedToolCall,
  ToolExecutionResult,
} from '@/tools/_core'
import type { WeatherData, WeatherProvider } from '@/tools/weather/provider'
import { describe, expect, test } from 'bun:test'
import { createReActGraph } from '@/agent/react/react-graph'
import { ReActStatus } from '@/agent/react/state'
import {
  ToolExecutor,
  ToolRegistry,
} from '@/tools/_core'
import { toResponseTool } from '@/tools/_core/adapters/openai-response'
import { createWeatherTool } from '@/tools/weather'

interface ModelFunctionCall {
  callId: string
  name: string
  arguments: string
}

class FakeReActModel implements ReActModel {
  readonly histories: OpenAIResponseInputItem[][] = []
  private readonly queuedTurns: Array<ModelTurn | Error>

  constructor(turns: Array<ModelTurn | Error>) {
    this.queuedTurns = [...turns]
  }

  async runTurn(input: Parameters<ReActModel['runTurn']>[0]): Promise<ModelTurn> {
    this.histories.push([...input.history])

    const nextTurn = this.queuedTurns.shift()
    if (!nextTurn) {
      throw new Error('FakeReActModel received more calls than were queued')
    }
    if (nextTurn instanceof Error) {
      throw nextTurn
    }

    return nextTurn
  }
}

class FakeWeatherProvider implements WeatherProvider {
  readonly calls: Array<{ city: string, signal: AbortSignal }> = []
  private readonly weatherByCity: Readonly<Record<string, WeatherData>>

  constructor(weatherByCity: Readonly<Record<string, WeatherData>>) {
    this.weatherByCity = weatherByCity
  }

  async getCurrentWeather(
    input: { city: string },
    options: { signal: AbortSignal },
  ): Promise<WeatherData> {
    this.calls.push({ city: input.city, signal: options.signal })

    const weather = this.weatherByCity[input.city]
    if (!weather) {
      throw new Error(`No fake weather was configured for ${input.city}`)
    }

    return weather
  }
}

class RecordingToolExecutor extends ToolExecutor {
  readonly calls: Array<{
    call: RequestedToolCall
    options: ExecuteToolOptions
  }> = []

  override async execute(
    call: RequestedToolCall,
    options: ExecuteToolOptions,
  ): Promise<ToolExecutionResult> {
    this.calls.push({
      call: { ...call },
      options: { ...options },
    })

    return super.execute(call, options)
  }
}

function weather(city: string, temperatureC: number, condition: string): WeatherData {
  return {
    city,
    temperatureC,
    condition,
    observedAt: '2026-07-27T10:00:00Z',
  }
}

function responseFunctionCall(call: ModelFunctionCall): OpenAIResponseInputItem {
  return {
    type: 'function_call',
    call_id: call.callId,
    name: call.name,
    arguments: call.arguments,
  }
}

function requestingTools(calls: ModelFunctionCall[]): ModelTurn {
  return {
    // Responses continuation input must contain the exact calls that Graph will execute.
    continuationItems: calls.map(responseFunctionCall),
    functionCalls: calls,
  }
}

function finalAnswer(finalText?: string): ModelTurn {
  return {
    continuationItems: [],
    functionCalls: [],
    finalText,
  }
}

function createFixture(
  turns: Array<ModelTurn | Error>,
  weatherByCity: Readonly<Record<string, WeatherData>> = {},
) {
  const model = new FakeReActModel(turns)
  const provider = new FakeWeatherProvider(weatherByCity)
  const weatherTool = createWeatherTool(provider)
  const registry = new ToolRegistry()
  registry.register(weatherTool)
  const executor = new RecordingToolExecutor(registry)
  const graph = createReActGraph({
    model,
    executor,
    tools: [toResponseTool(weatherTool)],
    instructions: 'You are a ReAct graph test model.',
  })

  return { graph, model, provider, executor }
}

async function invokeGraph(
  graph: ReturnType<typeof createReActGraph>,
  input: { goal: string, maxToolRounds?: number, maxFailures?: number },
  runId: string,
) {
  return graph.invoke(input, {
    runId,
    context: { runId },
  })
}

function modelHistory(model: FakeReActModel, turnIndex: number): OpenAIResponseInputItem[] {
  const history = model.histories[turnIndex]
  if (!history) {
    throw new Error(`Expected recorded model history at turn ${turnIndex}`)
  }

  return history
}

function countUserGoal(history: OpenAIResponseInputItem[], goal: string): number {
  return history.filter((item) => {
    if (!('role' in item) || item.role !== 'user') {
      return false
    }

    return 'content' in item && item.content === goal
  }).length
}

function functionCallOutputs(history: OpenAIResponseInputItem[]) {
  return history.filter(item => item.type === 'function_call_output')
}

function parseFunctionCallOutput(item: ReturnType<typeof functionCallOutputs>[number]) {
  if (typeof item.output !== 'string') {
    throw new TypeError('Expected Graph function_call_output to be a JSON string')
  }

  return JSON.parse(item.output) as unknown
}

describe('createReActGraph', () => {
  test('P0-1: 第一轮直接给出最终答案时不执行工具，且 goal 只进入 history 一次', async () => {
    const runId = 'react-graph-p0-1'
    const goal = '请直接回答这个问题'
    const { graph, model, provider } = createFixture([
      finalAnswer('这是直接答案'),
    ])

    const result = await invokeGraph(graph, { goal }, runId)

    expect(model.histories).toHaveLength(1)
    expect(provider.calls).toHaveLength(0)
    expect(result.status).toBe(ReActStatus.Completed)
    expect(result.answer).toBe('这是直接答案')
    expect(countUserGoal(modelHistory(model, 0), goal)).toBe(1)
  })

  test('P0-2: Weather Tool 成功后将原始调用和 JSON observation 续写给第二轮模型', async () => {
    const runId = 'react-graph-p0-2'
    const goal = '深圳现在天气怎么样？'
    const shenzhen = weather('深圳', 30, 'Sunny')
    const weatherCall: ModelFunctionCall = {
      callId: 'weather-shenzhen-1',
      name: 'get_weather',
      arguments: JSON.stringify({ city: ' 深圳 ' }),
    }
    const { graph, model, provider, executor } = createFixture([
      requestingTools([weatherCall]),
      finalAnswer('深圳当前晴天，30°C。'),
    ], {
      深圳: shenzhen,
    })

    const result = await invokeGraph(graph, { goal }, runId)

    expect(model.histories).toHaveLength(2)
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]?.city).toBe('深圳')
    expect(executor.calls).toHaveLength(1)
    expect(executor.calls[0]?.options.runId).toBe(runId)

    const secondHistory = modelHistory(model, 1)
    expect(secondHistory).toContainEqual(responseFunctionCall(weatherCall))
    const outputs = functionCallOutputs(secondHistory)
    expect(outputs).toHaveLength(1)
    const output = outputs[0]
    if (!output) {
      throw new Error('Expected one function_call_output')
    }
    expect(output.call_id).toBe(weatherCall.callId)
    expect(parseFunctionCallOutput(output)).toEqual({ ok: true, data: shenzhen })
    expect(result.status).toBe(ReActStatus.Completed)
    expect(result.answer).toBe('深圳当前晴天，30°C。')
  })

  test('一次 Tool 循环后第二轮 history 中 goal 只出现一次，且保持 user -> function_call -> function_call_output 顺序', async () => {
    const runId = 'react-graph-history-order'
    const goal = '请查询深圳天气后回答'
    const weatherCall: ModelFunctionCall = {
      callId: 'weather-history-order-1',
      name: 'get_weather',
      arguments: JSON.stringify({ city: '深圳' }),
    }
    const { graph, model } = createFixture([
      requestingTools([weatherCall]),
      finalAnswer('深圳晴天。'),
    ], {
      深圳: weather('深圳', 30, 'Sunny'),
    })

    const result = await invokeGraph(graph, { goal }, runId)
    const secondHistory = modelHistory(model, 1)
    const orderedItems = secondHistory.map((item) => {
      if ('role' in item && item.role === 'user' && 'content' in item && item.content === goal) {
        return 'user'
      }
      if (item.type === 'function_call' && item.call_id === weatherCall.callId) {
        return 'function_call'
      }
      if (item.type === 'function_call_output' && item.call_id === weatherCall.callId) {
        return 'function_call_output'
      }

      return 'other'
    })

    const userIndex = orderedItems.indexOf('user')
    const functionCallIndex = orderedItems.indexOf('function_call')
    const functionCallOutputIndex = orderedItems.indexOf('function_call_output')

    expect(countUserGoal(secondHistory, goal)).toBe(1)
    expect(userIndex).toBeGreaterThanOrEqual(0)
    expect(functionCallIndex).toBeGreaterThan(userIndex)
    expect(functionCallOutputIndex).toBeGreaterThan(functionCallIndex)
    expect(result.status).toBe(ReActStatus.Completed)
  })

  test('P0-3: 同轮两次 Weather Tool 调用按各自 callId 回填 observation，结果不串号', async () => {
    const runId = 'react-graph-p0-3'
    const shenzhen = weather('深圳', 30, 'Sunny')
    const beijing = weather('北京', 24, 'Cloudy')
    const shenzhenCall: ModelFunctionCall = {
      callId: 'weather-shenzhen-2',
      name: 'get_weather',
      arguments: JSON.stringify({ city: '深圳' }),
    }
    const beijingCall: ModelFunctionCall = {
      callId: 'weather-beijing-2',
      name: 'get_weather',
      arguments: JSON.stringify({ city: '北京' }),
    }
    const { graph, model, provider } = createFixture([
      requestingTools([shenzhenCall, beijingCall]),
      finalAnswer('深圳晴 30°C；北京多云 24°C。'),
    ], {
      深圳: shenzhen,
      北京: beijing,
    })

    const result = await invokeGraph(graph, {
      goal: '分别查询深圳和北京的天气',
    }, runId)

    expect(provider.calls).toHaveLength(2)
    expect(provider.calls.map(call => call.city)).toEqual(['深圳', '北京'])
    expect(model.histories).toHaveLength(2)

    const outputs = functionCallOutputs(modelHistory(model, 1))
    expect(outputs).toHaveLength(2)
    const outputsByCallId = new Map(
      outputs.map(output => [output.call_id, parseFunctionCallOutput(output)]),
    )
    expect(outputsByCallId.get(shenzhenCall.callId)).toEqual({
      ok: true,
      data: shenzhen,
    })
    expect(outputsByCallId.get(beijingCall.callId)).toEqual({
      ok: true,
      data: beijing,
    })
    expect(result.status).toBe(ReActStatus.Completed)
  })

  test('P0-4: 未注册 Tool 的 unknown_tool observation 会返回给模型而非让 Graph 崩溃', async () => {
    const runId = 'react-graph-p0-4'
    const missingCall: ModelFunctionCall = {
      callId: 'missing-tool-1',
      name: 'missing_tool',
      arguments: JSON.stringify({ value: 'ignored' }),
    }
    const { graph, model, provider, executor } = createFixture([
      requestingTools([missingCall]),
      finalAnswer('该工具不可用，我会改用其他方式回答。'),
    ])

    const result = await invokeGraph(graph, {
      goal: '调用一个不存在的工具',
    }, runId)

    expect(provider.calls).toHaveLength(0)
    expect(executor.calls).toHaveLength(1)
    expect(executor.calls[0]?.call.name).toBe('missing_tool')
    expect(model.histories).toHaveLength(2)

    const outputs = functionCallOutputs(modelHistory(model, 1))
    expect(outputs).toHaveLength(1)
    const output = outputs[0]
    if (!output) {
      throw new Error('Expected unknown_tool observation')
    }
    expect(output.call_id).toBe(missingCall.callId)
    expect(parseFunctionCallOutput(output)).toEqual({
      ok: false,
      error: {
        code: 'unknown_tool',
        message: 'Tool "missing_tool" is not registered',
        runId,
      },
    })
    expect(result.status).toBe(ReActStatus.Completed)
  })

  test('P0-5: 达到 maxToolRounds 后不执行第二轮 Tool，并以 max_tool_rounds 失败', async () => {
    const runId = 'react-graph-p0-5'
    const firstCall: ModelFunctionCall = {
      callId: 'weather-first-round',
      name: 'get_weather',
      arguments: JSON.stringify({ city: '深圳' }),
    }
    const secondCall: ModelFunctionCall = {
      callId: 'weather-second-round',
      name: 'get_weather',
      arguments: JSON.stringify({ city: '北京' }),
    }
    const { graph, model, provider, executor } = createFixture([
      requestingTools([firstCall]),
      requestingTools([secondCall]),
    ], {
      深圳: weather('深圳', 30, 'Sunny'),
      北京: weather('北京', 24, 'Cloudy'),
    })

    const result = await invokeGraph(graph, {
      goal: '先查深圳再查北京',
      maxToolRounds: 1,
    }, runId)

    expect(model.histories).toHaveLength(2)
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]?.city).toBe('深圳')
    expect(executor.calls).toHaveLength(1)
    expect(executor.calls[0]?.call.callId).toBe(firstCall.callId)
    expect(result.status).toBe(ReActStatus.Failed)
    expect(result.error?.code).toBe('max_tool_rounds')
  })

  test('P0-5A: 连续两个失败 observation 达到 maxFailures 后停止，不再调用模型或执行额外 Tool', async () => {
    const runId = 'react-graph-p0-5a'
    const firstFailedCall: ModelFunctionCall = {
      callId: 'missing-tool-first-failure',
      name: 'missing_tool',
      arguments: JSON.stringify({ value: 'first' }),
    }
    const secondFailedCall: ModelFunctionCall = {
      callId: 'missing-tool-second-failure',
      name: 'missing_tool',
      arguments: JSON.stringify({ value: 'second' }),
    }
    const { graph, model, provider, executor } = createFixture([
      requestingTools([firstFailedCall]),
      requestingTools([secondFailedCall]),
    ])

    const result = await invokeGraph(graph, {
      goal: '连续调用不存在的工具',
      maxFailures: 2,
    }, runId)

    // 第一条失败 observation 会给模型一次纠正机会；第二条达到预算后直接失败。
    expect(model.histories).toHaveLength(2)
    expect(executor.calls).toHaveLength(2)
    expect(executor.calls.map(call => call.call.callId)).toEqual([
      firstFailedCall.callId,
      secondFailedCall.callId,
    ])
    expect(provider.calls).toHaveLength(0)
    expect(result.failureCount).toBe(2)
    expect(result.status).toBe(ReActStatus.Failed)
    expect(result.error?.code).toBe('max_failures')

    const firstFailureOutputs = functionCallOutputs(modelHistory(model, 1))
    expect(firstFailureOutputs).toHaveLength(1)
    const firstFailure = firstFailureOutputs[0]
    if (!firstFailure) {
      throw new Error('Expected the first failed Tool observation')
    }
    expect(parseFunctionCallOutput(firstFailure)).toMatchObject({
      ok: false,
      error: { code: 'unknown_tool', runId },
    })
  })

  test('P0-6: 无 Tool Call 且 finalText 为空时以 no_candidate_answer 失败', async () => {
    const runId = 'react-graph-p0-6-empty'
    const { graph, model, provider } = createFixture([
      finalAnswer('   '),
    ])

    const result = await invokeGraph(graph, {
      goal: '模型未给候选答案',
    }, runId)

    expect(model.histories).toHaveLength(1)
    expect(provider.calls).toHaveLength(0)
    expect(result.status).toBe(ReActStatus.Failed)
    expect(result.error?.code).toBe('no_candidate_answer')
  })

  test('P0-6: 无 Tool Call 且 finalText 为 undefined 时以 no_candidate_answer 失败', async () => {
    const runId = 'react-graph-p0-6-undefined'
    const { graph, model, provider } = createFixture([
      finalAnswer(),
    ])

    const result = await invokeGraph(graph, {
      goal: '模型没有 finalText',
    }, runId)

    expect(model.histories).toHaveLength(1)
    expect(provider.calls).toHaveLength(0)
    expect(result.status).toBe(ReActStatus.Failed)
    expect(result.error?.code).toBe('no_candidate_answer')
  })

  test('P0-7: Model 异常会被 Graph 归一化，调用方拿不到敏感原始异常', async () => {
    const runId = 'react-graph-p0-7'
    const sensitiveError = new Error('sensitive model credential: do-not-leak')
    const { graph, model, provider } = createFixture([sensitiveError])

    const result = await invokeGraph(graph, {
      goal: '模型调用会异常',
    }, runId)

    expect(model.histories).toHaveLength(1)
    expect(provider.calls).toHaveLength(0)
    expect(result.status).toBe(ReActStatus.Failed)
    expect(result.error?.code).toBe('call_model_node_error')
    expect(result.error?.message).not.toContain('sensitive model credential')
  })
})

import type { WeatherProvider } from '@/tools/weather/provider'
import process from 'node:process'
import { expect, test } from 'bun:test'
import { OpenAIResponsesModel } from '@/agent/react/model-adapter'
import { createReActGraph } from '@/agent/react/react-graph'
import { ReActStatus } from '@/agent/react/state'
import { createOpenAIModelClient } from '@/clients/openai'
import { ToolExecutor, ToolRegistry } from '@/tools/_core'
import { toResponseTool } from '@/tools/_core/adapters/openai-response'
import { createWeatherTool, getCurrentWeather } from '@/tools/weather'

const requiredModelEnvironment = [
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_DEFAULT_MODAL',
] as const

function assertSmokeEnvironment(): void {
  const missing = requiredModelEnvironment.filter(name => !process.env[name]?.trim())
  if (missing.length > 0) {
    throw new Error(`React graph smoke test requires configured environment variables: ${missing.join(', ')}`)
  }
}

test('真实 Responses API、LangGraph 和 WeatherTool 完成一次 ReAct 天气查询', async () => {
  assertSmokeEnvironment()

  let weatherProviderCalls = 0
  let weatherProviderSuccesses = 0
  const weatherProvider: WeatherProvider = {
    async getCurrentWeather(input, options) {
      weatherProviderCalls += 1
      const weather = await getCurrentWeather(input, options)
      weatherProviderSuccesses += 1

      return weather
    },
  }
  const weatherTool = createWeatherTool(weatherProvider)
  const registry = new ToolRegistry()
  registry.register(weatherTool)
  const executor = new ToolExecutor(registry)
  const { client, model: modelName } = createOpenAIModelClient(process.env)
  const graph = createReActGraph({
    model: new OpenAIResponsesModel(client, modelName),
    executor,
    tools: [toResponseTool(weatherTool)],
    initialToolChoice: 'required',
    instructions: [
      '你是一个仅基于工具结果回答的 ReAct 助手。',
      '遇到天气问题时，必须先调用 get_weather，并基于 function_call_output 回答。',
      '不得在调用工具前凭已有知识直接编造天气信息。',
    ].join(''),
  })
  const runId = `react-graph-smoke-${crypto.randomUUID()}`

  const result = await graph.invoke({
    goal: '请先调用 get_weather 查询深圳的当前天气，再仅依据工具结果用中文回答。',
  }, {
    runId,
    context: { runId },
  })

  expect(weatherProviderCalls).toBeGreaterThan(0)
  expect(weatherProviderSuccesses).toBeGreaterThan(0)
  expect(result.status).toBe(ReActStatus.Completed)
  expect(result.answer?.trim()).toBeTruthy()
})

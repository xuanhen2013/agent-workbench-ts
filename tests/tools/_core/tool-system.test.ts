import type { WeatherData, WeatherProvider } from '@/tools/weather/provider'
import { describe, expect, test } from 'bun:test'
import {
  ToolExecutionErrorType,
  ToolExecutor,
  ToolRegistry,
} from '@/tools/_core'
import { toResponseTool } from '@/tools/_core/adapters/openai-response'
import { createWeatherTool } from '@/tools/weather'

const weather: WeatherData = {
  city: 'Shenzhen',
  temperatureC: 26,
  condition: 'Sunny',
  observedAt: '10:00 AM',
}

function createExecutor(provider: WeatherProvider) {
  const registry = new ToolRegistry()
  const weatherTool = createWeatherTool(provider)
  registry.register(weatherTool)

  return {
    executor: new ToolExecutor(registry),
    weatherTool,
  }
}

function weatherCall(overrides: Partial<{
  callId: string
  name: string
  arguments: string
}> = {}) {
  return {
    callId: 'call_weather_1',
    name: 'get_weather',
    arguments: JSON.stringify({ city: ' Shenzhen ' }),
    ...overrides,
  }
}

function executeOptions(signal = new AbortController().signal) {
  return {
    runId: 'run_weather_1',
    signal,
  }
}

describe('Tool system', () => {
  test('同一个 WeatherTool 能暴露给 Responses，也能由 Executor 执行', async () => {
    const controller = new AbortController()
    let receivedCity: string | undefined
    let receivedSignal: AbortSignal | undefined

    const provider: WeatherProvider = {
      async getCurrentWeather(input, options) {
        receivedCity = input.city
        receivedSignal = options.signal
        return weather
      },
    }

    const weatherTool = createWeatherTool(provider)
    const registry = new ToolRegistry()
    registry.register(weatherTool)
    const executor = new ToolExecutor(registry)

    // 先证明 Registry 保存的就是随后暴露和执行的那一个实例。
    expect(registry.list()).toEqual([weatherTool])

    const modelTool = toResponseTool(weatherTool)

    expect(modelTool).toMatchObject({
      type: 'function',
      name: 'get_weather',
      strict: true,
      description: expect.any(String),
      parameters: {
        type: 'object',
        properties: {
          city: expect.any(Object),
        },
      },
    })

    const result = await executor.execute(
      weatherCall(),
      executeOptions(controller.signal),
    )

    expect(receivedCity).toBe('Shenzhen')
    expect(receivedSignal).toBe(controller.signal)
    expect(result).toEqual({
      ok: true,
      callId: 'call_weather_1',
      name: 'get_weather',
      output: weather,
    })
  })

  test('Registry 拒绝重名注册，且 list 返回的数组不能改写内部状态', () => {
    const registry = new ToolRegistry()
    const weatherTool = createWeatherTool({
      async getCurrentWeather() {
        return weather
      },
    })

    registry.register(weatherTool)

    expect(() => registry.register(weatherTool)).toThrow(
      `Tool "${weatherTool.name}" is already registered`,
    )

    const listedTools = registry.list()
    listedTools.pop()

    expect(registry.get(weatherTool.name)).toBe(weatherTool)
    expect(registry.list()).toEqual([weatherTool])
  })

  test('未知 Tool 不执行 Provider，并保留原始调用标识', async () => {
    let providerCalls = 0
    const { executor } = createExecutor({
      async getCurrentWeather() {
        providerCalls += 1
        return weather
      },
    })

    const result = await executor.execute(
      weatherCall({ callId: 'call_unknown_1', name: 'missing_tool' }),
      executeOptions(),
    )

    expect(providerCalls).toBe(0)
    expect(result).toEqual({
      ok: false,
      callId: 'call_unknown_1',
      name: 'missing_tool',
      error: {
        code: ToolExecutionErrorType.UNKNOWN_TOOL,
        message: expect.any(String),
        runId: 'run_weather_1',
      },
    })
  })

  test('非法 JSON 在执行 Provider 前被归一化为 invalid_json', async () => {
    let providerCalls = 0
    const { executor, weatherTool } = createExecutor({
      async getCurrentWeather() {
        providerCalls += 1
        return weather
      },
    })

    const result = await executor.execute(
      weatherCall({
        callId: 'call_invalid_json_1',
        name: weatherTool.name,
        arguments: '{not json',
      }),
      executeOptions(),
    )

    expect(providerCalls).toBe(0)
    expect(result).toEqual({
      ok: false,
      callId: 'call_invalid_json_1',
      name: weatherTool.name,
      error: {
        code: ToolExecutionErrorType.INVALID_JSON,
        message: expect.any(String),
        runId: 'run_weather_1',
      },
    })
  })

  test('Schema 拒绝参数时不执行 Provider，并返回 invalid_arguments', async () => {
    let providerCalls = 0
    const { executor, weatherTool } = createExecutor({
      async getCurrentWeather() {
        providerCalls += 1
        return weather
      },
    })

    const result = await executor.execute(
      weatherCall({
        callId: 'call_invalid_arguments_1',
        name: weatherTool.name,
        arguments: JSON.stringify({ city: '   ' }),
      }),
      executeOptions(),
    )

    expect(providerCalls).toBe(0)
    expect(result).toEqual({
      ok: false,
      callId: 'call_invalid_arguments_1',
      name: weatherTool.name,
      error: {
        code: ToolExecutionErrorType.INVALID_ARGUMENTS,
        message: expect.any(String),
        runId: 'run_weather_1',
      },
    })
  })

  test('Provider 异常被归一化为 execution_failed', async () => {
    let providerCalls = 0
    const providerError = new Error('weather provider unavailable')
    const { executor, weatherTool } = createExecutor({
      async getCurrentWeather() {
        providerCalls += 1
        throw providerError
      },
    })

    const result = await executor.execute(
      weatherCall({ callId: 'call_provider_error_1', name: weatherTool.name }),
      executeOptions(),
    )

    expect(providerCalls).toBe(1)
    expect(result).toEqual({
      ok: false,
      callId: 'call_provider_error_1',
      name: weatherTool.name,
      error: {
        code: ToolExecutionErrorType.EXECUTION_FAILED,
        message: expect.any(String),
        runId: 'run_weather_1',
      },
    })
  })

  test('调用前 signal 已取消时不执行 Provider，并返回 aborted', async () => {
    let providerCalls = 0
    const controller = new AbortController()
    controller.abort()
    const { executor, weatherTool } = createExecutor({
      async getCurrentWeather() {
        providerCalls += 1
        return weather
      },
    })

    const result = await executor.execute(
      weatherCall({ callId: 'call_aborted_1', name: weatherTool.name }),
      executeOptions(controller.signal),
    )

    expect(providerCalls).toBe(0)
    expect(result).toEqual({
      ok: false,
      callId: 'call_aborted_1',
      name: weatherTool.name,
      error: {
        code: ToolExecutionErrorType.ABORTED,
        message: 'Execution aborted',
        runId: 'run_weather_1',
      },
    })
  })

  test('执行中 abort 会立即结束等待，并把同一个 signal 传到 Provider', async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | undefined
    let markProviderStarted!: () => void
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve
    })

    const { executor, weatherTool } = createExecutor({
      async getCurrentWeather(_input, options) {
        receivedSignal = options.signal
        markProviderStarted()

        return new Promise<WeatherData>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            reject(options.signal.reason)
          }, { once: true })
        })
      },
    })

    const resultPromise = executor.execute(
      weatherCall({
        callId: 'call_abort_during_execution_1',
        name: weatherTool.name,
      }),
      executeOptions(controller.signal),
    )

    await providerStarted
    controller.abort()

    const result = await resultPromise

    expect(receivedSignal).toBe(controller.signal)
    expect(result).toEqual({
      ok: false,
      callId: 'call_abort_during_execution_1',
      name: weatherTool.name,
      error: {
        code: ToolExecutionErrorType.ABORTED,
        message: 'Execution aborted',
        runId: 'run_weather_1',
      },
    })
  })
})

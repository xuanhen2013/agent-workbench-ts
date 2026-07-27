import { describe, expect, test, vi } from 'bun:test'
import { AgentCallError, FailureCode, FailureKind } from '@/runtime'
import { createWttrWeatherProvider } from '@/tools/weather'

interface FakeFetchResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

function response(status: number, body: unknown): FakeFetchResponse {
  return {
    ok: status >= 200 && status <= 299,
    status,
    async json() {
      return body
    },
  }
}

function currentWeather() {
  return {
    current_condition: [{
      temp_C: '30',
      observation_time: '2026-07-28T10:00:00Z',
      weatherDesc: [{ value: 'Sunny' }],
    }],
  }
}

function expectFailure(
  error: unknown,
  kind: FailureKind,
  code: FailureCode,
): asserts error is AgentCallError {
  expect(error).toBeInstanceOf(AgentCallError)
  expect((error as AgentCallError).failure).toMatchObject({ kind, code })
}

async function advanceRetryDelay(ms: number) {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
  }

  vi.advanceTimersByTime(ms)
}

describe('createWttrWeatherProvider reliability', () => {
  test('503 第一次失败、第二次成功时重试并返回 WeatherData', async () => {
    vi.useFakeTimers()
    let fetchCalls = 0
    const provider = createWttrWeatherProvider({
      async fetch() {
        fetchCalls += 1
        return fetchCalls === 1
          ? response(503, { error: 'sensitive upstream body' })
          : response(200, currentWeather())
      },
    })

    try {
      const operation = provider.getCurrentWeather(
        { city: 'Shenzhen' },
        { signal: new AbortController().signal },
      )

      await advanceRetryDelay(100)

      await expect(operation).resolves.toEqual({
        city: 'Shenzhen',
        temperatureC: 30,
        condition: 'Sunny',
        observedAt: '2026-07-28T10:00:00Z',
      })
      expect(fetchCalls).toBe(2)
    }
    finally {
      vi.useRealTimers()
    }
  })

  test('429 可重试，并在后续成功时返回结果', async () => {
    vi.useFakeTimers()
    let fetchCalls = 0
    const provider = createWttrWeatherProvider({
      async fetch() {
        fetchCalls += 1
        return fetchCalls === 1
          ? response(429, { error: 'rate limited' })
          : response(200, currentWeather())
      },
    })

    try {
      const operation = provider.getCurrentWeather(
        { city: 'Shenzhen' },
        { signal: new AbortController().signal },
      )

      await advanceRetryDelay(100)

      await expect(operation).resolves.toMatchObject({ city: 'Shenzhen' })
      expect(fetchCalls).toBe(2)
    }
    finally {
      vi.useRealTimers()
    }
  })

  test('404 归类为 InvalidInput，且不重试', async () => {
    let fetchCalls = 0
    const provider = createWttrWeatherProvider({
      async fetch() {
        fetchCalls += 1
        return response(404, { error: 'city does not exist' })
      },
    })

    try {
      await provider.getCurrentWeather(
        { city: 'Not-A-City' },
        { signal: new AbortController().signal },
      )
      throw new Error('Expected the provider to reject')
    }
    catch (error) {
      expectFailure(error, FailureKind.InvalidInput, FailureCode.InvalidInput)
    }

    expect(fetchCalls).toBe(1)
  })

  test('无法识别的响应结构归类为 Internal，且不重试', async () => {
    let fetchCalls = 0
    const provider = createWttrWeatherProvider({
      async fetch() {
        fetchCalls += 1
        return response(200, { current_condition: [{}] })
      },
    })

    try {
      await provider.getCurrentWeather(
        { city: 'Shenzhen' },
        { signal: new AbortController().signal },
      )
      throw new Error('Expected the provider to reject')
    }
    catch (error) {
      expectFailure(error, FailureKind.Internal, FailureCode.InternalError)
    }

    expect(fetchCalls).toBe(1)
  })

  test('将 attempt signal 而非 parent signal 传给 fetch', async () => {
    const parentController = new AbortController()
    let receivedSignal: AbortSignal | undefined
    const provider = createWttrWeatherProvider({
      async fetch(_url, options) {
        receivedSignal = options.signal
        return response(200, currentWeather())
      },
    })

    await provider.getCurrentWeather(
      { city: 'Shenzhen' },
      { signal: parentController.signal },
    )

    expect(receivedSignal).toBeDefined()
    expect(receivedSignal).not.toBe(parentController.signal)
    expect(receivedSignal?.aborted).toBe(false)
  })
})

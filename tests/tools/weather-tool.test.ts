import { expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { createWeatherTool, getCurrentWeather } from '@/tools/weather'

test('合法 city 返回领域结果，trim 后的 city 和原始 signal 会传给真实 Provider', async () => {
  const controller = new AbortController()
  let receivedCity: string | undefined
  let receivedSignal: AbortSignal | undefined

  const weatherTool = createWeatherTool({
    async getCurrentWeather(input, options) {
      receivedCity = input.city
      receivedSignal = options.signal
      return getCurrentWeather(input, options)
    },
  })

  const result = await weatherTool.invoke(
    { city: ' Shenzhen ' },
    {
      runId: 'weather-run-1',
      toolCallId: 'weather-call-1',
      signal: controller.signal,
    },
  )

  expect(receivedCity).toBe('Shenzhen')
  expect(receivedSignal).toBe(controller.signal)
  expect(result).toEqual({
    city: 'Shenzhen',
    temperatureC: expect.any(Number),
    condition: expect.any(String),
    observedAt: expect.any(String),
  })
}, 20_000)

test('空 city 在到达 Provider 前被 Schema 拒绝', async () => {
  let providerCalls = 0

  const weatherTool = createWeatherTool({
    async getCurrentWeather(input, options) {
      providerCalls += 1
      return getCurrentWeather(input, options)
    },
  })

  await expect(
    weatherTool.invoke(
      { city: '   ' },
      {
        runId: 'weather-run-2',
        toolCallId: 'weather-call-2',
        signal: new AbortController().signal,
      },
    ),
  ).rejects.toBeInstanceOf(z.ZodError)

  expect(providerCalls).toBe(0)
})

test('Provider 异常继续向外抛出', async () => {
  const providerError = new Error('weather provider unavailable')

  const weatherTool = createWeatherTool({
    async getCurrentWeather() {
      throw providerError
    },
  })

  await expect(
    weatherTool.invoke(
      { city: 'Shenzhen' },
      {
        runId: 'weather-run-3',
        toolCallId: 'weather-call-3',
        signal: new AbortController().signal,
      },
    ),
  ).rejects.toBe(providerError)
})

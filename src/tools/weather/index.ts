import type { WeatherData, WeatherProvider } from './provider'
import { z } from 'zod/v4'
import { createAbortedError, executeWithPolicy, FailureCode, FailureKind } from '@/runtime'
import { defineTool } from '../_core'

class WeatherHttpError extends Error {
  constructor(readonly status: number) {
    super('Weather request failed.')
    this.name = 'WeatherHttpError'
  }
}

interface WttrFetchResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

type WttrFetch = (
  url: URL,
  options: { signal: AbortSignal },
) => Promise<WttrFetchResponse>

export interface WttrWeatherProviderDependencies {
  fetch?: WttrFetch
}

interface WttrResponse {
  current_condition?: Array<{
    temp_C?: string
    observation_time: string
    weatherDesc?: Array<{ value?: string }>
  }>
}

function isWttrResponse(data: unknown): data is WttrResponse {
  if (typeof data !== 'object' || data === null) {
    return false
  }

  return Array.isArray((data as { current_condition?: unknown }).current_condition)
}

const networkErrorCodes = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
])

function hasNetworkErrorCode(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false
  }

  return typeof error.code === 'string' && networkErrorCodes.has(error.code)
}

function isExplicitNetworkError(error: unknown): boolean {
  if (hasNetworkErrorCode(error)) {
    return true
  }

  return typeof error === 'object'
    && error !== null
    && 'cause' in error
    && hasNetworkErrorCode(error.cause)
}

function classifyWeatherError(error: unknown) {
  if (error instanceof WeatherHttpError) {
    if (error.status === 429) {
      return {
        kind: FailureKind.Transient,
        code: FailureCode.RateLimited,
        message: 'Weather service rate limit reached.',
      }
    }

    if (error.status >= 500 && error.status <= 599) {
      return {
        kind: FailureKind.Transient,
        code: FailureCode.ServiceUnavailable,
        message: 'Weather service is temporarily unavailable.',
      }
    }

    if (error.status >= 400 && error.status <= 499) {
      return {
        kind: FailureKind.InvalidInput,
        code: FailureCode.InvalidInput,
        message: 'Weather request is invalid.',
      }
    }
  }

  if (isExplicitNetworkError(error)) {
    return {
      kind: FailureKind.Transient,
      code: FailureCode.NetworkError,
      message: 'Weather service connection failed.',
    }
  }

  return {
    kind: FailureKind.Internal,
    code: FailureCode.InternalError,
    message: 'Weather service returned an invalid response.',
  }
}

function toWeatherData(data: unknown, city: string): WeatherData {
  if (!isWttrResponse(data)) {
    throw new TypeError('Weather response was not recognized.')
  }

  const currentCondition = data.current_condition?.[0]
  const weatherDescription = currentCondition?.weatherDesc?.[0]?.value
  const temperature = currentCondition?.temp_C
  const observedAt = currentCondition?.observation_time
  const temperatureC = Number(temperature)

  if (!weatherDescription
    || !observedAt
    || temperature === undefined
    || !Number.isFinite(temperatureC)) {
    throw new TypeError('Weather response did not contain a current condition.')
  }

  return {
    city,
    observedAt,
    condition: weatherDescription,
    temperatureC,
  }
}

export function createWttrWeatherProvider(
  deps: WttrWeatherProviderDependencies = {},
): WeatherProvider {
  const weatherFetch: WttrFetch = deps.fetch ?? ((url, options) => fetch(url, options))

  return {
    async getCurrentWeather(input, options) {
      const { city } = input

      return await executeWithPolicy({
        policy: {
          timeoutMs: 5_000,
          maxAttempts: 3,
          initialDelayMs: 100,
          maxDelayMs: 500,
          shouldRetry: failure => failure.kind === FailureKind.Transient,
        },
        parentSignal: options.signal,
        execute: async (signal: AbortSignal) => {
          const url = new URL(`https://wttr.in/${encodeURIComponent(city)}`)
          url.searchParams.set('format', 'j1')

          const result = await weatherFetch(url, { signal })

          if (!result.ok) {
            throw new WeatherHttpError(result.status)
          }

          return toWeatherData(await result.json(), city)
        },
        classify: classifyWeatherError,
        sleep(ms: number, signal: AbortSignal) {
          return new Promise((resolve, reject) => {
            let timer: NodeJS.Timeout
            function signalFn() {
              timer && clearTimeout(timer)
              reject(createAbortedError())
            }
            timer = setTimeout(() => {
              signal.removeEventListener('abort', signalFn)
              resolve()
            }, ms)
            signal.addEventListener('abort', signalFn)
          })
        },
      })
    },
  }
}

const wttrWeatherProvider = createWttrWeatherProvider()

export function getCurrentWeather(
  input: { city: string },
  options: { signal: AbortSignal },
) {
  return wttrWeatherProvider.getCurrentWeather(input, options)
}

export function createWeatherTool(provider: WeatherProvider) {
  return defineTool({
    name: 'get_weather',
    description: `
    查询一个指定城市的当前天气；
    只返回摄氏温度、天气状况和观测时间；
    不提供天气预报、历史天气或旅游推荐。`,
    schema: z.object({
      city: z.string().trim().min(1).max(80),
    }),
    handler: async (input, options) => {
      return provider.getCurrentWeather(input, options)
    },
  })
}

import type { WeatherProvider } from './provider'
import { z } from 'zod/v4'
import { defineTool } from '../_core'

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

export async function getCurrentWeather(input: { city: string }, options: { signal: AbortSignal }) {
  const { city } = input
  const { signal } = options

  const url = new URL(`https://wttr.in/${encodeURIComponent(city)}`)
  url.searchParams.set('format', 'j1')

  try {
    const result = await fetch(url, { signal })

    if (!result.ok) {
      throw new Error(`查询天气时遇到网络问题 - ${result.status}`)
    }

    const data: unknown = await result.json()
    if (!isWttrResponse(data)) {
      throw new Error('天气服务返回了无法识别的数据')
    }

    const currentCondition = data.current_condition?.[0]
    const weatherDescription = currentCondition?.weatherDesc?.[0]?.value
    const temperature = currentCondition?.temp_C
    if (!weatherDescription || temperature === undefined) {
      throw new Error('天气服务没有返回当前天气')
    }

    return {
      city,
      observedAt: currentCondition?.observation_time,
      condition: weatherDescription,
      temperatureC: Number(temperature),
    }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    throw new Error(`查询天气失败 - ${message}`)
  }
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

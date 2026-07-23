import { tool } from '@langchain/core/tools'
import z from 'zod'

export const wttrGetWeather = tool(async ({ city }) => {
  const url = new URL(`https://wttr.in/${encodeURIComponent(city)}`)
  url.searchParams.set('format', 'j1')

  try {
    const result = await fetch(url)

    if (!result.ok) {
      return `错误:查询天气时遇到网络问题 - ${result.status}`
    }

    const data: unknown = await result.json()
    if (!isWttrResponse(data)) {
      return '错误:天气服务返回了无法识别的数据'
    }

    const currentCondition = data.current_condition?.[0]
    const weatherDescription = currentCondition?.weatherDesc?.[0]?.value
    const temperature = currentCondition?.temp_C
    if (!weatherDescription || temperature === undefined) {
      return '错误:天气服务没有返回当前天气'
    }

    return `${city}当前天气:${weatherDescription}，气温${temperature}摄氏度`
  }
  catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    return `错误:查询天气失败 - ${message}`
  }
}, {
  name: 'wttrGetWeather',
  description: '获取指定城市的天气信息',
  schema: z.object({
    city: z.string().min(1),
  }).strict(),
})

interface WttrResponse {
  current_condition?: Array<{
    temp_C?: string
    weatherDesc?: Array<{ value?: string }>
  }>
}

function isWttrResponse(data: unknown): data is WttrResponse {
  if (typeof data !== 'object' || data === null) {
    return false
  }

  return Array.isArray((data as { current_condition?: unknown }).current_condition)
}

export class WttrTool {
  type = 'function' as const
  name: string = 'wttrGetWeather'
  description: string = '获取指定城市的天气信息'
  strict: boolean = true
  parameters = {
    type: 'object',
    properties: {
      city: {
        type: 'string',
        description: '城市',
      },
    },
    required: ['city'],
    additionalProperties: false,
  }

  schema: z.ZodType = z.object({
    city: z.string().min(1),
  }).strict()

  async fn({ city }: { city: string }): Promise<string> {
    const url = new URL(`https://wttr.in/${encodeURIComponent(city)}`)
    url.searchParams.set('format', 'j1')

    try {
      const result = await fetch(url)

      if (!result.ok) {
        return `错误:查询天气时遇到网络问题 - ${result.status}`
      }

      const data: unknown = await result.json()
      if (!isWttrResponse(data)) {
        return '错误:天气服务返回了无法识别的数据'
      }

      const currentCondition = data.current_condition?.[0]
      const weatherDescription = currentCondition?.weatherDesc?.[0]?.value
      const temperature = currentCondition?.temp_C
      if (!weatherDescription || temperature === undefined) {
        return '错误:天气服务没有返回当前天气'
      }

      return `${city}当前天气:${weatherDescription}，气温${temperature}摄氏度`
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      return `错误:查询天气失败 - ${message}`
    }
  }
}

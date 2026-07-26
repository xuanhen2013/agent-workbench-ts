import process from 'node:process'
import { tool } from '@langchain/core/tools'
import { tavily } from '@tavily/core'
import z from 'zod'

const tvly = tavily({ apiKey: process.env.TAVILY_KEY })

export const tavilySearch = tool(async ({ city, weather }) => {
  const query = `'${city}' 在'${weather}'天气下最值得去的旅游景点推荐及理由`

  const result = await tvly.search(query, {
    searchDepth: 'basic',
    includeAnswer: true,
  })

  if (result?.answer) {
    return result.answer
  }

  if (Array.isArray(result?.results)) {
    const attractions = result.results
      .map(item => `- ${String(item.title)}: ${String(item.content)}`)
      .join('\n')

    return `根据搜索，为您找到以下信息:\n${attractions}`
  }

  return '抱歉，没有找到相关的旅游景点推荐。'
}, {
  name: 'getAttraction',
  description: '查询城市的推荐美景',
  schema: z.object({
    city: z.string().min(1),
    weather: z.string().min(1),
  }).strict(),
})

export class TavilyTool {
  name: string = 'getAttraction'
  description: string = '查询城市的推荐美景'
  strict: boolean = true
  type = 'function' as const
  parameters = {
    type: 'object',
    properties: {
      city: {
        type: 'string',
        description: '城市',
      },
      weather: {
        type: 'string',
        description: '天气',
      },
    },
    required: ['city', 'weather'],
    additionalProperties: false,
  }

  schema: z.ZodType = z.object({
    city: z.string().min(1),
    weather: z.string().min(1),
  }).strict()

  async fn({ city, weather }: { city: string, weather: string }): Promise<string> {
    const query = `'${city}' 在'${weather}'天气下最值得去的旅游景点推荐及理由`

    const result = await tvly.search(query, {
      searchDepth: 'basic',
      includeAnswer: true,
    })

    if (result?.answer) {
      return result.answer
    }

    if (Array.isArray(result?.results)) {
      const attractions = result.results
        .map(item => `- ${String(item.title)}: ${String(item.content)}`)
        .join('\n')

      return `根据搜索，为您找到以下信息:\n${attractions}`
    }

    return '抱歉，没有找到相关的旅游景点推荐。'
  }
}

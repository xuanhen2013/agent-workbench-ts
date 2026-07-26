// https://serpapi.com/search-api
import process from 'node:process'
import { tool } from '@langchain/core/tools'
import { getJson } from 'serpapi'
import z from 'zod'

const searpapiKey = process.env.SERPAPI_API_KEY

export const serpapiSearch = tool(async ({ query }) => {
  try {
    const result = await getJson({
      engine: 'google',
      q: query,
      api_key: searpapiKey,
      gl: 'cn',
      hl: 'zh-cn',
    })

    if ('answer_box_list' in result) {
      return `\n${result.answer_box_list}`
    }

    if (result?.answer_box?.answer) {
      return `\n${result.answer_box.answer}`
    }

    if (result?.knowledge_graph?.description) {
      return `\n${result.knowledge_graph.description}`
    }

    if (Array.isArray(result?.organic_results)) {
      return `\n\n${result.organic_results.slice(0, 3).map((r, i) => `[${i + 1}] ${r.title}\n ${r.snippet}`).join('\n')}`
    }

    return `对不起，没有找到关于 '${query}' 的信息。`
  }
  catch (e) {
    return `搜索时发生错误: ${e}`
  }
}, {
  name: 'serpapiSearch',
  description: '一个网页搜索引擎。当你需要回答关于时事、事实以及在你的知识库中找不到的信息时，应使用此工具。',
  schema: z.object({
    query: z.string().min(1),
  }).strict(),
})

export class SerpApiTool {
  name: string = 'serpapiSearch'
  description: string = '一个网页搜索引擎。当你需要回答关于时事、事实以及在你的知识库中找不到的信息时，应使用此工具。'
  strict: boolean = true
  type = 'function' as const
  parameters = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索词',
      },
    },
    required: ['query'],
    additionalProperties: false,
  }

  schema: z.ZodType = z.object({
    query: z.string().min(1),
  }).strict()

  async fn({ query }: any) {
    console.log('[serpapi]', query)
    try {
      const result = await getJson({
        engine: 'google',
        q: query,
        api_key: searpapiKey,
        gl: 'cn',
        hl: 'zh-cn',
      })

      if ('answer_box_list' in result) {
        return `\n${result.answer_box_list}`
      }

      if (result?.answer_box?.answer) {
        return `\n${result.answer_box.answer}`
      }

      if (result?.knowledge_graph?.description) {
        return `\n${result.knowledge_graph.description}`
      }

      if (Array.isArray(result?.organic_results)) {
        return `\n\n${result.organic_results.slice(0, 3).map((r, i) => `[${i + 1}] ${r.title}\n ${r.snippet}`).join('\n')}`
      }

      return `对不起，没有找到关于 '${query}' 的信息。`
    }
    catch (e) {
      return `搜索时发生错误: ${e}`
    }
  }
}

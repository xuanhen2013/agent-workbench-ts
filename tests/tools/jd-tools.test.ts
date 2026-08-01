import type { MarketJdSearchResult } from '@/jd/contracts'
import { describe, expect, test } from 'bun:test'
import {
  createSearchSimilarJdsTool,
  SIMILAR_JD_LIMIT_PER_SEARCH,
} from '@/tools/jd'

const selectedItemKey
  = 'question-signal/jd-market/jd-market-aaaaaaaaaaaaaaaaaaaa.md'
const similarItemKey
  = 'question-signal/jd-market/jd-market-bbbbbbbbbbbbbbbbbbbb.md'

function runtime() {
  return {
    runId: 'test-run',
    toolCallId: 'test-call',
    signal: new AbortController().signal,
  }
}

describe('search_similar_jds Tool', () => {
  test('模型只提交 query，服务端固定 limit 和当前 JD 排除项', async () => {
    const calls: unknown[] = []
    const result: MarketJdSearchResult = {
      itemKey: similarItemKey,
      title: 'AI Agent 前端工程师',
      company: '示例公司',
      location: '广州',
      salary: '20-35K',
      highlights: ['React', 'LangGraph'],
      focusKnowledgePoints: ['LangGraph', 'Tool Calling'],
      summary: '负责 Agent 产品前端和 Tool Calling 交互。',
    }
    const tool = createSearchSimilarJdsTool({
      async search(input) {
        calls.push(input)
        return [result]
      },
    }, selectedItemKey)

    const output = await tool.invoke(
      { query: 'Agent 前端共同要求' },
      runtime(),
    )

    expect(calls[0]).toMatchObject({
      query: 'Agent 前端共同要求',
      limit: SIMILAR_JD_LIMIT_PER_SEARCH,
      excludeItemKey: selectedItemKey,
    })
    expect(output).toEqual({
      jobs: [{
        itemKey: similarItemKey,
        title: 'AI Agent 前端工程师',
        company: '示例公司',
        focusKnowledgePoints: ['LangGraph', 'Tool Calling'],
        summary: '负责 Agent 产品前端和 Tool Calling 交互。',
      }],
    })
    expect(output.jobs[0]).not.toHaveProperty('salary')
  })

  test('拒绝模型自行提交 limit 或来源过滤条件', async () => {
    const tool = createSearchSimilarJdsTool({
      async search() {
        return []
      },
    }, selectedItemKey)

    await expect(tool.invoke({
      query: 'Agent 前端',
      limit: 99,
    }, runtime())).rejects.toThrow()
  })
})

import type { MarketJdCatalog, MarketJdSearchResult } from '@/agent/interview-quiz/jd/contracts'
import { describe, expect, test } from 'bun:test'
import { createApp } from '@/app'
import { createJokeGraphFixture } from '../helpers/joke'
import {
  createQuizGraphFixture,
  fakeImportJdDocument,
  TEST_LEARNER_ID,
} from '../helpers/quiz'

function marketResult(index: number): MarketJdSearchResult {
  return {
    itemKey: `question-signal/jd-market/jd-market-${String(index).padStart(20, 'a')}.md`,
    title: `Agent 前端工程师 ${index}`,
    company: `示例公司 ${index}`,
    location: '广州',
    salary: '20-35K',
    highlights: ['React', 'LangGraph'],
    focusKnowledgePoints: ['LangGraph'],
    summary: '不应出现在 Web 岗位卡片中的内部有界摘要。',
  }
}

function createFixture(catalog?: MarketJdCatalog) {
  return createApp({
    interviewQuiz: {
      graph: createQuizGraphFixture().graph,
      importJdDocument: fakeImportJdDocument,
      marketJdCatalog: catalog,
    },
    jokeGraph: createJokeGraphFixture().graph,
  })
}

describe('Interview Quiz market JD API', () => {
  test('固定请求 5 份并只返回 Web 岗位卡片字段', async () => {
    const calls: Array<{ query: string, limit: number }> = []
    const catalog: MarketJdCatalog = {
      async search(input) {
        calls.push({ query: input.query, limit: input.limit })
        return Array.from({ length: 6 }, (_, index) => marketResult(index + 1))
          .slice(0, input.limit)
      },
      async load() {
        return null
      },
    }
    const response = await createFixture(catalog).request(
      '/api/interview-quiz/market-jds?query=Agent%20%E5%89%8D%E7%AB%AF',
    )
    const body = await response.json() as { items: unknown[] }

    expect(response.status).toBe(200)
    expect(calls).toEqual([{ query: 'Agent 前端', limit: 5 }])
    expect(body.items).toHaveLength(5)
    expect(body.items[0]).toEqual({
      itemKey: expect.stringContaining('question-signal/jd-market/'),
      title: 'Agent 前端工程师 1',
      company: '示例公司 1',
      location: '广州',
      salary: '20-35K',
      highlights: ['React', 'LangGraph'],
    })
    expect(JSON.stringify(body)).not.toContain('focusKnowledgePoints')
    expect(JSON.stringify(body)).not.toContain('内部有界摘要')
  })

  test('非法查询和未配置市场目录返回稳定错误', async () => {
    const app = createFixture()
    const invalid = await app.request(
      '/api/interview-quiz/market-jds?query=A',
    )
    const unavailable = await app.request(
      '/api/interview-quiz/market-jds?query=Agent',
    )

    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({
      error: { code: 'market_jd_query_invalid' },
    })
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toMatchObject({
      error: { code: 'market_jd_search_unavailable' },
    })
  })

  test('创建 Quiz 时拒绝伪造的市场 itemKey', async () => {
    const response = await createFixture().request('/api/interview-quiz', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        learnerId: TEST_LEARNER_ID,
        initialDifficulty: 'foundation',
        maxRounds: 1,
        selectedJd: {
          source: 'market',
          itemKey: '../secret.md',
        },
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_quiz_config' },
    })
  })
})

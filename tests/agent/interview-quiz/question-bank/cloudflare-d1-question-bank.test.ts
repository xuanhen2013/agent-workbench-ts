import type { FetchLike } from '@/knowledge/cloudflare-ai-search'
import { describe, expect, test } from 'bun:test'
import { QuizDifficulty } from '@/agent/interview-quiz/contracts'
import {
  CloudflareD1QuestionBank,
  CloudflareD1QuestionBankError,
  CloudflareD1QuestionBankErrorCode,
  createCloudflareD1QuestionBankFromEnv,
} from '@/agent/interview-quiz/question-bank/cloudflare-d1-question-bank'
import { createStoredQuizQuestion } from '@/agent/interview-quiz/question-bank/fingerprint'
import { materializeTestPlan } from '../../../helpers/quiz'

function signal() {
  return new AbortController().signal
}

function d1Response(results: Array<Record<string, unknown>> = []) {
  return new Response(JSON.stringify({
    success: true,
    result: [{ success: true, results }],
  }))
}

function createBank(fetch: FetchLike) {
  return new CloudflareD1QuestionBank({
    queryUrl: 'https://api.example.test/d1/query',
    apiToken: 'test-token',
    fetch,
    now: () => '2026-08-01T00:00:00.000Z',
  })
}

describe('CloudflareD1QuestionBank', () => {
  test('initialize 通过同一个安全边界创建表和索引', async () => {
    const requests: Array<{ url: string, init?: RequestInit }> = []
    const fetch: FetchLike = async (input, init) => {
      requests.push({ url: String(input), init })
      return d1Response()
    }
    const bank = createBank(fetch)

    await bank.initialize({ signal: signal() })

    expect(requests).toHaveLength(2)
    expect(requests.every(request => (
      request.url === 'https://api.example.test/d1/query'
    ))).toBe(true)
    expect(new Headers(requests[0]?.init?.headers).get('authorization'))
      .toBe('Bearer test-token')
    expect(JSON.parse(String(requests[0]?.init?.body)).sql)
      .toContain('CREATE TABLE IF NOT EXISTS question_bank')
    expect(JSON.parse(String(requests[1]?.init?.body)).sql)
      .toContain('CREATE INDEX IF NOT EXISTS idx_question_bank_recent')
  })

  test('五题使用一条多行 INSERT，重试返回相同稳定 ID', async () => {
    const bodies: Array<{ sql: string, params: unknown[] }> = []
    const fetch: FetchLike = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return d1Response()
    }
    const bank = createBank(fetch)
    const plan = materializeTestPlan()

    const first = await bank.savePlan(plan, { signal: signal() })
    const second = await bank.savePlan(plan, { signal: signal() })
    const firstQuestions = first.sections[0]!.questions
    const secondQuestions = second.sections[0]!.questions

    expect(bodies).toHaveLength(2)
    expect(bodies[0]?.sql).toContain('INSERT OR IGNORE INTO question_bank')
    expect(bodies[0]?.sql.match(/\(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)/g))
      .toHaveLength(5)
    expect(bodies[0]?.params).toHaveLength(60)
    expect(secondQuestions.map(question => question.bankQuestionId))
      .toEqual(firstQuestions.map(question => question.bankQuestionId))
    expect(plan.sections[0]!.questions.every(question => !question.bankQuestionId))
      .toBe(true)
  })

  test('查询只在 Adapter 边界还原领域数据', async () => {
    const plan = materializeTestPlan()
    const question = plan.sections[0]!.questions[0]!
    const stored = createStoredQuizQuestion({
      difficulty: plan.difficulty,
      question,
      createdAt: '2026-08-01T00:00:00.000Z',
    })
    const fetch: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        sql: string
        params: unknown[]
      }
      if (body.sql.includes('SELECT stem'))
        return d1Response([{ stem: stored.stem }])
      if (body.sql.includes('SELECT *')) {
        return d1Response([{
          bank_question_id: stored.bankQuestionId,
          content_fingerprint: stored.contentFingerprint,
          difficulty: stored.difficulty,
          question_type: stored.type,
          topic: stored.topic,
          knowledge_point: stored.knowledgePoint,
          stem: stored.stem,
          options_json: JSON.stringify(stored.options),
          correct_option_ids_json: JSON.stringify(stored.correctOptionIds),
          explanation: stored.explanation,
          source_chunk_ids_json: JSON.stringify(stored.sourceChunkIds),
          created_at: stored.createdAt,
        }])
      }
      return d1Response([{ count: '5' }])
    }
    const bank = createBank(fetch)

    expect(await bank.findRecentStems({
      difficulty: QuizDifficulty.Foundation,
      knowledgePoints: ['StateGraph'],
      limit: 30,
      signal: signal(),
    })).toEqual([stored.stem])
    expect(await bank.findById(stored.bankQuestionId, { signal: signal() }))
      .toEqual(stored)
    expect(await bank.count({ signal: signal() })).toBe(5)
  })

  test('HTTP 和响应结构失败只暴露稳定错误', async () => {
    const failed = createBank(async () => (
      new Response('provider secret', { status: 503 })
    ))
    const malformed = createBank(async () => (
      new Response(JSON.stringify({ success: true, result: [] }))
    ))

    await expect(failed.count({ signal: signal() })).rejects.toMatchObject({
      code: CloudflareD1QuestionBankErrorCode.RequestFailed,
      status: 503,
    })
    await expect(malformed.count({ signal: signal() })).rejects.toBeInstanceOf(
      CloudflareD1QuestionBankError,
    )
    await expect(malformed.count({ signal: signal() })).rejects.toMatchObject({
      code: CloudflareD1QuestionBankErrorCode.InvalidResponse,
    })
  })

  test('工厂只有配置完整时才启用，并生成官方 Query URL', async () => {
    expect(createCloudflareD1QuestionBankFromEnv({})).toBeUndefined()

    let requestUrl = ''
    const bank = createCloudflareD1QuestionBankFromEnv({
      CLOUDFLARE_ACCOUNT_ID: 'account/id',
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_D1_DATABASE_ID: 'database id',
    }, async (input) => {
      requestUrl = String(input)
      return d1Response([{ count: 0 }])
    })
    if (!bank)
      throw new Error('Expected D1 QuestionBank.')

    await bank.count({ signal: signal() })
    expect(requestUrl).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account%2Fid/d1/database/database%20id/query',
    )
  })
})

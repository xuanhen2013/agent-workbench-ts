import type { InterviewQuizView } from '@/routes/interview-quiz'
import { describe, expect, test } from 'bun:test'
import { importJdDocument } from '@/agent/interview-quiz/jd/import-jd'
import { createApp } from '@/app'
import { FakeEmbeddingModel, InMemoryKnowledgeStore } from '@/knowledge/in-memory-rag'
import { createJokeGraphFixture } from '../helpers/joke'
import { createQuizGraphFixture, TEST_LEARNER_ID } from '../helpers/quiz'

const content = '熟悉 LangGraph、RAG、MCP 和 TypeScript，负责 Agent 应用的前端工程建设。'.repeat(2)

function createFixture() {
  const quiz = createQuizGraphFixture()
  const embedder = new FakeEmbeddingModel()
  const store = new InMemoryKnowledgeStore()
  return {
    quiz,
    app: createApp({
      interviewQuizGraph: quiz.graph,
      jokeGraph: createJokeGraphFixture().graph,
      importJdDocument: (input, options) => importJdDocument(input, {
        embedder,
        store,
      }, options),
    }),
  }
}

describe('Interview Quiz JD API', () => {
  test('导入只返回 document 引用，不回显 JD 原文或 owner', async () => {
    const { app } = createFixture()
    const response = await app.request('/api/interview-quiz/jds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        learnerId: TEST_LEARNER_ID,
        title: 'Agent 前端工程师',
        content,
      }),
    })
    const body = await response.json() as Record<string, unknown>

    expect(response.status).toBe(201)
    expect(body).toEqual({
      jdDocumentId: expect.stringMatching(/^jd:/),
      title: 'Agent 前端工程师',
      chunkCount: expect.any(Number),
    })
    expect(JSON.stringify(body)).not.toContain(content)
    expect(JSON.stringify(body)).not.toContain('ownerId')
  })

  test('非法导入输入返回稳定 400', async () => {
    const { app } = createFixture()
    const response = await app.request('/api/interview-quiz/jds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        learnerId: 'not-a-uuid',
        title: 'A',
        content: 'too short',
      }),
    })
    const body = await response.json() as InterviewQuizView & {
      error?: { code: string }
    }

    expect(response.status).toBe(400)
    expect(body.error?.code).toBe('jd_input_invalid')
  })
})

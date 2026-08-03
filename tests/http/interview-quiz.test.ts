import type { InterviewQuizView } from '@/routes/interview-quiz'
import { describe, expect, test } from 'bun:test'
import { createApp } from '@/app'
import { createJokeGraphFixture } from '../helpers/joke'
import {
  correctSubmission,
  createQuizGraphFixture,
  fakeImportJdDocument,
  TEST_LEARNER_ID,
  wrongSubmission,
} from '../helpers/quiz'

function createFixture() {
  const quiz = createQuizGraphFixture()
  return {
    app: createApp({
      interviewQuizGraph: quiz.graph,
      jokeGraph: createJokeGraphFixture().graph,
      importJdDocument: fakeImportJdDocument,
    }),
    planner: quiz.planner,
  }
}

async function responseBody(response: Response) {
  return await response.json() as InterviewQuizView
}

function parseSse(text: string) {
  return text.trim().split(/\n\n/).map((block) => {
    const event = block.match(/^event: (.+)$/m)?.[1]
    const data = block.match(/^data: (.+)$/m)?.[1]
    return {
      event,
      data: data ? JSON.parse(data) as unknown : undefined,
    }
  })
}

describe('Interview Quiz API', () => {
  test('SSE 创建会话只发送白名单进度和最终安全视图', async () => {
    const { app } = createFixture()
    const response = await app.request('/api/interview-quiz/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        learnerId: TEST_LEARNER_ID,
        initialDifficulty: 'foundation',
        maxRounds: 1,
      }),
    })
    const events = parseSse(await response.text())
    const done = events.find(event => event.event === 'done')
    const progress = events
      .filter(event => event.event === 'progress')
      .map(event => event.data as { phase: string, label: string })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(progress.some(event => event.phase === 'generating_category')).toBe(true)
    expect(progress.some(event => event.phase === 'waiting_for_answers')).toBe(true)
    expect(done?.data).toMatchObject({ status: 'needs_answers' })
    expect(JSON.stringify(events)).not.toContain('correctOptionIds')
    expect(JSON.stringify(events)).not.toContain('explanation')
  })

  test('SSE 下一轮复用同一 thread，并返回新的分类进度', async () => {
    const { app } = createFixture()
    const created = parseSse(await (await app.request('/api/interview-quiz/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        learnerId: TEST_LEARNER_ID,
        initialDifficulty: 'foundation',
        maxRounds: 2,
      }),
    })).text()).find(event => event.event === 'done')?.data as InterviewQuizView
    const questions = created.waitingQuestions
    if (!questions)
      throw new Error('Expected SSE round questions.')

    const result = await app.request(`/api/interview-quiz/${created.threadId}/answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(wrongSubmission(questions)),
    })
    const resultView = await responseBody(result)
    if (!resultView.waitingResult)
      throw new Error('Expected SSE next-round review.')

    const nextResponse = await app.request(
      `/api/interview-quiz/${created.threadId}/next/stream`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reviewId: resultView.waitingResult.reviewId,
          action: 'next_round',
        }),
      },
    )
    const nextEvents = parseSse(await nextResponse.text())
    const nextProgress = nextEvents
      .filter(event => event.event === 'progress')
      .map(event => event.data as { phase: string })
    const nextDone = nextEvents.find(event => event.event === 'done')

    expect(nextResponse.status).toBe(200)
    expect(nextProgress.some(event => event.phase === 'replanning')).toBe(true)
    expect((nextDone?.data as InterviewQuizView).status).toBe('needs_answers')
  })

  test('创建、答题、查看结果、下一轮和最终完成形成完整闭环', async () => {
    const { app, planner } = createFixture()
    const createdResponse = await app.request('/api/interview-quiz', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        learnerId: TEST_LEARNER_ID,
        initialDifficulty: 'foundation',
        maxRounds: 2,
      }),
    })
    const created = await responseBody(createdResponse)

    expect(createdResponse.status).toBe(201)
    expect(created.status).toBe('needs_answers')
    expect(created.waitingQuestions?.sections).toHaveLength(3)
    expect(created.waitingQuestions?.questionCount).toBe(15)
    expect(JSON.stringify(created)).not.toContain('correctOptionIds')
    expect(JSON.stringify(created)).not.toContain('explanation')
    expect(JSON.stringify(created)).not.toContain('bankQuestionId')

    const firstQuestions = created.waitingQuestions
    if (!firstQuestions)
      throw new Error('Expected first quiz round.')

    const firstResultResponse = await app.request(
      `/api/interview-quiz/${created.threadId}/answers`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(wrongSubmission(firstQuestions)),
      },
    )
    const firstResult = await responseBody(firstResultResponse)

    expect(firstResult.status).toBe('round_result')
    expect(firstResult.results).toHaveLength(1)
    expect(firstResult.waitingResult?.result.correctCount).toBe(0)

    const fetched = await responseBody(await app.request(
      `/api/interview-quiz/${created.threadId}`,
    ))
    expect(fetched).toEqual(firstResult)

    const resultRequest = firstResult.waitingResult
    if (!resultRequest)
      throw new Error('Expected result review interrupt.')

    const secondRoundResponse = await app.request(
      `/api/interview-quiz/${created.threadId}/next`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reviewId: resultRequest.reviewId,
          action: 'next_round',
        }),
      },
    )
    const secondRound = await responseBody(secondRoundResponse)

    expect(secondRound.status).toBe('needs_answers')
    expect(secondRound.waitingQuestions?.round).toBe(2)
    expect(planner.calls).toHaveLength(6)

    const secondQuestions = secondRound.waitingQuestions
    if (!secondQuestions)
      throw new Error('Expected second quiz round.')

    const completedResponse = await app.request(
      `/api/interview-quiz/${created.threadId}/answers`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(correctSubmission(secondQuestions)),
      },
    )
    const completed = await responseBody(completedResponse)

    expect(completed.status).toBe('completed')
    expect(completed.results).toHaveLength(2)
    expect(completed.waitingResult).toBeUndefined()
    expect(planner.calls).toHaveLength(6)
  })

  test('非法配置和错误阶段的 next 返回稳定 HTTP 错误', async () => {
    const { app } = createFixture()
    const invalid = await app.request('/api/interview-quiz', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initialDifficulty: 'unknown', maxRounds: 9 }),
    })
    const created = await responseBody(await app.request('/api/interview-quiz', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        learnerId: TEST_LEARNER_ID,
        initialDifficulty: 'foundation',
        maxRounds: 1,
      }),
    }))
    const wrongStage = await app.request(
      `/api/interview-quiz/${created.threadId}/next`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewId: 'wrong', action: 'next_round' }),
      },
    )

    expect(invalid.status).toBe(400)
    expect(wrongStage.status).toBe(409)
  })
})

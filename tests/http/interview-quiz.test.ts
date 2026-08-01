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

describe('Interview Quiz API', () => {
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
    expect(created.waitingQuestions?.questions).toHaveLength(5)
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
    expect(planner.calls).toHaveLength(2)

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
    expect(planner.calls).toHaveLength(2)
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

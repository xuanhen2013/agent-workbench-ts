import type {
  InterviewQuizStreamOptions,
  InterviewQuizView,
} from '@/routes/interview-quiz'
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

function createFixture(streamOptions?: InterviewQuizStreamOptions) {
  const quiz = createQuizGraphFixture()
  return {
    app: createApp({
      interviewQuiz: {
        graph: quiz.graph,
        importJdDocument: fakeImportJdDocument,
        streamOptions,
      },
      jokeGraph: createJokeGraphFixture().graph,
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
    const activities = events
      .filter(event => event.event === 'activity')
      .map(event => event.data as {
        event: string
        label: string
        node?: string
        toolName?: string
        toolRound?: number
      })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(progress.some(event => event.phase === 'generating_category')).toBe(true)
    expect(progress.some(event => event.phase === 'retrieving_question_signals')).toBe(true)
    expect(progress.some(event => event.phase === 'calling_model')).toBe(true)
    expect(progress.some(event => event.phase === 'executing_tools')).toBe(true)
    expect(progress.some(event => event.phase === 'waiting_for_answers')).toBe(true)
    expect(activities.some(event => (
      event.event === 'node_started' && event.node === 'call_model'
    ))).toBe(true)
    expect(activities.some(event => (
      event.event === 'tool_started' && typeof event.toolName === 'string'
    ))).toBe(true)
    expect(activities.some(event => (
      event.event === 'tool_finished' && typeof event.toolName === 'string'
    ))).toBe(true)
    const executeStarted = activities.find(event => (
      event.event === 'node_started' && event.node === 'execute_tools'
    ))
    const executeFinished = activities.find(event => (
      event.event === 'node_finished' && event.node === 'execute_tools'
    ))
    expect(executeStarted?.toolRound).toBeGreaterThanOrEqual(1)
    expect(executeFinished?.toolRound).toBe(executeStarted?.toolRound)
    expect(executeFinished?.label).not.toContain('0 个 Tool')

    const appendStarted = activities.find(event => (
      event.event === 'node_started' && event.node === 'append_tool_outputs'
    ))
    const appendFinished = activities.find(event => (
      event.event === 'node_finished' && event.node === 'append_tool_outputs'
    ))
    expect(appendFinished?.toolRound).toBe(appendStarted?.toolRound)
    expect(appendFinished?.label).not.toContain('第 0 轮')
    expect(activities.some(event => event.event === 'stream_completed')).toBe(true)
    expect(done?.data).toMatchObject({ status: 'needs_answers' })
    expect(JSON.stringify(events)).not.toContain('correctOptionIds')
    expect(JSON.stringify(events)).not.toContain('explanation')
    expect(JSON.stringify(events)).not.toContain('Fake answer_evidence for tests')
  })

  test('SSE 长任务发送 heartbeat，并只展示最近阶段和等待时间', async () => {
    const { app, planner } = createFixture({
      heartbeatMs: 5,
      generationTimeoutMs: 1_000,
    })
    const runModel = planner.runModel.bind(planner)
    planner.runModel = async (input) => {
      await new Promise(resolve => setTimeout(resolve, 20))
      return runModel(input)
    }

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
    const heartbeat = events.find(event => event.event === 'heartbeat')?.data as {
      phase?: string
      label?: string
      elapsedSeconds?: number
    } | undefined

    expect(heartbeat?.phase).toBeString()
    expect(heartbeat?.label).toContain('已等待')
    expect(heartbeat?.elapsedSeconds).toBeGreaterThanOrEqual(1)
    expect(events.some(event => event.event === 'done')).toBe(true)
  })

  test('整次生成超时后通过 SSE 返回稳定错误', async () => {
    const { app, planner } = createFixture({
      heartbeatMs: 50,
      generationTimeoutMs: 5,
    })
    planner.runModel = async ({ signal }) => {
      return await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
      })
    }

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
    const error = events.find(event => event.event === 'error')?.data

    expect(error).toEqual({
      code: 'interview_quiz_generation_timeout',
      message: 'The interview quiz generation timed out. Please try again.',
    })
    expect(events.some(event => event.event === 'done')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('TimeoutError')
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

  test('SSE 提交答案展示判分、长期记忆和下一轮 Interrupt', async () => {
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

    const response = await app.request(
      `/api/interview-quiz/${created.threadId}/answers/stream`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(wrongSubmission(questions)),
      },
    )
    const events = parseSse(await response.text())
    const phases = events
      .filter(event => event.event === 'progress')
      .map(event => (event.data as { phase: string }).phase)
    const done = events.find(event => event.event === 'done')

    expect(response.status).toBe(200)
    expect(phases).toContain('grading')
    expect(phases).toContain('saving_memory')
    expect(phases).toContain('waiting_for_next_round')
    expect((done?.data as InterviewQuizView).status).toBe('round_result')
    expect(JSON.stringify(events)).not.toContain('correctOptionIds')
    expect(JSON.stringify(events)).not.toContain('explanation')
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

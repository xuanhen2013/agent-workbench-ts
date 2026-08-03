import type { JokeView } from '@/routes/jokes'
import { describe, expect, test } from 'bun:test'
import { InterruptReason } from '@/agent/interrupt/state'
import { createApp } from '@/app'
import { createJokeGraphFixture } from '../helpers/joke'
import { createQuizGraphFixture, fakeImportJdDocument } from '../helpers/quiz'

function createFixture() {
  const app = createApp({
    interviewQuiz: {
      graph: createQuizGraphFixture().graph,
      importJdDocument: fakeImportJdDocument,
    },
    jokeGraph: createJokeGraphFixture().graph,
  })
  return { app }
}

async function createJoke(app: ReturnType<typeof createApp>) {
  const response = await app.request('/api/jokes', { method: 'POST' })
  return {
    response,
    body: await response.json() as JokeView,
  }
}

function waitingReviewId(view: JokeView) {
  if (!view.waiting)
    throw new Error('Expected the Joke Thread to be waiting for review.')
  return view.waiting.reviewId
}

describe('Joke API', () => {
  test('创建后返回随机 threadId、笑话和动态 options，GET 可恢复', async () => {
    const fixture = createFixture()
    const created = await createJoke(fixture.app)
    const { threadId } = created.body
    const fetched = await fixture.app.request(`/api/jokes/${threadId}`)

    expect(created.response.status).toBe(201)
    expect(created.body).toEqual({
      threadId: expect.any(String),
      status: 'needs_input',
      round: 1,
      joke: '第一个笑话',
      waiting: {
        kind: 'joke_review',
        reviewId: `${threadId}:review:1`,
        round: 1,
        joke: '第一个笑话',
        question: '好笑吗？',
        options: [
          { value: InterruptReason.Accepted, label: '是个好笑话' },
          { value: InterruptReason.Rejected, label: '一点都不好笑' },
        ],
      },
    })
    expect(await fetched.json()).toEqual(created.body)
  })

  test('页面提交 option value 后，accepted 完成、rejected 返回下一条笑话', async () => {
    const accepted = createFixture()
    const acceptedStart = await createJoke(accepted.app)
    const acceptedThreadId = acceptedStart.body.threadId
    const acceptedResponse = await accepted.app.request(
      `/api/jokes/${acceptedThreadId}/resume`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reviewId: waitingReviewId(acceptedStart.body),
          result: 'accepted',
        }),
      },
    )

    const rejected = createFixture()
    const rejectedStart = await createJoke(rejected.app)
    const rejectedThreadId = rejectedStart.body.threadId
    const rejectedResponse = await rejected.app.request(
      `/api/jokes/${rejectedThreadId}/resume`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reviewId: waitingReviewId(rejectedStart.body),
          result: 'rejected',
        }),
      },
    )

    expect(await acceptedResponse.json()).toEqual({
      threadId: acceptedThreadId,
      status: 'completed',
      round: 1,
      joke: '第一个笑话',
      result: { outcome: 'accepted', rounds: 1 },
    })
    expect(await rejectedResponse.json()).toMatchObject({
      threadId: rejectedThreadId,
      status: 'needs_input',
      round: 2,
      joke: '第二个笑话',
      waiting: {
        reviewId: `${rejectedThreadId}:review:2`,
        round: 2,
        joke: '第二个笑话',
      },
    })
  })

  test('未知 thread、非法 Decision 和终态重复 Resume 返回稳定错误', async () => {
    const fixture = createFixture()
    const missing = await fixture.app.request('/api/jokes/missing')
    const started = await createJoke(fixture.app)
    const { threadId } = started.body
    const invalid = await fixture.app.request(
      `/api/jokes/${threadId}/resume`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ result: 'accepted' }),
      },
    )
    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reviewId: waitingReviewId(started.body),
        result: 'accepted',
      }),
    }
    await fixture.app.request(`/api/jokes/${threadId}/resume`, request)
    const repeated = await fixture.app.request(
      `/api/jokes/${threadId}/resume`,
      request,
    )

    expect(missing.status).toBe(404)
    expect(invalid.status).toBe(400)
    expect(repeated.status).toBe(409)
  })
})

import { Command } from '@langchain/langgraph'
import { describe, expect, test } from 'bun:test'
import {
  DecisionRequestSchema,
} from '@/agent/interrupt/interrupt-graph'
import { InterruptReason, InterruptState } from '@/agent/interrupt/state'
import { createJokeGraphFixture } from '../../helpers/joke'

function config(threadId: string) {
  return {
    configurable: { thread_id: threadId },
    durability: 'sync' as const,
  }
}

async function waitingRequest(
  graph: ReturnType<typeof createJokeGraphFixture>['graph'],
  threadId: string,
) {
  const snapshot = await graph.getState(config(threadId))
  const interruptValue = snapshot.tasks[0]?.interrupts[0]?.value
  return DecisionRequestSchema.parse(interruptValue)
}

async function resume(
  graph: ReturnType<typeof createJokeGraphFixture>['graph'],
  threadId: string,
  reviewId: string,
  result: InterruptReason,
) {
  return graph.invoke(new Command({
    resume: { reviewId, result },
  }), config(threadId))
}

describe('Joke Interrupt Graph', () => {
  test('首次执行生成笑话，并在带动态 options 的评价请求处暂停', async () => {
    const { graph } = createJokeGraphFixture()
    const threadId = 'thread-first'

    await graph.invoke({ threadId }, config(threadId))
    const waiting = await waitingRequest(graph, threadId)

    expect(waiting).toEqual({
      kind: 'joke_review',
      reviewId: 'thread-first:review:1',
      round: 1,
      joke: '第一个笑话',
      question: '好笑吗？',
      options: [
        { value: InterruptReason.Accepted, label: '是个好笑话' },
        { value: InterruptReason.Rejected, label: '一点都不好笑' },
      ],
    })
  })

  test('使用同一个 thread 和 reviewId 接受笑话后完成', async () => {
    const { graph } = createJokeGraphFixture()
    const threadId = 'thread-accepted'
    await graph.invoke({ threadId }, config(threadId))
    const waiting = await waitingRequest(graph, threadId)

    await resume(
      graph,
      threadId,
      waiting.reviewId,
      InterruptReason.Accepted,
    )
    const snapshot = await graph.getState(config(threadId))

    expect(snapshot.values).toMatchObject({
      threadId,
      status: InterruptState.Completed,
      round: 1,
      joke: '第一个笑话',
    })
    expect(snapshot.tasks).toHaveLength(0)
  })

  test('拒绝后生成下一条笑话，第三次拒绝后失败', async () => {
    const { graph, model } = createJokeGraphFixture()
    const threadId = 'thread-rejected'
    await graph.invoke({ threadId }, config(threadId))

    for (let round = 1; round <= 3; round++) {
      const waiting = await waitingRequest(graph, threadId)
      expect(waiting.round).toBe(round)
      expect(waiting.joke).toBe(`第${['一', '二', '三'][round - 1]}个笑话`)
      await resume(
        graph,
        threadId,
        waiting.reviewId,
        InterruptReason.Rejected,
      )
    }

    const snapshot = await graph.getState(config(threadId))
    expect(snapshot.values).toMatchObject({
      status: InterruptState.Failed,
      error: { code: 'max_rounds_exceeded' },
    })
    expect(model.calls).toHaveLength(3)
  })

  test('错误 reviewId 和空模型结果进入稳定失败终态', async () => {
    const mismatch = createJokeGraphFixture()
    await mismatch.graph.invoke(
      { threadId: 'thread-mismatch' },
      config('thread-mismatch'),
    )
    await resume(
      mismatch.graph,
      'thread-mismatch',
      'wrong-review',
      InterruptReason.Accepted,
    )
    const mismatchState = await mismatch.graph.getState(config('thread-mismatch'))

    const empty = createJokeGraphFixture([])
    await empty.graph.invoke(
      { threadId: 'thread-empty' },
      config('thread-empty'),
    )
    const emptyState = await empty.graph.getState(config('thread-empty'))

    expect(mismatchState.values).toMatchObject({
      status: InterruptState.Failed,
      error: { code: 'invalid_review_id' },
    })
    expect(emptyState.values).toMatchObject({
      status: InterruptState.Failed,
      error: { code: 'empty_joke' },
    })
  })
})

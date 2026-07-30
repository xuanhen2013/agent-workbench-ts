import type { StateSnapshot } from '@langchain/langgraph'
import { Command } from '@langchain/langgraph'
import { describe, expect, test } from 'bun:test'
import {
  InterviewQuizStatus,
  QuizDifficulty,
  QuizStrategy,
} from '@/agent/interview-quiz/contracts'
import {
  QuizNextRoundAction,
  QuizRoundRequestSchema,
  QuizRoundResultRequestSchema,
} from '@/agent/interview-quiz/execution'
import {
  correctSubmission,
  createQuizGraphFixture,
  wrongSubmission,
} from '../../helpers/quiz'

function config(threadId: string) {
  return {
    configurable: { thread_id: threadId },
    durability: 'sync' as const,
  }
}

function findInterrupt<T>(
  snapshot: StateSnapshot,
  parse: (value: unknown) => { success: boolean, data?: T },
): T {
  for (const task of snapshot.tasks) {
    for (const item of task.interrupts) {
      const parsed = parse(item.value)
      if (parsed.success && parsed.data)
        return parsed.data
    }
  }
  throw new Error('Expected interrupt was not found.')
}

describe('Interview Quiz Graph', () => {
  test('答错后携带完整 History RePlan，达到 maxRounds 后结束', async () => {
    const { graph, planner } = createQuizGraphFixture()
    const threadId = 'quiz-graph-thread'

    await graph.invoke({
      threadId,
      config: {
        initialDifficulty: QuizDifficulty.Foundation,
        maxRounds: 2,
      },
    }, config(threadId))

    const firstSnapshot = await graph.getState(config(threadId))
    const firstQuestions = findInterrupt(
      firstSnapshot,
      value => QuizRoundRequestSchema.safeParse(value),
    )

    expect(firstQuestions.questions).toHaveLength(5)
    expect(planner.calls).toHaveLength(1)
    expect(firstSnapshot.values.roundContext).toEqual({
      round: 1,
      difficulty: QuizDifficulty.Foundation,
      strategy: QuizStrategy.Initial,
    })

    await graph.invoke(
      new Command({ resume: wrongSubmission(firstQuestions) }),
      config(threadId),
    )

    const resultSnapshot = await graph.getState(config(threadId))
    const roundResult = findInterrupt(
      resultSnapshot,
      value => QuizRoundResultRequestSchema.safeParse(value),
    )

    expect(roundResult.result.correctCount).toBe(0)
    expect(roundResult.result.modelUsage?.cachedTokens).toBe(0)

    await graph.invoke(new Command({
      resume: {
        reviewId: roundResult.reviewId,
        action: QuizNextRoundAction.NextRound,
      },
    }), config(threadId))

    const secondSnapshot = await graph.getState(config(threadId))
    const secondQuestions = findInterrupt(
      secondSnapshot,
      value => QuizRoundRequestSchema.safeParse(value),
    )

    expect(planner.calls).toHaveLength(2)
    expect(planner.calls[1]?.history).toHaveLength(3)
    expect(JSON.stringify(planner.calls[1]?.history)).toContain('错误知识点')
    expect(planner.calls[1]?.strategy).toBe(QuizStrategy.Remediate)
    expect(secondSnapshot.values.roundContext).toEqual({
      round: 2,
      difficulty: QuizDifficulty.Foundation,
      strategy: QuizStrategy.Remediate,
    })

    await graph.invoke(
      new Command({ resume: correctSubmission(secondQuestions) }),
      config(threadId),
    )

    const completed = await graph.getState(config(threadId))
    expect(completed.values).toMatchObject({
      status: InterviewQuizStatus.Completed,
      rounds: [
        { plan: { round: 1 } },
        {
          plan: { round: 2 },
          result: { allCorrect: true },
          modelUsage: { cachedTokens: 800 },
        },
      ],
    })
    expect(completed.tasks.flatMap(task => task.interrupts)).toHaveLength(0)
    expect(planner.calls).toHaveLength(2)
  })

  test('全对后由 replan 提升难度并切换为 advance', async () => {
    const { graph, planner } = createQuizGraphFixture()
    const threadId = 'quiz-graph-advance-thread'

    await graph.invoke({
      threadId,
      config: {
        initialDifficulty: QuizDifficulty.Foundation,
        maxRounds: 2,
      },
    }, config(threadId))

    const firstQuestions = findInterrupt(
      await graph.getState(config(threadId)),
      value => QuizRoundRequestSchema.safeParse(value),
    )
    await graph.invoke(
      new Command({ resume: correctSubmission(firstQuestions) }),
      config(threadId),
    )

    const firstResult = findInterrupt(
      await graph.getState(config(threadId)),
      value => QuizRoundResultRequestSchema.safeParse(value),
    )
    await graph.invoke(new Command({
      resume: {
        reviewId: firstResult.reviewId,
        action: QuizNextRoundAction.NextRound,
      },
    }), config(threadId))

    const secondSnapshot = await graph.getState(config(threadId))
    expect(secondSnapshot.values.roundContext).toEqual({
      round: 2,
      difficulty: QuizDifficulty.Intermediate,
      strategy: QuizStrategy.Advance,
    })
    expect(planner.calls[1]).toMatchObject({
      round: 2,
      difficulty: QuizDifficulty.Intermediate,
      strategy: QuizStrategy.Advance,
    })
  })
})

import type { StateSnapshot } from '@langchain/langgraph'
import process from 'node:process'
import { Command, MemorySaver } from '@langchain/langgraph'
import { expect, test } from 'bun:test'
import { QuizDifficulty } from '@/agent/interview-quiz/contracts'
import {
  QuizNextRoundAction,
  QuizRoundRequestSchema,
  QuizRoundResultRequestSchema,
} from '@/agent/interview-quiz/execution'
import { createInterviewQuizGraph } from '@/agent/interview-quiz/interview-quiz-graph'
import { QuizPlanner } from '@/agent/interview-quiz/planning'
import { createOpenAIModelClient } from '@/clients/openai'

const requiredModelEnvironment = [
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_DEFAULT_MODAL',
] as const

function assertSmokeEnvironment() {
  const missing = requiredModelEnvironment
    .filter(name => !process.env[name]?.trim())
  if (missing.length > 0) {
    throw new Error(
      `Interview Quiz smoke test requires: ${missing.join(', ')}`,
    )
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

test('真实 Responses API 完成两轮 Agent Quiz 并记录缓存 usage', async () => {
  assertSmokeEnvironment()
  const { client, model } = createOpenAIModelClient(process.env)
  const graph = createInterviewQuizGraph({
    checkpointer: new MemorySaver(),
    planner: new QuizPlanner(client, model),
  })
  const threadId = `interview-quiz-smoke-${crypto.randomUUID()}`
  const graphConfig = {
    configurable: { thread_id: threadId },
    durability: 'sync' as const,
  }

  await graph.invoke({
    threadId,
    config: {
      initialDifficulty: QuizDifficulty.Foundation,
      maxRounds: 2,
    },
  }, graphConfig)

  const firstQuestions = findInterrupt(
    await graph.getState(graphConfig),
    value => QuizRoundRequestSchema.safeParse(value),
  )
  const submission = {
    reviewId: firstQuestions.reviewId,
    answers: firstQuestions.questions.map(question => ({
      questionId: question.questionId,
      selectedOptionIds: [question.options[0]!.optionId],
    })),
  }

  await graph.invoke(new Command({ resume: submission }), graphConfig)
  const firstResult = findInterrupt(
    await graph.getState(graphConfig),
    value => QuizRoundResultRequestSchema.safeParse(value),
  )

  await graph.invoke(new Command({
    resume: {
      reviewId: firstResult.reviewId,
      action: QuizNextRoundAction.NextRound,
    },
  }), graphConfig)

  const secondSnapshot = await graph.getState(graphConfig)
  const secondQuestions = findInterrupt(
    secondSnapshot,
    value => QuizRoundRequestSchema.safeParse(value),
  )
  const usage = secondSnapshot.values.currentModelUsage as {
    inputTokens: number
    cachedTokens: number
    cacheWriteTokens: number
  } | null

  expect(secondQuestions.round).toBe(2)
  expect(secondQuestions.questions).toHaveLength(5)
  if (usage) {
    expect(usage.inputTokens).toBeGreaterThan(0)
    expect(usage.cachedTokens).toBeGreaterThanOrEqual(0)
    expect(usage.cacheWriteTokens).toBeGreaterThanOrEqual(0)
  }
})

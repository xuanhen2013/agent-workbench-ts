import type { StateSnapshot } from '@langchain/langgraph'
import type { QuizRoundPlan } from '@/agent/interview-quiz/contracts'
import type {
  LearningMemory,
  LearningMemoryContext,
  RoundAttemptInput,
} from '@/agent/interview-quiz/learning-memory/contracts'
import type {
  FindRecentStemsInput,
  QuestionBank,
} from '@/agent/interview-quiz/question-bank/contracts'
import { Command, MemorySaver } from '@langchain/langgraph'
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import {
  InterviewQuizStatus,
  QuizDifficulty,
} from '@/agent/interview-quiz/contracts'
import { InterviewQuizErrorCode } from '@/agent/interview-quiz/errors'
import { QuizRoundRequestSchema } from '@/agent/interview-quiz/execution'
import { createInterviewQuizGraph } from '@/agent/interview-quiz/interview-quiz-graph'
import { SqliteLearningMemory } from '@/agent/interview-quiz/learning-memory/sqlite-learning-memory'
import { InMemoryQuestionBank } from '@/agent/interview-quiz/question-bank/in-memory-question-bank'
import {
  createQuizGraphFixture,
  FakeKnowledgeRetriever,
  FakeLearningMemory,
  FakeQuizPlanner,
  TEST_LEARNER_ID,
  wrongSubmission,
} from '../../helpers/quiz'

function graphConfig(threadId: string) {
  return {
    configurable: { thread_id: threadId },
    durability: 'sync' as const,
  }
}

function findRoundRequest(snapshot: StateSnapshot) {
  for (const task of snapshot.tasks) {
    for (const item of task.interrupts) {
      const parsed = QuizRoundRequestSchema.safeParse(item.value)
      if (parsed.success)
        return parsed.data
    }
  }
  throw new Error('Expected quiz request interrupt.')
}

class TrackingQuestionBank extends InMemoryQuestionBank {
  readonly inputs: FindRecentStemsInput[] = []

  override async findRecentStems(input: FindRecentStemsInput) {
    this.inputs.push({ ...input })
    return await super.findRecentStems(input)
  }
}

class NoBankIdQuestionBank extends InMemoryQuestionBank {
  override async savePlan(
    plan: QuizRoundPlan,
    options: { signal: AbortSignal },
  ) {
    options.signal.throwIfAborted()
    return plan
  }
}

class FaultyLearningMemory implements LearningMemory {
  readonly attempts: RoundAttemptInput[] = []

  constructor(
    private readonly failure: 'load' | 'save',
  ) {}

  async loadContext(
    _learnerId: string,
    options: { signal: AbortSignal },
  ): Promise<LearningMemoryContext> {
    options.signal.throwIfAborted()
    if (this.failure === 'load')
      throw new Error('private memory load failure')
    return { weakKnowledgePoints: [] }
  }

  async recordRound(
    input: RoundAttemptInput,
    options: { signal: AbortSignal },
  ) {
    options.signal.throwIfAborted()
    if (this.failure === 'save')
      throw new Error('private memory save failure')
    this.attempts.push(structuredClone(input))
    return { inserted: true }
  }

  async listTopicMastery(
    _learnerId: string,
    options: { signal: AbortSignal },
  ) {
    options.signal.throwIfAborted()
    return []
  }
}

function createGraph(
  learningMemory: LearningMemory,
  questionBank: QuestionBank = new InMemoryQuestionBank(),
) {
  const planner = new FakeQuizPlanner()
  const questionSignalRetriever = new FakeKnowledgeRetriever()
  const graph = createInterviewQuizGraph({
    checkpointer: new MemorySaver(),
    planner,
    questionSignalRetriever,
    questionBank,
    learningMemory,
  })
  return { graph, planner, questionSignalRetriever, learningMemory }
}

describe('Interview Quiz Graph LearningMemory', () => {
  test('新 Thread 只加载一次，并把跨 Session 弱点传给题库、RAG 和 Planner', async () => {
    const database = new Database(':memory:')
    const memory = new SqliteLearningMemory(database)

    try {
      const first = createGraph(memory)
      const firstThreadId = 'memory-cross-session-thread-A'
      await first.graph.invoke({
        threadId: firstThreadId,
        learnerId: TEST_LEARNER_ID,
        config: {
          initialDifficulty: QuizDifficulty.Foundation,
          maxRounds: 1,
        },
      }, graphConfig(firstThreadId))

      const firstRequest = findRoundRequest(
        await first.graph.getState(graphConfig(firstThreadId)),
      )
      await first.graph.invoke(new Command({
        resume: wrongSubmission(firstRequest),
      }), graphConfig(firstThreadId))

      expect((await first.graph.getState(graphConfig(firstThreadId))).values)
        .toMatchObject({ status: InterviewQuizStatus.Completed })

      const persistedContext = await memory.loadContext(
        TEST_LEARNER_ID,
        { signal: new AbortController().signal },
      )
      expect(persistedContext.weakKnowledgePoints.length).toBeGreaterThan(0)

      const secondQuestionBank = new TrackingQuestionBank()
      const second = createGraph(memory, secondQuestionBank)
      const secondThreadId = 'memory-cross-session-thread-B'
      await second.graph.invoke({
        threadId: secondThreadId,
        learnerId: TEST_LEARNER_ID,
        config: {
          initialDifficulty: QuizDifficulty.Foundation,
          maxRounds: 1,
        },
      }, graphConfig(secondThreadId))

      expect(second.planner.calls[0]?.memoryContext)
        .toEqual(persistedContext)
      expect(secondQuestionBank.inputs[0]?.knowledgePoints)
        .toEqual(persistedContext.weakKnowledgePoints)
      expect(second.questionSignalRetriever.calls[0]?.query)
        .toContain(persistedContext.weakKnowledgePoints[0]!)
      expect((await second.graph.getState(graphConfig(secondThreadId))).values)
        .toMatchObject({ status: InterviewQuizStatus.WaitingForAnswers })
    }
    finally {
      database.close()
    }
  })

  test('同一 Thread 的 RePlan 不重复加载长期记忆', async () => {
    const fixture = createQuizGraphFixture()
    const threadId = 'memory-load-once-thread'
    await fixture.graph.invoke({
      threadId,
      learnerId: TEST_LEARNER_ID,
      config: {
        initialDifficulty: QuizDifficulty.Foundation,
        maxRounds: 2,
      },
    }, graphConfig(threadId))
    const firstRequest = findRoundRequest(
      await fixture.graph.getState(graphConfig(threadId)),
    )
    await fixture.graph.invoke(new Command({
      resume: wrongSubmission(firstRequest),
    }), graphConfig(threadId))

    const resultSnapshot = await fixture.graph.getState(graphConfig(threadId))
    const resultValue = resultSnapshot.tasks
      .flatMap(task => task.interrupts)
      .map(item => item.value)
      .find(value => typeof value === 'object' && value !== null
        && 'result' in value) as { reviewId: string } | undefined
    if (!resultValue)
      throw new Error('Expected round result interrupt.')

    await fixture.graph.invoke(new Command({
      resume: { reviewId: resultValue.reviewId, action: 'next_round' },
    }), graphConfig(threadId))

    expect((fixture.learningMemory as FakeLearningMemory).loadCalls).toBe(1)
  })

  test('LearningMemory 加载失败在调用 Planner 前终止并映射稳定错误', async () => {
    const fixture = createGraph(new FaultyLearningMemory('load'))
    const threadId = 'memory-load-failure-thread'
    await fixture.graph.invoke({
      threadId,
      learnerId: TEST_LEARNER_ID,
      config: {
        initialDifficulty: QuizDifficulty.Foundation,
        maxRounds: 1,
      },
    }, graphConfig(threadId))

    const snapshot = await fixture.graph.getState(graphConfig(threadId))
    expect(snapshot.values).toMatchObject({
      status: InterviewQuizStatus.Failed,
      error: { code: InterviewQuizErrorCode.LearningMemoryLoadFailed },
    })
    expect(fixture.planner.calls).toHaveLength(0)
  })

  test('LearningMemory 保存失败不会把本轮标记为完成', async () => {
    const fixture = createGraph(new FaultyLearningMemory('save'))
    const threadId = 'memory-save-failure-thread'
    await fixture.graph.invoke({
      threadId,
      learnerId: TEST_LEARNER_ID,
      config: {
        initialDifficulty: QuizDifficulty.Foundation,
        maxRounds: 1,
      },
    }, graphConfig(threadId))
    const request = findRoundRequest(
      await fixture.graph.getState(graphConfig(threadId)),
    )
    await fixture.graph.invoke(new Command({
      resume: wrongSubmission(request),
    }), graphConfig(threadId))

    const snapshot = await fixture.graph.getState(graphConfig(threadId))
    expect(snapshot.values).toMatchObject({
      status: InterviewQuizStatus.Failed,
      error: { code: InterviewQuizErrorCode.LearningMemorySaveFailed },
    })
  })

  test('缺少 bankQuestionId 时拒绝写入长期记忆', async () => {
    const fixture = createGraph(
      new FakeLearningMemory(),
      new NoBankIdQuestionBank(),
    )
    const threadId = 'memory-missing-bank-id-thread'
    await fixture.graph.invoke({
      threadId,
      learnerId: TEST_LEARNER_ID,
      config: {
        initialDifficulty: QuizDifficulty.Foundation,
        maxRounds: 1,
      },
    }, graphConfig(threadId))
    const request = findRoundRequest(
      await fixture.graph.getState(graphConfig(threadId)),
    )
    await fixture.graph.invoke(new Command({
      resume: wrongSubmission(request),
    }), graphConfig(threadId))

    const snapshot = await fixture.graph.getState(graphConfig(threadId))
    expect(snapshot.values).toMatchObject({
      status: InterviewQuizStatus.Failed,
      error: { code: InterviewQuizErrorCode.MemoryAttemptInvalid },
    })
    expect((fixture.learningMemory as FakeLearningMemory).attempts)
      .toHaveLength(0)
  })
})

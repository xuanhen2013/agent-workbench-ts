import type { StateSnapshot } from '@langchain/langgraph'
import type { QuizRoundPlan } from '@/agent/interview-quiz/contracts'
import type {
  FindRecentStemsInput,
  QuestionBank,
} from '@/agent/interview-quiz/question-bank/contracts'
import { MemorySaver } from '@langchain/langgraph'
import { describe, expect, test } from 'bun:test'
import {
  InterviewQuizStatus,
  QuizDifficulty,
} from '@/agent/interview-quiz/contracts'
import { InterviewQuizErrorCode } from '@/agent/interview-quiz/errors'
import { QuizRoundRequestSchema } from '@/agent/interview-quiz/execution'
import { createInterviewQuizGraph } from '@/agent/interview-quiz/interview-quiz-graph'
import { InMemoryQuestionBank } from '@/agent/interview-quiz/question-bank/in-memory-question-bank'
import {
  createQuizPlanningSubgraph,
  FakeKnowledgeRetriever,
  FakeLearningMemory,
  FakeQuizPlanner,
  materializeTestPlan,
  TEST_LEARNER_ID,
} from '../../helpers/quiz'

function config(threadId: string) {
  return {
    configurable: { thread_id: threadId },
    durability: 'sync' as const,
  }
}

function findRoundRequest(snapshot: StateSnapshot) {
  for (const task of snapshot.tasks) {
    for (const interrupt of task.interrupts) {
      const request = QuizRoundRequestSchema.safeParse(interrupt.value)
      if (request.success)
        return request.data
    }
  }
  throw new Error('Expected round request interrupt.')
}

class TrackingQuestionBank extends InMemoryQuestionBank {
  readonly events: string[] = []
  readonly findInputs: FindRecentStemsInput[] = []

  override async findRecentStems(input: FindRecentStemsInput) {
    this.events.push('read')
    this.findInputs.push(input)
    return await super.findRecentStems(input)
  }

  override async savePlan(
    plan: QuizRoundPlan,
    options: { signal: AbortSignal },
  ) {
    this.events.push('save')
    return await super.savePlan(plan, options)
  }
}

function createGraph(questionBank: QuestionBank, planner = new FakeQuizPlanner()) {
  return {
    planner,
    graph: createInterviewQuizGraph({
      checkpointer: new MemorySaver(),
      planningSubgraph: createQuizPlanningSubgraph(
        planner,
        questionBank,
        new FakeKnowledgeRetriever(),
      ),
      questionBank,
      learningMemory: new FakeLearningMemory(),
    }),
  }
}

describe('Interview Quiz Graph QuestionBank', () => {
  test('Planner 前读取有界题干，并在 Interrupt 前保存稳定题目', async () => {
    const questionBank = new TrackingQuestionBank()
    const historicalPlan = materializeTestPlan({ threadId: 'history-thread' })
    await questionBank.savePlan(historicalPlan, {
      signal: new AbortController().signal,
    })
    questionBank.events.length = 0
    const { graph, planner } = createGraph(questionBank)
    const threadId = 'question-bank-graph-thread'

    await graph.invoke({
      threadId,
      learnerId: TEST_LEARNER_ID,
      config: {
        initialDifficulty: QuizDifficulty.Foundation,
        maxRounds: 1,
      },
    }, config(threadId))

    const snapshot = await graph.getState(config(threadId))
    const request = findRoundRequest(snapshot)
    const currentPlan = snapshot.values.currentPlan as QuizRoundPlan

    expect(questionBank.events).toEqual(['read', 'save'])
    expect(questionBank.findInputs[0]).toMatchObject({
      difficulty: QuizDifficulty.Foundation,
      knowledgePoints: [],
      limit: 30,
    })
    expect(planner.calls[0]?.previousQuestionStems)
      .toContain(historicalPlan.questions[0]!.stem)
    expect(planner.calls[0]?.previousQuestionStems.length)
      .toBeLessThanOrEqual(30)
    expect(currentPlan.questions.every(question => question.bankQuestionId))
      .toBe(true)
    expect(JSON.stringify(request)).not.toContain('bankQuestionId')
    expect(await questionBank.count({
      signal: new AbortController().signal,
    })).toBe(5)
  })

  test('题库读取和保存失败映射成 Workflow 稳定错误', async () => {
    const base = new InMemoryQuestionBank()
    const readFailure: QuestionBank = {
      ...base,
      findRecentStems: async () => {
        throw new Error('private read failure')
      },
      savePlan: (plan, options) => base.savePlan(plan, options),
      findById: (id, options) => base.findById(id, options),
      count: options => base.count(options),
    }
    const read = createGraph(readFailure).graph
    await read.invoke({
      threadId: 'question-bank-read-failure',
      learnerId: TEST_LEARNER_ID,
      config: {
        initialDifficulty: QuizDifficulty.Foundation,
        maxRounds: 1,
      },
    }, config('question-bank-read-failure'))
    const readState = await read.getState(config('question-bank-read-failure'))

    const saveFailure: QuestionBank = {
      findRecentStems: input => base.findRecentStems(input),
      savePlan: async () => {
        throw new Error('private save failure')
      },
      findById: (id, options) => base.findById(id, options),
      count: options => base.count(options),
    }
    const save = createGraph(saveFailure).graph
    await save.invoke({
      threadId: 'question-bank-save-failure',
      learnerId: TEST_LEARNER_ID,
      config: {
        initialDifficulty: QuizDifficulty.Foundation,
        maxRounds: 1,
      },
    }, config('question-bank-save-failure'))
    const saveState = await save.getState(config('question-bank-save-failure'))

    expect(readState.values).toMatchObject({
      status: InterviewQuizStatus.Failed,
      error: { code: InterviewQuizErrorCode.QuestionBankReadFailed },
    })
    expect(JSON.stringify(readState.values.error)).not.toContain('private')
    expect(saveState.values).toMatchObject({
      status: InterviewQuizStatus.Failed,
      error: { code: InterviewQuizErrorCode.QuestionBankSaveFailed },
    })
    expect(JSON.stringify(saveState.values.error)).not.toContain('private')
  })
})

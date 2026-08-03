import type { FindRecentStemsInput } from '@/agent/interview-quiz/question-bank/contracts'
import type { PlanningInput } from '@/agent/interview-quiz/subgraphs/planning/state'
import type { KnowledgeRetriever, RetrievedChunk } from '@/knowledge/contracts'
import { describe, expect, test } from 'bun:test'
import {
  QuizDifficulty,
  QuizStrategy,
} from '@/agent/interview-quiz/contracts'
import {
  createInterviewQuizError,
  InterviewQuizErrorCode,
} from '@/agent/interview-quiz/errors'
import {
  createPlanningSubgraph,
} from '@/agent/interview-quiz/subgraphs/planning/graph'
import {
  KnowledgeEvidenceRole,
  KnowledgeSourceType,
} from '@/knowledge/contracts'
import { FakeQuizPlanner } from '../../../../helpers/quiz'

class RecordingQuestionHistory {
  readonly calls: FindRecentStemsInput[] = []

  constructor(
    private readonly stems: string[] = [],
  ) {}

  async findRecentStems(input: FindRecentStemsInput) {
    this.calls.push(input)
    input.signal.throwIfAborted()
    return this.stems.slice(0, input.limit)
  }
}

class RecordingRetriever implements Pick<KnowledgeRetriever, 'search'> {
  readonly calls: Array<
    Parameters<KnowledgeRetriever['search']>[0]
  > = []

  constructor(
    private readonly chunks: RetrievedChunk[] = [],
  ) {}

  async search(
    input: Parameters<KnowledgeRetriever['search']>[0],
  ) {
    this.calls.push(input)
    input.signal.throwIfAborted()
    return this.chunks
  }
}

function createChunk(chunkId: string): RetrievedChunk {
  return {
    chunkId,
    documentId: `document:${chunkId}`,
    sourceType: KnowledgeSourceType.InterviewBank,
    evidenceRole: KnowledgeEvidenceRole.QuestionSignal,
    ownerId: null,
    title: 'Planning test',
    sourceUri: 'test:planning',
    heading: 'Test',
    text: `Question signal ${chunkId}`,
    ordinal: 0,
    score: 1,
  }
}

function createInput(
  overrides: Partial<PlanningInput> = {},
): PlanningInput {
  return {
    threadId: 'planning-subgraph-thread',
    roundContext: {
      round: 1,
      difficulty: QuizDifficulty.Foundation,
      strategy: QuizStrategy.Initial,
    },
    modelHistory: [],
    completedQuestionStems: [],
    previousWrongKnowledgePoints: [],
    memoryContext: {
      weakKnowledgePoints: [],
    },
    jdContext: null,
    ...overrides,
  }
}

function createFixture(input?: {
  questionStems?: string[]
  chunks?: RetrievedChunk[]
}) {
  const planner = new FakeQuizPlanner()
  const questionHistory = new RecordingQuestionHistory(
    input?.questionStems,
  )
  const retriever = new RecordingRetriever(input?.chunks)
  const graph = createPlanningSubgraph({
    planner,
    questionBank: questionHistory,
    questionSignalRetriever: retriever,
  })

  return {
    graph,
    planner,
    questionHistory,
    retriever,
  }
}

describe('Planning Subgraph', () => {
  test('初轮生成完整题卷，并返回本轮规划输出', async () => {
    const fixture = createFixture({
      chunks: [createChunk('signal:first')],
    })

    const output = await fixture.graph.invoke(createInput())

    expect(output.error).toBeNull()
    expect(output.currentPlan).not.toBeNull()
    expect(output.currentPlan?.questions).toHaveLength(5)
    expect(output.currentPlan?.round).toBe(1)
    expect(output.continuationItems).toHaveLength(1)
    expect(output.modelUsage).toMatchObject({
      inputTokens: 1100,
      cachedTokens: 0,
    })
    expect(output.retrievedChunks.map(chunk => chunk.chunkId)).toEqual([
      'signal:first',
      'fake:answer_evidence',
    ])
    expect(fixture.planner.modelCalls).toHaveLength(2)
    expect(fixture.planner.toolCalls).toEqual([
      'fake-answer-evidence-call',
    ])
  })

  test('Remediate 使用上一轮错题知识点构造题库和检索输入', async () => {
    const fixture = createFixture()

    await fixture.graph.invoke(createInput({
      roundContext: {
        round: 2,
        difficulty: QuizDifficulty.Foundation,
        strategy: QuizStrategy.Remediate,
      },
      previousWrongKnowledgePoints: ['checkpoint', 'interrupt'],
    }))

    expect(fixture.questionHistory.calls[0]?.knowledgePoints).toEqual([
      'checkpoint',
      'interrupt',
    ])
    expect(fixture.retriever.calls[0]?.query).toContain(
      'checkpoint interrupt',
    )
    expect(fixture.retriever.calls[0]?.limit).toBe(4)
    expect(fixture.retriever.calls[0]?.filter).toEqual({
      evidenceRoles: [KnowledgeEvidenceRole.QuestionSignal],
      ownerId: null,
    })
    expect(fixture.planner.calls[0]).toMatchObject({
      round: 2,
      strategy: QuizStrategy.Remediate,
    })
  })

  test('最多向 Planner 提供 30 条去重后的历史题干', async () => {
    const fixture = createFixture({
      questionStems: Array.from(
        { length: 40 },
        (_, index) => `bank-stem-${index}`,
      ),
    })

    await fixture.graph.invoke(createInput({
      completedQuestionStems: [
        'completed-stem',
        'completed-stem',
      ],
    }))

    const stems = fixture.planner.calls[0]?.previousQuestionStems ?? []
    expect(stems).toHaveLength(30)
    expect(new Set(stems).size).toBe(30)
    expect(stems[0]).toBe('completed-stem')
  })

  test('QuestionBank、Retriever 和 Planner 失败都转换为稳定错误', async () => {
    const input = createInput()
    const planner = new FakeQuizPlanner()

    const questionBankFailure = createPlanningSubgraph({
      planner,
      questionBank: {
        async findRecentStems() {
          throw new Error('raw question bank error')
        },
      },
      questionSignalRetriever: new RecordingRetriever(),
    })
    const questionBankOutput = await questionBankFailure.invoke(input)
    expect(questionBankOutput.error).toEqual(
      createInterviewQuizError(
        InterviewQuizErrorCode.QuestionBankReadFailed,
      ),
    )

    const retrieverFailure = createPlanningSubgraph({
      planner,
      questionBank: new RecordingQuestionHistory(),
      questionSignalRetriever: {
        async search() {
          throw new Error('raw retriever error')
        },
      },
    })
    const retrieverOutput = await retrieverFailure.invoke(input)
    expect(retrieverOutput.error).toEqual(
      createInterviewQuizError(
        InterviewQuizErrorCode.KnowledgeRetrievalFailed,
      ),
    )

    const plannerFailure = createPlanningSubgraph({
      planner: {
        createInitialConversation() {
          return []
        },
        createToolSet() {
          return {
            definitions: [],
            executor: {
              async execute(call) {
                return {
                  ok: true as const,
                  callId: call.callId,
                  name: call.name,
                  output: null,
                }
              },
            },
          }
        },
        async runModel() {
          throw new Error('raw planner error')
        },
        getRequiredSkillNames() {
          return []
        },
        validateDraft() {
          throw new Error('must not validate failed plan')
        },
        materializeRoundPlan() {
          throw new Error('must not materialize failed plan')
        },
      },
      questionBank: new RecordingQuestionHistory(),
      questionSignalRetriever: new RecordingRetriever(),
    })
    const plannerOutput = await plannerFailure.invoke(input)
    expect(plannerOutput.error).toEqual(
      createInterviewQuizError(
        InterviewQuizErrorCode.PlannerCallFailed,
      ),
    )
  })

  test('默认 per-invocation 不复用上一次调用的私有 State', async () => {
    const planner = new FakeQuizPlanner()
    let questionBankCall = 0
    let retrieverCall = 0
    const graph = createPlanningSubgraph({
      planner,
      questionBank: {
        async findRecentStems(input) {
          input.signal.throwIfAborted()
          questionBankCall += 1
          return [`history-from-call-${questionBankCall}`]
        },
      },
      questionSignalRetriever: {
        async search(input) {
          input.signal.throwIfAborted()
          retrieverCall += 1
          return [createChunk(`signal-from-call-${retrieverCall}`)]
        },
      },
    })

    const first = await graph.invoke(createInput({
      threadId: 'same-parent-thread',
    }))
    const second = await graph.invoke(createInput({
      threadId: 'same-parent-thread',
      roundContext: {
        round: 2,
        difficulty: QuizDifficulty.Intermediate,
        strategy: QuizStrategy.Advance,
      },
    }))

    expect(first.questionBankStems).toEqual(['history-from-call-1'])
    expect(second.questionBankStems).toEqual(['history-from-call-2'])
    expect(first.retrievedChunks[0]?.chunkId).toBe('signal-from-call-1')
    expect(second.retrievedChunks[0]?.chunkId).toBe('signal-from-call-2')
    expect(planner.calls[1]?.previousQuestionStems).not.toContain(
      'history-from-call-1',
    )
    expect(second.currentPlan?.round).toBe(2)
  })
})

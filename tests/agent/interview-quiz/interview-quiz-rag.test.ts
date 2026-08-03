import type { StateSnapshot } from '@langchain/langgraph'
import type { KnowledgeRetriever } from '@/knowledge/contracts'
import { Command, MemorySaver } from '@langchain/langgraph'
import { describe, expect, test } from 'bun:test'
import {
  InterviewQuizStatus,
  QuizDifficulty,
} from '@/agent/interview-quiz/contracts'
import {
  QuizRoundRequestSchema,
} from '@/agent/interview-quiz/execution'
import { createInterviewQuizGraph } from '@/agent/interview-quiz/interview-quiz-graph'
import { SelectedJdSource } from '@/agent/interview-quiz/jd/contracts'
import { InMemoryQuestionBank } from '@/agent/interview-quiz/question-bank/in-memory-question-bank'
import {
  KnowledgeEvidenceRole,
  KnowledgeSourceType,
} from '@/knowledge/contracts'
import {
  createQuizGraphFixture,
  createQuizPlanningSubgraph,
  FakeKnowledgeRetriever,
  FakeLearningMemory,
  FakeQuizPlanner,
  TEST_LEARNER_ID,
  wrongSubmission,
} from '../../helpers/quiz'

function config(threadId: string) {
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

describe('Interview Quiz Graph RAG', () => {
  test('选择 JD 时只加载 owner-scoped 重点，并让公共 question_signal 查询使用 JD 重点', async () => {
    const { graph, knowledgeRetriever, planner } = createQuizGraphFixture()
    knowledgeRetriever.jdDocuments.push({
      chunkId: 'jd:test:chunk:0',
      documentId: 'jd:test',
      sourceType: KnowledgeSourceType.Jd,
      evidenceRole: KnowledgeEvidenceRole.QuestionSignal,
      ownerId: TEST_LEARNER_ID,
      title: 'Agent 前端工程师',
      sourceUri: 'user-upload:jd:test',
      heading: '要求',
      text: '熟悉 LangGraph、RAG 和 MCP，能够建设 Agent 应用。',
      ordinal: 0,
    })
    const threadId = 'quiz-jd-context-thread'

    await graph.invoke({
      threadId,
      learnerId: TEST_LEARNER_ID,
      config: {
        initialDifficulty: QuizDifficulty.Foundation,
        maxRounds: 1,
        selectedJd: {
          source: SelectedJdSource.UserUpload,
          documentId: 'jd:test',
        },
      },
    }, config(threadId))

    findRoundRequest(await graph.getState(config(threadId)))
    expect(planner.calls[0]?.jdContext).toEqual({
      reference: {
        source: SelectedJdSource.UserUpload,
        documentId: 'jd:test',
      },
      title: 'Agent 前端工程师',
      focusKnowledgePoints: ['LangGraph', 'RAG', 'MCP'],
    })
    const queries = knowledgeRetriever.calls.map(call => call.query).join('\n')
    expect(knowledgeRetriever.calls).toHaveLength(3)
    expect(queries).toContain('LangGraph')
    expect(queries).toContain('RAG')
    expect(queries).toContain('MCP')
  })

  test('选择市场 JD 时由 MarketJdCatalog 加载，而不是读取 learner 私有文档', async () => {
    const planner = new FakeQuizPlanner()
    const knowledgeRetriever = new FakeKnowledgeRetriever()
    const itemKey
      = 'question-signal/jd-market/jd-market-aaaaaaaaaaaaaaaaaaaa.md'
    const loadCalls: string[] = []
    const questionBank = new InMemoryQuestionBank()
    const graph = createInterviewQuizGraph({
      checkpointer: new MemorySaver(),
      planningSubgraph: createQuizPlanningSubgraph(
        planner,
        questionBank,
        knowledgeRetriever,
      ),
      jdRetriever: knowledgeRetriever,
      marketJdCatalog: {
        async load(input) {
          loadCalls.push(input.itemKey)
          return {
            reference: {
              source: SelectedJdSource.Market,
              itemKey,
            },
            title: 'AI Agent 前端工程师',
            focusKnowledgePoints: ['LangGraph', 'Tool Calling'],
          }
        },
      },
      questionBank,
      learningMemory: new FakeLearningMemory(),
    })
    const threadId = 'quiz-market-jd-context-thread'

    await graph.invoke({
      threadId,
      learnerId: TEST_LEARNER_ID,
      config: {
        initialDifficulty: QuizDifficulty.Foundation,
        maxRounds: 1,
        selectedJd: {
          source: SelectedJdSource.Market,
          itemKey,
        },
      },
    }, config(threadId))

    findRoundRequest(await graph.getState(config(threadId)))
    expect(loadCalls).toEqual([itemKey])
    expect(planner.calls[0]?.jdContext).toMatchObject({
      reference: { source: SelectedJdSource.Market, itemKey },
      focusKnowledgePoints: ['LangGraph', 'Tool Calling'],
    })
  })

  test('Graph 只预取 question_signal，Planner 返回动态 answer_evidence', async () => {
    const planner = new FakeQuizPlanner()
    const knowledgeRetriever = new FakeKnowledgeRetriever()
    const questionBank = new InMemoryQuestionBank()
    const graph = createInterviewQuizGraph({
      checkpointer: new MemorySaver(),
      planningSubgraph: createQuizPlanningSubgraph(
        planner,
        questionBank,
        knowledgeRetriever,
      ),
      questionBank,
      learningMemory: new FakeLearningMemory(),
    })
    const threadId = 'quiz-rag-thread'

    await graph.invoke({
      threadId,
      learnerId: TEST_LEARNER_ID,
      config: {
        initialDifficulty: QuizDifficulty.Foundation,
        maxRounds: 1,
      },
    }, config(threadId))

    const snapshot = await graph.getState(config(threadId))
    findRoundRequest(snapshot)
    expect(knowledgeRetriever.calls.map(call => call.role)).toEqual([
      'question_signal',
      'question_signal',
      'question_signal',
    ])
    expect(planner.calls.every(call => call.retrievedChunks.length === 1))
      .toBe(true)
    expect(snapshot.values.retrievedChunks).toHaveLength(2)
  })

  test('没有 question_signal 时仍交给 Planner 决定是否追加检索', async () => {
    const planner = new FakeQuizPlanner()
    const questionBank = new InMemoryQuestionBank()
    const questionSignalRetriever: Pick<KnowledgeRetriever, 'search'> = {
      async search(input) {
        input.signal.throwIfAborted()
        return []
      },
    }
    const graph = createInterviewQuizGraph({
      checkpointer: new MemorySaver(),
      planningSubgraph: createQuizPlanningSubgraph(
        planner,
        questionBank,
        questionSignalRetriever,
      ),
      questionBank,
      learningMemory: new FakeLearningMemory(),
    })
    const threadId = 'quiz-rag-no-evidence-thread'

    await graph.invoke({
      threadId,
      learnerId: TEST_LEARNER_ID,
      config: {
        initialDifficulty: QuizDifficulty.Foundation,
        maxRounds: 1,
      },
    }, config(threadId))

    const snapshot = await graph.getState(config(threadId))
    findRoundRequest(snapshot)
    expect(snapshot.values.status).toBe(InterviewQuizStatus.WaitingForAnswers)
    expect(planner.calls[0]?.retrievedChunks).toEqual([])
  })

  test('Graph 不持有也不调用 answer_evidence Retriever', async () => {
    const planner = new FakeQuizPlanner()
    const questionSignalRetriever = new FakeKnowledgeRetriever()
    const questionBank = new InMemoryQuestionBank()
    const graph = createInterviewQuizGraph({
      checkpointer: new MemorySaver(),
      planningSubgraph: createQuizPlanningSubgraph(
        planner,
        questionBank,
        questionSignalRetriever,
      ),
      questionBank,
      learningMemory: new FakeLearningMemory(),
    })
    const threadId = 'quiz-rag-split-retriever-thread'

    await graph.invoke({
      threadId,
      learnerId: TEST_LEARNER_ID,
      config: {
        initialDifficulty: QuizDifficulty.Foundation,
        maxRounds: 1,
      },
    }, config(threadId))

    findRoundRequest(await graph.getState(config(threadId)))
    expect(questionSignalRetriever.calls).toHaveLength(3)
    expect(questionSignalRetriever.calls[0]?.role).toBe('question_signal')
    expect(planner.calls[0]?.retrievedChunks).toHaveLength(1)
  })

  test('RePlan 检索 Query 会携带上一轮错误知识点', async () => {
    const { graph, knowledgeRetriever, planner } = createQuizGraphFixture()
    const threadId = 'quiz-rag-replan-thread'

    await graph.invoke({
      threadId,
      learnerId: TEST_LEARNER_ID,
      config: {
        initialDifficulty: QuizDifficulty.Foundation,
        maxRounds: 2,
      },
    }, config(threadId))
    const firstRequest = findRoundRequest(await graph.getState(config(threadId)))
    await graph.invoke(new Command({
      resume: wrongSubmission(firstRequest),
    }), config(threadId))

    const resultSnapshot = await graph.getState(config(threadId))
    const resultTask = resultSnapshot.tasks.find(task => task.interrupts.length > 0)
    const review = resultTask?.interrupts[0]?.value as { reviewId: string } | undefined
    if (!review)
      throw new Error('Expected round result interrupt.')

    await graph.invoke(new Command({
      resume: { reviewId: review.reviewId, action: 'next_round' },
    }), config(threadId))

    expect(knowledgeRetriever.calls).toHaveLength(6)
    expect(knowledgeRetriever.calls.slice(3).map(call => call.query).join('\n'))
      .toContain('LangGraph')
    expect(planner.calls[3]?.retrievedChunks.map(chunk => chunk.evidenceRole))
      .toEqual([KnowledgeEvidenceRole.QuestionSignal])
  })
})

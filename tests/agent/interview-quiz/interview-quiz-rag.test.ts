import type { StateSnapshot } from '@langchain/langgraph'
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
import { KnowledgeEvidenceRole } from '@/knowledge/contracts'
import {
  createQuizGraphFixture,
  FakeKnowledgeRetriever,
  FakeQuizPlanner,
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
  test('Graph 只预取 question_signal，Planner 返回动态 answer_evidence', async () => {
    const planner = new FakeQuizPlanner()
    const knowledgeRetriever = new FakeKnowledgeRetriever()
    const graph = createInterviewQuizGraph({
      checkpointer: new MemorySaver(),
      planner,
      questionSignalRetriever: knowledgeRetriever,
    })
    const threadId = 'quiz-rag-thread'

    await graph.invoke({
      threadId,
      config: {
        initialDifficulty: QuizDifficulty.Foundation,
        maxRounds: 1,
      },
    }, config(threadId))

    const snapshot = await graph.getState(config(threadId))
    findRoundRequest(snapshot)
    expect(knowledgeRetriever.calls.map(call => call.role)).toEqual([
      'question_signal',
    ])
    expect(planner.calls[0]?.retrievedChunks).toHaveLength(1)
    expect(snapshot.values.retrievedChunks).toHaveLength(2)
  })

  test('没有 question_signal 时仍交给 Planner 决定是否追加检索', async () => {
    const planner = new FakeQuizPlanner()
    const graph = createInterviewQuizGraph({
      checkpointer: new MemorySaver(),
      planner,
      questionSignalRetriever: {
        async search(input) {
          input.signal.throwIfAborted()
          return []
        },
      },
    })
    const threadId = 'quiz-rag-no-evidence-thread'

    await graph.invoke({
      threadId,
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
    const graph = createInterviewQuizGraph({
      checkpointer: new MemorySaver(),
      planner,
      questionSignalRetriever,
    })
    const threadId = 'quiz-rag-split-retriever-thread'

    await graph.invoke({
      threadId,
      config: {
        initialDifficulty: QuizDifficulty.Foundation,
        maxRounds: 1,
      },
    }, config(threadId))

    findRoundRequest(await graph.getState(config(threadId)))
    expect(questionSignalRetriever.calls).toHaveLength(1)
    expect(questionSignalRetriever.calls[0]?.role).toBe('question_signal')
    expect(planner.calls[0]?.retrievedChunks).toHaveLength(1)
  })

  test('RePlan 检索 Query 会携带上一轮错误知识点', async () => {
    const { graph, knowledgeRetriever, planner } = createQuizGraphFixture()
    const threadId = 'quiz-rag-replan-thread'

    await graph.invoke({
      threadId,
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

    expect(knowledgeRetriever.calls).toHaveLength(2)
    expect(knowledgeRetriever.calls[1]?.query).toContain('StateGraph')
    expect(planner.calls[1]?.retrievedChunks.map(chunk => chunk.evidenceRole))
      .toEqual([KnowledgeEvidenceRole.QuestionSignal])
  })
})

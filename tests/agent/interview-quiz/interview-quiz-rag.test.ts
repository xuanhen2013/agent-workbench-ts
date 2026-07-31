import type { StateSnapshot } from '@langchain/langgraph'
import { Command, MemorySaver } from '@langchain/langgraph'
import { describe, expect, test } from 'bun:test'
import {
  InterviewQuizStatus,
  QuizDifficulty,
} from '@/agent/interview-quiz/contracts'
import { InterviewQuizErrorCode } from '@/agent/interview-quiz/errors'
import {
  QuizRoundRequestSchema,
} from '@/agent/interview-quiz/execution'
import { createInterviewQuizGraph } from '@/agent/interview-quiz/interview-quiz-graph'
import {
  KnowledgeEvidenceRole,
  KnowledgeSourceType,
} from '@/knowledge/contracts'
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
  test('retrieve_knowledge 两次过滤，并把 Chunk 快照交给 Planner', async () => {
    const planner = new FakeQuizPlanner()
    const knowledgeRetriever = new FakeKnowledgeRetriever()
    const graph = createInterviewQuizGraph({
      checkpointer: new MemorySaver(),
      planner,
      knowledgeRetriever,
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
      'answer_evidence',
    ])
    expect(planner.calls[0]?.retrievedChunks).toHaveLength(2)
    expect(snapshot.values.retrievedChunks).toHaveLength(2)
  })

  test('没有 answer_evidence 时 Graph 进入稳定失败状态', async () => {
    const planner = new FakeQuizPlanner()
    const graph = createInterviewQuizGraph({
      checkpointer: new MemorySaver(),
      planner,
      knowledgeRetriever: {
        async search(input) {
          input.signal.throwIfAborted()
          return input.filter?.evidenceRoles?.[0]
            === KnowledgeEvidenceRole.AnswerEvidence
            ? []
            : [{
                chunkId: 'signal-1',
                documentId: 'doc-1',
                sourceType: KnowledgeSourceType.UserNote,
                evidenceRole: KnowledgeEvidenceRole.QuestionSignal,
                title: 'Signal',
                sourceUri: 'fixture:signal',
                heading: 'Signal',
                text: 'Only a question signal.',
                ordinal: 0,
                score: 1,
              }]
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
    expect(snapshot.values.status).toBe(InterviewQuizStatus.Failed)
    expect(snapshot.values.error).toEqual({
      code: InterviewQuizErrorCode.InsufficientKnowledge,
      message: '当前轮没有可用于证明答案的知识资料',
    })
  })

  test('RePlan 检索 Query 会携带上一轮错误知识点', async () => {
    const { graph, knowledgeRetriever } = createQuizGraphFixture()
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

    expect(knowledgeRetriever.calls).toHaveLength(4)
    expect(knowledgeRetriever.calls[2]?.query).toContain('StateGraph')
  })
})

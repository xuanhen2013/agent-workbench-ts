import type OpenAI from 'openai'
import type {
  QuizRoundDraft,
  QuizRoundPlan,
} from '@/agent/interview-quiz/contracts'
import type { QuizRoundRequest } from '@/agent/interview-quiz/execution'
import type {
  QuizPlannerInput,
  QuizPlanResult,
} from '@/agent/interview-quiz/planning'
import type { OpenAIResponseInputItem } from '@/clients/openai'
import type { RetrievedChunk } from '@/knowledge/contracts'
import { MemorySaver } from '@langchain/langgraph'
import {
  QuestionType,
  QuizDifficulty,
  QuizStrategy,
} from '@/agent/interview-quiz/contracts'
import { createInterviewQuizGraph } from '@/agent/interview-quiz/interview-quiz-graph'
import { QuizPlanner } from '@/agent/interview-quiz/planning'
import {
  KnowledgeEvidenceRole,
  KnowledgeSourceType,
} from '@/knowledge/contracts'

export function createQuizDraft(
  round = 1,
): QuizRoundDraft {
  return {
    questions: [
      {
        type: QuestionType.Single,
        topic: 'LangGraph',
        knowledgePoint: 'StateGraph',
        stem: `第 ${round} 轮：StateGraph 中 Node 的主要职责是什么？`,
        options: [
          { optionId: 'A', text: '读取 State 并返回局部更新' },
          { optionId: 'B', text: '直接修改浏览器 DOM' },
          { optionId: 'C', text: '替代所有数据库' },
        ],
        correctOptionIds: ['A'],
        explanation: 'Node 读取当前 State，并返回需要合并的局部状态更新。',
        sourceChunkIds: [],
      },
      {
        type: QuestionType.Single,
        topic: 'Tool Calling',
        knowledgePoint: 'tool schema',
        stem: `第 ${round} 轮：Tool Schema 主要约束什么？`,
        options: [
          { optionId: 'A', text: '工具输入结构' },
          { optionId: 'B', text: '网页配色' },
          { optionId: 'C', text: 'CPU 指令集' },
        ],
        correctOptionIds: ['A'],
        explanation: 'Tool Schema 描述工具名称、用途和输入参数结构。',
        sourceChunkIds: [],
      },
      {
        type: QuestionType.Multiple,
        topic: 'Harness',
        knowledgePoint: 'reliability',
        stem: `第 ${round} 轮：Agent Harness 常见的可靠性能力有哪些？`,
        options: [
          { optionId: 'A', text: '超时' },
          { optionId: 'B', text: '重试' },
          { optionId: 'C', text: '随机删除 State' },
        ],
        correctOptionIds: ['A', 'B'],
        explanation: '超时和重试是常见的调用可靠性策略。',
        sourceChunkIds: [],
      },
      {
        type: QuestionType.Single,
        topic: 'Context',
        knowledgePoint: 'history',
        stem: `第 ${round} 轮：追加式 History 对 RePlan 有什么作用？`,
        options: [
          { optionId: 'A', text: '保留之前 Plan 和反馈' },
          { optionId: 'B', text: '强制清空上下文' },
          { optionId: 'C', text: '自动训练模型参数' },
        ],
        correctOptionIds: ['A'],
        explanation: '追加式 History 让下一轮能读取之前的 Plan 和执行反馈。',
        sourceChunkIds: [],
      },
      {
        type: QuestionType.Single,
        topic: 'Memory',
        knowledgePoint: 'checkpointer',
        stem: `第 ${round} 轮：Checkpointer 主要保存哪类数据？`,
        options: [
          { optionId: 'A', text: '当前 Thread 的执行状态' },
          { optionId: 'B', text: '模型训练权重' },
          { optionId: 'C', text: '操作系统内核' },
        ],
        correctOptionIds: ['A'],
        explanation: 'Checkpointer 保存 Graph 当前 Thread 的执行状态和暂停点。',
        sourceChunkIds: [],
      },
    ],
  }
}

export class FakeQuizPlanner extends QuizPlanner {
  readonly calls: QuizPlannerInput[] = []

  constructor() {
    super({} as OpenAI, 'fake-model', { skillCatalog: [] })
  }

  override async createRound(
    input: QuizPlannerInput,
    options: { signal: AbortSignal },
  ): Promise<QuizPlanResult> {
    options.signal.throwIfAborted()
    this.calls.push(structuredClone(input))
    const draft = createQuizDraft(input.round)
    const continuationItems: OpenAIResponseInputItem[] = [{
      role: 'assistant',
      content: JSON.stringify(draft),
    }]

    return {
      ok: true,
      draft,
      continuationItems,
      usage: {
        inputTokens: 1000 + input.round * 100,
        cachedTokens: input.round === 1 ? 0 : 800,
        cacheWriteTokens: input.round === 1 ? 900 : 0,
      },
    }
  }
}

/** Graph 测试只需要一个确定的 Retriever，不需要真的算向量。 */
export class FakeKnowledgeRetriever {
  readonly calls: Array<{
    query: string
    role: string | undefined
  }> = []

  async search(input: {
    query: string
    limit: number
    filter?: { evidenceRoles?: string[] }
    signal: AbortSignal
  }): Promise<RetrievedChunk[]> {
    input.signal.throwIfAborted()
    this.calls.push({
      query: input.query,
      role: input.filter?.evidenceRoles?.[0],
    })

    const role = input.filter?.evidenceRoles?.[0]
      === KnowledgeEvidenceRole.QuestionSignal
      ? KnowledgeEvidenceRole.QuestionSignal
      : KnowledgeEvidenceRole.AnswerEvidence

    return [{
      chunkId: `fake:${role}`,
      documentId: 'fake:document',
      sourceType: KnowledgeSourceType.UserNote,
      evidenceRole: role,
      title: 'Fake knowledge',
      sourceUri: 'fake:knowledge',
      heading: 'Fake',
      text: `Fake ${role} for tests.`,
      ordinal: 0,
      score: 1,
    }].slice(0, input.limit)
  }
}

export function createQuizGraphFixture() {
  const planner = new FakeQuizPlanner()
  const knowledgeRetriever = new FakeKnowledgeRetriever()
  const graph = createInterviewQuizGraph({
    checkpointer: new MemorySaver(),
    planner,
    knowledgeRetriever,
  })
  return { graph, planner, knowledgeRetriever }
}

export function correctSubmission(request: QuizRoundRequest) {
  return {
    reviewId: request.reviewId,
    answers: request.questions.map(question => ({
      questionId: question.questionId,
      selectedOptionIds: question.type === QuestionType.Multiple
        ? ['B', 'A']
        : ['A'],
    })),
  }
}

export function wrongSubmission(request: QuizRoundRequest) {
  return {
    reviewId: request.reviewId,
    answers: request.questions.map(question => ({
      questionId: question.questionId,
      selectedOptionIds: question.type === QuestionType.Multiple
        ? ['C']
        : ['B'],
    })),
  }
}

export function materializeTestPlan(input: {
  threadId?: string
  round?: number
  difficulty?: QuizDifficulty
} = {}): QuizRoundPlan {
  const planner = new FakeQuizPlanner()
  const round = input.round ?? 1
  const plannerInput: QuizPlannerInput = {
    history: [],
    round,
    difficulty: input.difficulty ?? QuizDifficulty.Foundation,
    strategy: QuizStrategy.Initial,
    previousQuestionStems: [],
    retrievedChunks: [],
  }

  return planner.materializeRoundPlan({
    threadId: input.threadId ?? 'test-thread',
    plannerInput,
    draft: createQuizDraft(round),
  })
}

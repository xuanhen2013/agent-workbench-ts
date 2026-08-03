import type {
  QuizRoundDraft,
  QuizRoundPlan,
} from '@/agent/interview-quiz/contracts'
import type { QuizRoundRequest } from '@/agent/interview-quiz/execution'
import type { ImportJdDocument } from '@/agent/interview-quiz/jd/contracts'
import type {
  LearningMemory,
  LearningMemoryContext,
  RoundAttemptInput,
} from '@/agent/interview-quiz/learning-memory/contracts'
import type { QuestionBank } from '@/agent/interview-quiz/question-bank/contracts'
import type {
  PlannerToolSet,
  QuizPlannerInput,
} from '@/agent/interview-quiz/subgraphs/planning/planner'
import type { ModelTurn } from '@/agent/react/model-adapter'
import type {
  OpenAIResponseFunctionTool,
  OpenAIResponseInputItem,
  OpenAIResponsesExecutor,
} from '@/clients/openai'
import type {
  KnowledgeChunk,
  KnowledgeRetriever,
  RetrievedChunk,
} from '@/knowledge/contracts'
import { MemorySaver } from '@langchain/langgraph'
import { ok } from 'neverthrow'
import {
  QuestionType,
  QuizDifficulty,
  QuizStrategy,
} from '@/agent/interview-quiz/contracts'
import { createInterviewQuizGraph } from '@/agent/interview-quiz/interview-quiz-graph'
import { InMemoryQuestionBank } from '@/agent/interview-quiz/question-bank/in-memory-question-bank'
import {
  createPlanningSubgraph as createPlanningSubgraphImpl,
} from '@/agent/interview-quiz/subgraphs/planning/graph'
import { QuizPlanner } from '@/agent/interview-quiz/subgraphs/planning/planner'
import { KnowledgeToolName } from '@/agent/interview-quiz/tools/knowledge'
import {
  KnowledgeEvidenceRole,
  KnowledgeSourceType,
} from '@/knowledge/contracts'

export const TEST_LEARNER_ID = '00000000-0000-4000-8000-000000000001'

/** 与 JD 无关的 HTTP 测试使用；06E 测试会传入真实 InMemory Importer。 */
export const fakeImportJdDocument: ImportJdDocument = async (
  input,
  options,
) => {
  options.signal.throwIfAborted()
  return {
    jdDocumentId: `jd:${input.learnerId}:fake`,
    title: input.title,
    chunkCount: 1,
  }
}

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

function fakeKnowledgeChunk(
  evidenceRole: KnowledgeEvidenceRole,
): RetrievedChunk {
  return {
    chunkId: `fake:${evidenceRole}`,
    documentId: 'fake:document',
    sourceType: KnowledgeSourceType.UserNote,
    evidenceRole,
    ownerId: null,
    title: 'Fake knowledge',
    sourceUri: 'fake:knowledge',
    heading: 'Fake',
    text: `Fake ${evidenceRole} for tests.`,
    ordinal: 0,
    score: 1,
  }
}

const unusedKnowledgeRetriever: Pick<KnowledgeRetriever, 'search'> = {
  async search(input) {
    input.signal.throwIfAborted()
    return []
  },
}

export class FakeQuizPlanner extends QuizPlanner {
  readonly calls: QuizPlannerInput[] = []
  readonly modelCalls: OpenAIResponseInputItem[][] = []
  readonly toolCalls: string[] = []
  private currentInput?: QuizPlannerInput
  private modelTurn = 0

  constructor() {
    super({} as OpenAIResponsesExecutor, {
      skillCatalog: [],
      questionSignalRetriever: unusedKnowledgeRetriever,
      answerEvidenceRetriever: unusedKnowledgeRetriever,
    })
  }

  override createInitialConversation(input: QuizPlannerInput) {
    this.calls.push(structuredClone(input))
    this.currentInput = structuredClone(input)
    this.modelTurn = 0
    return input.history
  }

  override getRequiredSkillNames() {
    // Graph 测试只验证 Loop 和 RAG 数据流；Skill Trace 由真实 Planner 测试覆盖。
    return []
  }

  override createToolSet(): PlannerToolSet {
    const toolCalls = this.toolCalls
    return {
      definitions: [],
      executor: {
        async execute(call, options) {
          options.signal.throwIfAborted()
          toolCalls.push(call.callId)
          return {
            ok: true as const,
            callId: call.callId,
            name: call.name,
            output: {
              chunks: [
                fakeKnowledgeChunk(KnowledgeEvidenceRole.AnswerEvidence),
              ],
            },
          }
        },
      },
    }
  }

  override async runModel(input: {
    history: OpenAIResponseInputItem[]
    tools: OpenAIResponseFunctionTool[]
    signal: AbortSignal
  }): Promise<ModelTurn> {
    input.signal.throwIfAborted()
    this.modelCalls.push([...input.history])
    const plannerInput = this.currentInput
    if (!plannerInput)
      throw new Error('Fake planner was not prepared.')

    if (this.modelTurn++ === 0) {
      return {
        continuationItems: [],
        functionCalls: [{
          callId: 'fake-answer-evidence-call',
          name: KnowledgeToolName.SearchAnswerEvidence,
          arguments: JSON.stringify({ query: 'fake answer evidence' }),
        }],
        usage: {
          inputTokens: 1000,
          cachedTokens: 0,
          cacheWriteTokens: 900,
        },
      }
    }

    const draft = createQuizDraft(plannerInput.round)
    const evidenceChunkId = 'fake:answer_evidence'
    const draftWithEvidence = {
      ...draft,
      questions: draft.questions.map(question => ({
        ...question,
        sourceChunkIds: [evidenceChunkId],
      })),
    }

    return {
      continuationItems: [{
        role: 'assistant',
        content: JSON.stringify(draftWithEvidence),
      }],
      functionCalls: [],
      finalText: JSON.stringify(draftWithEvidence),
      usage: {
        inputTokens: 100,
        cachedTokens: plannerInput.round === 1 ? 0 : 800,
        cacheWriteTokens: 0,
      },
    }
  }

  override validateDraft(draft: QuizRoundDraft) {
    // Parent/Graph 测试使用固定题面，重复题干的领域校验由真实 Planner
    // 单测覆盖；这里仅验证 Loop 的数据流。
    return ok(draft)
  }
}

/** Graph 测试只需要一个确定的 Retriever，不需要真的算向量。 */
export class FakeKnowledgeRetriever {
  readonly calls: Array<{
    query: string
    role: string | undefined
  }> = []

  readonly jdDocuments: KnowledgeChunk[] = []

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

    return [fakeKnowledgeChunk(role)].slice(0, input.limit)
  }

  async loadDocument(input: {
    documentId: string
    ownerId: string
    sourceType: string
    signal: AbortSignal
  }): Promise<KnowledgeChunk[]> {
    input.signal.throwIfAborted()
    return this.jdDocuments
      .filter(chunk => (
        chunk.documentId === input.documentId
        && chunk.ownerId === input.ownerId
        && chunk.sourceType === input.sourceType
      ))
      .map(chunk => ({ ...chunk }))
  }
}

export class FakeLearningMemory implements LearningMemory {
  readonly attempts: RoundAttemptInput[] = []
  loadCalls = 0
  recordCalls = 0

  constructor(
    readonly context: LearningMemoryContext = { weakKnowledgePoints: [] },
  ) {}

  async recordRound(
    input: RoundAttemptInput,
    options: { signal: AbortSignal },
  ) {
    options.signal.throwIfAborted()
    this.recordCalls += 1
    this.attempts.push(structuredClone(input))
    return { inserted: true }
  }

  async listTopicMastery() {
    return []
  }

  async loadContext(
    _learnerId: string,
    options: { signal: AbortSignal },
  ) {
    options.signal.throwIfAborted()
    this.loadCalls += 1
    return structuredClone(this.context)
  }
}

export function createQuizPlanningSubgraph(
  planner: Pick<QuizPlanner, | 'createInitialConversation'
  | 'createToolSet'
  | 'runModel'
  | 'getRequiredSkillNames'
  | 'validateDraft'
  | 'materializeRoundPlan'>,
  questionBank: Pick<QuestionBank, 'findRecentStems'>,
  questionSignalRetriever: Pick<KnowledgeRetriever, 'search'>,
) {
  return createPlanningSubgraphImpl({
    planner,
    questionBank,
    questionSignalRetriever,
  })
}

export function createQuizGraphFixture(options: {
  learningMemory?: LearningMemory
  checkpointer?: MemorySaver
} = {}) {
  const planner = new FakeQuizPlanner()
  const knowledgeRetriever = new FakeKnowledgeRetriever()
  const questionBank = new InMemoryQuestionBank()
  const learningMemory = options.learningMemory ?? new FakeLearningMemory()
  const planningSubgraph = createQuizPlanningSubgraph(
    planner,
    questionBank,
    knowledgeRetriever,
  )
  const graph = createInterviewQuizGraph({
    checkpointer: options.checkpointer ?? new MemorySaver(),
    planningSubgraph,
    jdRetriever: knowledgeRetriever,
    questionBank,
    learningMemory,
  })
  return {
    graph,
    planner,
    knowledgeRetriever,
    questionBank,
    learningMemory,
  }
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
    memoryContext: { weakKnowledgePoints: [] },
    jdContext: null,
  }

  return planner.materializeRoundPlan({
    threadId: input.threadId ?? 'test-thread',
    plannerInput,
    draft: createQuizDraft(round),
  })
}

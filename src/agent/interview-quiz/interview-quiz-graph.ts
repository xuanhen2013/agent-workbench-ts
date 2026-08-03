import type { BaseCheckpointSaver } from '@langchain/langgraph'
import type { Result } from 'neverthrow'
import type {
  QuizCategory,
  QuizModelUsage,
  QuizRoundRecord,
} from './contracts'
import type { InterviewQuizError } from './errors'
import type { InterviewQuizState, InterviewQuizUpdate, QuizRoundContext } from './state'
import type {
  PlanningSubgraph,
} from './subgraphs/planning/graph'
import type {
  PlanningInput,
  PlanningState,
} from './subgraphs/planning/state'
import type { MarketJdCatalog } from '@/agent/interview-quiz/jd/contracts'
import type {
  LearningMemory,
  RoundAttemptInput,
} from '@/agent/interview-quiz/learning-memory/contracts'
import type { QuestionBank } from '@/agent/interview-quiz/question-bank/contracts'
import type { OpenAIResponseInputItem } from '@/clients/openai'
import type { KnowledgeRetriever } from '@/knowledge/contracts'
import {
  END,
  interrupt,
  START,
  StateGraph,
} from '@langchain/langgraph'
import { err, ok } from 'neverthrow'
import { SelectedJdSource } from '@/agent/interview-quiz/jd/contracts'
import { extractJdFocus } from '@/agent/interview-quiz/jd/extract-jd-focus'
import { KnowledgeSourceType } from '@/knowledge/contracts'
import { selectQuizCategories } from './categories'
import {
  InterviewQuizStatus,
  QuizCompletionReason,
  QuizDifficulty,
  QuizStrategy,
} from './contracts'
import {
  createInterviewQuizError,
  InterviewQuizErrorCode,
} from './errors'
import {
  gradeQuizRound,
  projectRoundRequest,
  projectRoundResultRequest,
  QuizNextRoundDecisionSchema,
  validateSubmission,
} from './execution'
import {

  InterviewQuizStateSchema,

} from './state'

export interface CreateInterviewQuizGraphOptions {
  checkpointer: BaseCheckpointSaver
  /** 一轮规划的完整子图；Parent 不知道内部三个 Node。 */
  planningSubgraph: Pick<PlanningSubgraph, 'invoke'>
  /** 用户 JD 只从 owner-scoped 本地 Store 精确读取。 */
  jdRetriever?: Pick<KnowledgeRetriever, 'loadDocument'>
  /** 公共市场 JD 通过共享 Catalog 读取，不使用 learner owner。 */
  marketJdCatalog?: Pick<MarketJdCatalog, 'load'>
  /** Graph 确定性读写正式题库，不把它暴露为模型 Tool。 */
  questionBank: QuestionBank
  /** 跨 Session 作答事实；Graph 不知道 SQLite 或 D1 的实现细节。 */
  learningMemory: Pick<LearningMemory, 'loadContext' | 'recordRound'>
}

function raiseDifficulty(difficulty: QuizDifficulty) {
  if (difficulty === QuizDifficulty.Foundation)
    return QuizDifficulty.Intermediate
  if (difficulty === QuizDifficulty.Intermediate)
    return QuizDifficulty.Advanced
  return QuizDifficulty.Advanced
}

function buildRoundMessage(input: {
  round: number
  difficulty: QuizDifficulty
  strategy: QuizStrategy
  correctCount?: number
  total?: number
  wrongKnowledgePoints?: string[]
}): OpenAIResponseInputItem {
  const feedback = input.correctCount === undefined
    ? '这是第一轮，没有历史答题结果。'
    : [
        `上一轮得分：${input.correctCount}/${input.total ?? 0}。`,
        input.wrongKnowledgePoints?.length
          ? `错误知识点：${input.wrongKnowledgePoints.join('、')}。`
          : '上一轮全部答对。',
      ].join('\n')

  return {
    role: 'user',
    content: [
      `请生成第 ${input.round} 轮 Agent 工程面试选择题。`,
      `本轮难度：${input.difficulty}。`,
      `本轮策略：${input.strategy}。`,
      feedback,
    ].join('\n'),
  }
}

/**
 * Parent State → Planning Subgraph State 的显式投影。
 *
 * Mapper 不访问依赖、不做副作用，也不把完整 Parent State 传给子图。
 */
export function toPlanningInput(
  state: InterviewQuizState,
  roundContext: QuizRoundContext,
  category: QuizCategory,
): PlanningInput {
  const completedQuestionStems = state.rounds.flatMap(record => (
    record.plan.sections.flatMap(section => (
      section.questions.map(question => question.stem)
    ))
  )).concat(state.plannedSections.flatMap(section => (
    section.questions.map(question => question.stem)
  )))
  const previousSectionResult = state.rounds.at(-1)?.result.sectionResults.find(result => result.categoryId === category.categoryId)

  return {
    threadId: state.threadId,
    roundContext: { ...roundContext },
    category: structuredClone(category),
    modelHistory: [...state.modelHistory],
    completedQuestionStems,
    previousWrongKnowledgePoints: [
      ...(previousSectionResult?.wrongKnowledgePoints ?? []),
    ],
    memoryContext: {
      weakKnowledgePoints: [
        ...state.memoryContext.weakKnowledgePoints,
      ],
    },
    jdContext: state.jdContext
      ? {
          ...state.jdContext,
          focusKnowledgePoints: [
            ...state.jdContext.focusKnowledgePoints,
          ],
        }
      : null,
  }
}

/**
 * Planning Subgraph State → Parent State Update 的显式投影。
 *
 * Parent 的 modelHistory 有 Reducer，因此这里只回写 continuationItems，
 * 不能把子图收到的完整 modelHistory 再追加一遍。
 */
export function toParentPlanningUpdate(
  output: PlanningState,
  currentModelUsage: QuizModelUsage | null,
): InterviewQuizUpdate {
  if (output.error) {
    return {
      status: InterviewQuizStatus.Failed,
      error: output.error,
    }
  }

  if (!output.currentSection) {
    return {
      status: InterviewQuizStatus.Failed,
      error: createInterviewQuizError(
        InterviewQuizErrorCode.RoundPlanMissing,
      ),
    }
  }

  return {
    currentSection: output.currentSection,
    modelHistory: output.continuationItems,
    currentModelUsage: addModelUsage(currentModelUsage, output.modelUsage),
    retrievedChunks: output.retrievedChunks,
    submission: null,
    status: InterviewQuizStatus.Planning,
  }
}

function addModelUsage(
  current: QuizModelUsage | null,
  incoming: QuizModelUsage | null,
): QuizModelUsage | null {
  if (!current)
    return incoming
  if (!incoming)
    return current

  return {
    inputTokens: current.inputTokens + incoming.inputTokens,
    cachedTokens: current.cachedTokens + incoming.cachedTokens,
    cacheWriteTokens: current.cacheWriteTokens + incoming.cacheWriteTokens,
  }
}

/**
 * Graph State → SQL 契约的显式投影。
 * LearningMemory 不接收完整 Plan、History、RAG Chunk 或模型 usage。
 */
export function toRoundAttemptInput(input: {
  learnerId: string
  threadId: string
  record: QuizRoundRecord
  completedAt: string
}): Result<RoundAttemptInput, InterviewQuizError> {
  const { learnerId, threadId, record, completedAt } = input
  const questionResults = record.result.sectionResults.flatMap(
    section => section.questionResults,
  )
  const resultByQuestionId = new Map(
    questionResults.map(result => [result.questionId, result]),
  )
  const plannedQuestions = record.plan.sections.flatMap(
    section => section.questions,
  )
  if (
    resultByQuestionId.size !== questionResults.length
    || plannedQuestions.length !== questionResults.length
  ) {
    return err(createInterviewQuizError(
      InterviewQuizErrorCode.MemoryAttemptInvalid,
    ))
  }

  const questions: RoundAttemptInput['questions'] = []
  for (const question of plannedQuestions) {
    const result = resultByQuestionId.get(question.questionId)
    if (!result || !question.bankQuestionId) {
      return err(createInterviewQuizError(
        InterviewQuizErrorCode.MemoryAttemptInvalid,
      ))
    }

    questions.push({
      questionId: question.questionId,
      bankQuestionId: question.bankQuestionId,
      knowledgePoint: question.knowledgePoint,
      selectedOptionIds: [...result.selectedOptionIds],
      isCorrect: result.isCorrect,
    })
  }

  return ok({
    learnerId,
    threadId,
    round: record.plan.round,
    difficulty: record.plan.difficulty,
    correctCount: record.result.correctCount,
    total: questions.length,
    completedAt,
    questions,
  })
}

/**
 * 最小多轮 Quiz Graph：复用 04 的 History、Interrupt 和 Checkpointer，
 * 只新增 Structured Plan、确定性判分与 RePlan 反馈。
 */
export function createInterviewQuizGraph(
  options: CreateInterviewQuizGraphOptions,
) {
  return new StateGraph(InterviewQuizStateSchema)
    .addNode('initialize', (state) => {
      const roundContext = {
        round: 1,
        difficulty: state.config.initialDifficulty,
        strategy: QuizStrategy.Initial,
      }

      return {
        roundContext,
        modelHistory: [buildRoundMessage(roundContext)],
        categories: [],
        activeCategories: [],
        categoryCursor: 0,
        currentSection: null,
        plannedSections: [],
        currentPlan: null,
        submission: null,
        currentModelUsage: null,
        retrievedChunks: [],
        status: InterviewQuizStatus.Planning,
      }
    })
    .addNode('load_memory', async (state, { signal }) => {
      try {
        return {
          memoryContext: await options.learningMemory.loadContext(
            state.learnerId,
            { signal },
          ),
          status: InterviewQuizStatus.Planning,
        }
      }
      catch {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.LearningMemoryLoadFailed,
          ),
        }
      }
    })
    .addNode('load_jd_context', async (state, { signal }) => {
      const selectedJd = state.config.selectedJd
      if (!selectedJd)
        return { jdContext: null, status: InterviewQuizStatus.Planning }

      try {
        if (selectedJd.source === SelectedJdSource.Market) {
          if (!options.marketJdCatalog) {
            return {
              status: InterviewQuizStatus.Failed,
              error: createInterviewQuizError(
                InterviewQuizErrorCode.JdContextLoadFailed,
              ),
            }
          }

          const jdContext = await options.marketJdCatalog.load({
            itemKey: selectedJd.itemKey,
            signal,
          })
          if (!jdContext) {
            return {
              status: InterviewQuizStatus.Failed,
              error: createInterviewQuizError(
                InterviewQuizErrorCode.JdNotFound,
              ),
            }
          }

          return {
            jdContext,
            status: InterviewQuizStatus.Planning,
          }
        }

        if (!options.jdRetriever) {
          return {
            status: InterviewQuizStatus.Failed,
            error: createInterviewQuizError(
              InterviewQuizErrorCode.JdContextLoadFailed,
            ),
          }
        }

        const chunks = await options.jdRetriever.loadDocument({
          documentId: selectedJd.documentId,
          ownerId: state.learnerId,
          sourceType: KnowledgeSourceType.Jd,
          signal,
        })
        if (chunks.length === 0) {
          return {
            status: InterviewQuizStatus.Failed,
            error: createInterviewQuizError(
              InterviewQuizErrorCode.JdNotFound,
            ),
          }
        }

        return {
          jdContext: {
            reference: selectedJd,
            title: chunks[0]?.title ?? 'Selected JD',
            focusKnowledgePoints: extractJdFocus(
              chunks.map(chunk => chunk.text).join('\n'),
            ),
          },
          status: InterviewQuizStatus.Planning,
        }
      }
      catch {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.JdContextLoadFailed,
          ),
        }
      }
    })
    .addNode('select_categories', (state) => {
      const categories = selectQuizCategories(state.jdContext)
      return {
        categories,
        activeCategories: categories,
        categoryCursor: 0,
        currentSection: null,
        plannedSections: [],
        currentPlan: null,
        currentModelUsage: null,
        status: InterviewQuizStatus.Planning,
      }
    })
    .addNode('planning', async (state, { signal }) => {
      if (!state.roundContext) {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.RoundContextMissing,
          ),
        }
      }

      const category = state.activeCategories[state.categoryCursor]
      if (!category) {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.RoundContextMissing,
          ),
        }
      }

      try {
        const output = await options.planningSubgraph.invoke(
          toPlanningInput(state, state.roundContext, category),
          {
            signal,
            // Planner Loop 每个 Tool round 有多个显式 Node，不能使用
            // LangGraph 默认的 25-step 上限。
            recursionLimit: 100,
          },
        )

        return toParentPlanningUpdate(output, state.currentModelUsage)
      }
      catch {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.PlannerCallFailed,
          ),
        }
      }
    })
    .addNode('collect_section', (state) => {
      if (!state.currentSection) {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.RoundPlanMissing,
          ),
        }
      }

      return {
        plannedSections: [...state.plannedSections, state.currentSection],
        categoryCursor: state.categoryCursor + 1,
        currentSection: null,
        status: InterviewQuizStatus.Planning,
      }
    })
    .addNode('persist_questions', async (state, { signal }) => {
      if (!state.roundContext || state.plannedSections.length === 0) {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.RoundPlanMissing,
          ),
        }
      }

      try {
        const currentPlan = {
          reviewId: `${state.threadId}:round:${state.roundContext.round}:review`,
          ...state.roundContext,
          sections: state.plannedSections,
        }
        return {
          currentPlan: await options.questionBank.savePlan(
            currentPlan,
            { signal },
          ),
          status: InterviewQuizStatus.WaitingForAnswers,
        }
      }
      catch {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.QuestionBankSaveFailed,
          ),
        }
      }
    })
    .addNode('answer_questions', (state) => {
      if (!state.currentPlan) {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.RoundPlanMissing,
          ),
        }
      }

      const request = projectRoundRequest(state.currentPlan)
      const candidate = interrupt<typeof request, unknown>(request)
      const submission = validateSubmission(candidate, state.currentPlan)

      if (submission.isErr()) {
        return {
          status: InterviewQuizStatus.Failed,
          error: submission.error,
        }
      }

      return {
        submission: submission.value,
        status: InterviewQuizStatus.Grading,
      }
    })
    .addNode('verify', (state) => {
      if (!state.currentPlan || !state.submission) {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.GradingInputMissing,
          ),
        }
      }

      const result = gradeQuizRound({
        plan: state.currentPlan,
        submission: state.submission,
      })

      return {
        rounds: [{
          plan: state.currentPlan,
          result,
          ...(state.currentModelUsage
            ? { modelUsage: state.currentModelUsage }
            : {}),
        }],
        status: InterviewQuizStatus.WaitingForNextRound,
      }
    })
    .addNode('persist_memory', async (state, { signal }) => {
      const record = state.rounds.at(-1)
      if (!record) {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.RoundResultMissing,
          ),
        }
      }

      const attempt = toRoundAttemptInput({
        learnerId: state.learnerId,
        threadId: state.threadId,
        record,
        completedAt: new Date().toISOString(),
      })
      if (attempt.isErr()) {
        return {
          status: InterviewQuizStatus.Failed,
          error: attempt.error,
        }
      }

      try {
        await options.learningMemory.recordRound(attempt.value, { signal })
        return { status: InterviewQuizStatus.WaitingForNextRound }
      }
      catch {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.LearningMemorySaveFailed,
          ),
        }
      }
    })
    .addNode('wait_next_round', (state) => {
      const lastRound = state.rounds.at(-1)
      if (!lastRound) {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.RoundResultMissing,
          ),
        }
      }

      const request = projectRoundResultRequest({
        threadId: state.threadId,
        record: lastRound,
      })
      const candidate = interrupt<typeof request, unknown>(request)
      const decision = QuizNextRoundDecisionSchema.safeParse(candidate)

      if (!decision.success || decision.data.reviewId !== request.reviewId) {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.InvalidNextRoundDecision,
          ),
        }
      }

      return { status: InterviewQuizStatus.Planning }
    })
    .addNode('replan', (state) => {
      const lastRound = state.rounds.at(-1)
      if (!lastRound) {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.ReplanResultMissing,
          ),
        }
      }

      const roundContext = {
        round: state.rounds.length + 1,
        difficulty: lastRound.result.allCorrect
          ? raiseDifficulty(lastRound.plan.difficulty)
          : lastRound.plan.difficulty,
        strategy: lastRound.result.allCorrect
          ? QuizStrategy.Advance
          : QuizStrategy.Remediate,
      }
      const wrongCategoryIds = new Set(
        lastRound.result.sectionResults
          .filter(section => !section.allCorrect)
          .map(section => section.categoryId),
      )
      const activeCategories = lastRound.result.allCorrect
        ? state.categories
        : state.categories.filter(category => (
            wrongCategoryIds.has(category.categoryId)
          ))

      return {
        roundContext,
        modelHistory: [buildRoundMessage({
          ...roundContext,
          correctCount: lastRound.result.correctCount,
          total: lastRound.plan.sections.reduce(
            (total, section) => total + section.questions.length,
            0,
          ),
          wrongKnowledgePoints: lastRound.result.wrongKnowledgePoints,
        })],
        activeCategories,
        categoryCursor: 0,
        currentSection: null,
        plannedSections: [],
        currentPlan: null,
        submission: null,
        currentModelUsage: null,
        retrievedChunks: [],
        status: InterviewQuizStatus.Planning,
      }
    })
    .addNode('finish', () => ({
      status: InterviewQuizStatus.Completed,
      completionReason: QuizCompletionReason.MaxRounds,
    }))
    .addEdge(START, 'initialize')
    .addEdge('initialize', 'load_memory')
    .addConditionalEdges('load_memory', state => (
      state.status === InterviewQuizStatus.Failed
        ? END
        : 'load_jd_context'
    ))
    .addConditionalEdges('load_jd_context', state => (
      state.status === InterviewQuizStatus.Failed
        ? END
        : 'select_categories'
    ))
    .addEdge('select_categories', 'planning')
    .addConditionalEdges('planning', state => (
      state.status === InterviewQuizStatus.Failed
        ? END
        : 'collect_section'
    ))
    .addConditionalEdges('collect_section', state => (
      state.status === InterviewQuizStatus.Failed
        ? END
        : state.categoryCursor < state.activeCategories.length
          ? 'planning'
          : 'persist_questions'
    ))
    .addConditionalEdges('persist_questions', state => (
      state.status === InterviewQuizStatus.Failed
        ? END
        : 'answer_questions'
    ))
    .addConditionalEdges('answer_questions', state => (
      state.status === InterviewQuizStatus.Failed
        ? END
        : 'verify'
    ))
    .addConditionalEdges('verify', state => (
      state.status === InterviewQuizStatus.Failed ? END : 'persist_memory'
    ))
    .addConditionalEdges('persist_memory', (state) => {
      if (state.status === InterviewQuizStatus.Failed)
        return END
      return state.rounds.length >= state.config.maxRounds
        ? 'finish'
        : 'wait_next_round'
    })
    .addConditionalEdges('wait_next_round', state => (
      state.status === InterviewQuizStatus.Failed ? END : 'replan'
    ))
    .addEdge('replan', 'planning')
    .addEdge('finish', END)
    .compile({ checkpointer: options.checkpointer })
}

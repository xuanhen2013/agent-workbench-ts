import type { BaseCheckpointSaver } from '@langchain/langgraph'
import type { Result } from 'neverthrow'
import type { QuizRoundRecord } from './contracts'
import type { InterviewQuizError } from './errors'
import type { QuizPlanner } from './planning'
import type { OpenAIResponseInputItem } from '@/clients/openai'
import type { KnowledgeRetriever } from '@/knowledge/contracts'
import type {
  LearningMemory,
  LearningMemoryContext,
  RoundAttemptInput,
} from '@/learning-memory/contracts'
import type { QuestionBank } from '@/question-bank/contracts'
import {
  END,
  interrupt,
  START,
  StateGraph,
} from '@langchain/langgraph'
import { err, ok } from 'neverthrow'
import { KnowledgeEvidenceRole } from '@/knowledge/contracts'
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
import { MAX_FORBIDDEN_QUESTION_STEMS } from './planning'
import { InterviewQuizStateSchema } from './state'

export interface CreateInterviewQuizGraphOptions {
  checkpointer: BaseCheckpointSaver
  planner: Pick<QuizPlanner, 'createRound' | 'materializeRoundPlan'>
  /** Graph 首次固定预取 question_signal；追加检索由 Planner Tool 负责。 */
  questionSignalRetriever: Pick<KnowledgeRetriever, 'search'>
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
  wrongKnowledgePoints?: string[]
}): OpenAIResponseInputItem {
  const feedback = input.correctCount === undefined
    ? '这是第一轮，没有历史答题结果。'
    : [
        `上一轮得分：${input.correctCount}/5。`,
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
 * Query 先由确定性状态拼出来，不额外调用一个 Query Planner 模型。
 * 这样用户答错的知识点能稳定进入下一轮检索。
 */
function buildKnowledgeQuery(state: {
  roundContext: {
    difficulty: QuizDifficulty
    strategy: QuizStrategy
  } | null
  rounds: Array<{ result: { wrongKnowledgePoints: string[] } }>
  memoryContext: LearningMemoryContext
}) {
  const focusKnowledgePoints = state.roundContext?.strategy
    === QuizStrategy.Remediate
    ? state.rounds.at(-1)?.result.wrongKnowledgePoints ?? []
    : state.memoryContext.weakKnowledgePoints
  const focus = focusKnowledgePoints.length > 0
    ? focusKnowledgePoints.join(' ')
    : 'Agent 工程 Tool Calling LangGraph Context Memory'
  const difficulty = state.roundContext?.difficulty ?? QuizDifficulty.Foundation

  return `${difficulty} ${focus} 核心概念 常见误区`
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
  const resultByQuestionId = new Map(
    record.result.questionResults.map(result => [result.questionId, result]),
  )
  if (
    resultByQuestionId.size !== record.result.questionResults.length
    || record.plan.questions.length !== record.result.questionResults.length
  ) {
    return err(createInterviewQuizError(
      InterviewQuizErrorCode.MemoryAttemptInvalid,
    ))
  }

  const questions: RoundAttemptInput['questions'] = []
  for (const question of record.plan.questions) {
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
        retrievedChunks: [],
        questionBankStems: [],
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
    .addNode('load_question_history', async (state, { signal }) => {
      if (!state.roundContext) {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.RoundContextMissing,
          ),
        }
      }

      const focusKnowledgePoints = state.roundContext.strategy
        === QuizStrategy.Remediate
        ? state.rounds.at(-1)?.result.wrongKnowledgePoints ?? []
        : state.memoryContext.weakKnowledgePoints

      try {
        return {
          questionBankStems: await options.questionBank.findRecentStems({
            difficulty: state.roundContext.difficulty,
            knowledgePoints: focusKnowledgePoints,
            limit: 30,
            signal,
          }),
          status: InterviewQuizStatus.Planning,
        }
      }
      catch {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.QuestionBankReadFailed,
          ),
        }
      }
    })
    .addNode('retrieve_question_signals', async (state, { signal }) => {
      if (!state.roundContext) {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.RoundContextMissing,
          ),
        }
      }

      try {
        const query = buildKnowledgeQuery(state)
        const questionSignals = await options.questionSignalRetriever.search({
          query,
          limit: 4,
          filter: {
            evidenceRoles: [KnowledgeEvidenceRole.QuestionSignal],
          },
          signal,
        })

        return {
          retrievedChunks: questionSignals,
          status: InterviewQuizStatus.Planning,
        }
      }
      catch {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.KnowledgeRetrievalFailed,
          ),
        }
      }
    })
    .addNode('plan_execute', async (state, { signal }) => {
      if (!state.roundContext) {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.RoundContextMissing,
          ),
        }
      }

      const currentThreadStems = state.rounds.flatMap(record => (
        record.plan.questions.map(question => question.stem)
      ))
      const plannerInput = {
        history: state.modelHistory,
        ...state.roundContext,
        previousQuestionStems: [...new Set([
          ...currentThreadStems,
          ...state.questionBankStems,
        ])].slice(0, MAX_FORBIDDEN_QUESTION_STEMS),
        retrievedChunks: state.retrievedChunks,
        memoryContext: state.memoryContext,
      }

      try {
        const result = await options.planner.createRound(
          plannerInput,
          { signal },
        )

        if (!result.ok) {
          return {
            status: InterviewQuizStatus.Failed,
            error: result.error,
          }
        }

        return {
          modelHistory: result.continuationItems,
          retrievedChunks: result.retrievedChunks,
          currentPlan: options.planner.materializeRoundPlan({
            threadId: state.threadId,
            plannerInput: {
              ...plannerInput,
              retrievedChunks: result.retrievedChunks,
            },
            draft: result.draft,
          }),
          submission: null,
          currentModelUsage: result.usage ?? null,
          status: InterviewQuizStatus.Planning,
        }
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
    .addNode('persist_questions', async (state, { signal }) => {
      if (!state.currentPlan) {
        return {
          status: InterviewQuizStatus.Failed,
          error: createInterviewQuizError(
            InterviewQuizErrorCode.RoundPlanMissing,
          ),
        }
      }

      try {
        return {
          currentPlan: await options.questionBank.savePlan(
            state.currentPlan,
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

      return {
        roundContext,
        modelHistory: [buildRoundMessage({
          ...roundContext,
          correctCount: lastRound.result.correctCount,
          wrongKnowledgePoints: lastRound.result.wrongKnowledgePoints,
        })],
        currentPlan: null,
        submission: null,
        currentModelUsage: null,
        retrievedChunks: [],
        questionBankStems: [],
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
        : 'load_question_history'
    ))
    .addConditionalEdges('load_question_history', state => (
      state.status === InterviewQuizStatus.Failed
        ? END
        : 'retrieve_question_signals'
    ))
    .addConditionalEdges('retrieve_question_signals', state => (
      state.status === InterviewQuizStatus.Failed ? END : 'plan_execute'
    ))
    .addConditionalEdges('plan_execute', state => (
      state.status === InterviewQuizStatus.Failed
        ? END
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
    .addEdge('replan', 'load_question_history')
    .addEdge('finish', END)
    .compile({ checkpointer: options.checkpointer })
}

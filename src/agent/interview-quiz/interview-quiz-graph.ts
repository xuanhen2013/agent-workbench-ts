import type { BaseCheckpointSaver } from '@langchain/langgraph'
import type { QuizPlanner } from './planning'
import type { OpenAIResponseInputItem } from '@/clients/openai'
import type { KnowledgeRetriever } from '@/knowledge/contracts'
import {
  END,
  interrupt,
  START,
  StateGraph,
} from '@langchain/langgraph'
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
import { InterviewQuizStateSchema } from './state'

export interface CreateInterviewQuizGraphOptions {
  checkpointer: BaseCheckpointSaver
  planner: Pick<QuizPlanner, 'createRound' | 'materializeRoundPlan'>
  /** 本地题库等 question_signal 的默认检索入口。 */
  knowledgeRetriever: Pick<KnowledgeRetriever, 'search'>
  /**
   * 可选的远程答案证据入口。未提供时仍复用 knowledgeRetriever，
   * 因此现有 Fake/InMemory 测试和离线模式不需要两套依赖。
   */
  answerEvidenceRetriever?: Pick<KnowledgeRetriever, 'search'>
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
}) {
  const wrongKnowledgePoints = state.roundContext?.strategy
    === QuizStrategy.Remediate
    ? state.rounds.at(-1)?.result.wrongKnowledgePoints ?? []
    : []
  const focus = wrongKnowledgePoints.length > 0
    ? wrongKnowledgePoints.join(' ')
    : 'Agent 工程 Tool Calling LangGraph Context Memory'
  const difficulty = state.roundContext?.difficulty ?? QuizDifficulty.Foundation

  return `${difficulty} ${focus} 核心概念 常见误区`
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
        status: InterviewQuizStatus.Planning,
      }
    })
    .addNode('retrieve_knowledge', async (state, { signal }) => {
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
        const [questionSignals, answerEvidence] = await Promise.all([
          options.knowledgeRetriever.search({
            query,
            limit: 4,
            filter: {
              evidenceRoles: [KnowledgeEvidenceRole.QuestionSignal],
            },
            signal,
          }),
          (options.answerEvidenceRetriever ?? options.knowledgeRetriever).search({
            query,
            limit: 8,
            filter: {
              evidenceRoles: [KnowledgeEvidenceRole.AnswerEvidence],
            },
            signal,
          }),
        ])

        if (answerEvidence.length === 0) {
          return {
            status: InterviewQuizStatus.Failed,
            error: createInterviewQuizError(
              InterviewQuizErrorCode.InsufficientKnowledge,
            ),
          }
        }

        return {
          retrievedChunks: [...questionSignals, ...answerEvidence],
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

      const plannerInput = {
        history: state.modelHistory,
        ...state.roundContext,
        previousQuestionStems: state.rounds.flatMap(record => (
          record.plan.questions.map(question => question.stem)
        )),
        retrievedChunks: state.retrievedChunks,
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
          currentPlan: options.planner.materializeRoundPlan({
            threadId: state.threadId,
            plannerInput,
            draft: result.draft,
          }),
          submission: null,
          currentModelUsage: result.usage ?? null,
          status: InterviewQuizStatus.WaitingForAnswers,
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
        status: InterviewQuizStatus.Planning,
      }
    })
    .addNode('finish', () => ({
      status: InterviewQuizStatus.Completed,
      completionReason: QuizCompletionReason.MaxRounds,
    }))
    .addEdge(START, 'initialize')
    .addEdge('initialize', 'retrieve_knowledge')
    .addConditionalEdges('retrieve_knowledge', state => (
      state.status === InterviewQuizStatus.Failed ? END : 'plan_execute'
    ))
    .addConditionalEdges('plan_execute', state => (
      state.status === InterviewQuizStatus.Failed
        ? END
        : 'answer_questions'
    ))
    .addConditionalEdges('answer_questions', state => (
      state.status === InterviewQuizStatus.Failed
        ? END
        : 'verify'
    ))
    .addConditionalEdges('verify', (state) => {
      if (state.status === InterviewQuizStatus.Failed)
        return END

      return state.rounds.length >= state.config.maxRounds
        ? 'finish'
        : 'wait_next_round'
    })
    .addConditionalEdges('wait_next_round', state => (
      state.status === InterviewQuizStatus.Failed ? END : 'replan'
    ))
    .addEdge('replan', 'retrieve_knowledge')
    .addEdge('finish', END)
    .compile({ checkpointer: options.checkpointer })
}

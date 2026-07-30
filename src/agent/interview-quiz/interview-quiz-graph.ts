import type { BaseCheckpointSaver } from '@langchain/langgraph'
import type { QuizPlanner } from './planning'
import type { OpenAIResponseInputItem } from '@/clients/openai'
import {
  END,
  interrupt,
  START,
  StateGraph,
} from '@langchain/langgraph'
import {
  InterviewQuizStatus,
  QuizCompletionReason,
  QuizDifficulty,
  QuizStrategy,
} from './contracts'
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
        status: InterviewQuizStatus.Planning,
      }
    })
    .addNode('plan_execute', async (state, { signal }) => {
      if (!state.roundContext) {
        return {
          status: InterviewQuizStatus.Failed,
          error: {
            code: 'round_context_missing',
            message: '当前轮次的规划参数不存在',
          },
        }
      }

      const plannerInput = {
        history: state.modelHistory,
        ...state.roundContext,
        previousQuestionStems: state.rounds.flatMap(record => (
          record.plan.questions.map(question => question.stem)
        )),
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
          error: {
            code: 'planner_call_failed',
            message: '生成 Agent 面试题失败',
          },
        }
      }
    })
    .addNode('answer_questions', (state) => {
      if (!state.currentPlan) {
        return {
          status: InterviewQuizStatus.Failed,
          error: {
            code: 'round_plan_missing',
            message: '当前题卷不存在',
          },
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
          error: {
            code: 'grading_input_missing',
            message: '判分所需的题卷或答案不存在',
          },
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
          error: {
            code: 'round_result_missing',
            message: '当前轮次结果不存在',
          },
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
          error: {
            code: 'invalid_next_round_decision',
            message: '下一轮操作与当前结果不匹配',
          },
        }
      }

      return { status: InterviewQuizStatus.Planning }
    })
    .addNode('replan', (state) => {
      const lastRound = state.rounds.at(-1)
      if (!lastRound) {
        return {
          status: InterviewQuizStatus.Failed,
          error: {
            code: 'replan_result_missing',
            message: 'RePlan 缺少上一轮结果',
          },
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
        status: InterviewQuizStatus.Planning,
      }
    })
    .addNode('finish', () => ({
      status: InterviewQuizStatus.Completed,
      completionReason: QuizCompletionReason.MaxRounds,
    }))
    .addEdge(START, 'initialize')
    .addEdge('initialize', 'plan_execute')
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
    .addEdge('replan', 'plan_execute')
    .addEdge('finish', END)
    .compile({ checkpointer: options.checkpointer })
}

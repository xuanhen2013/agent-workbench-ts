import type {
  QuizDifficulty,
  QuizModelUsage,
  QuizRoundPlan,
  QuizRoundRecord,
  QuizStrategy,
} from './contracts'
import type { OpenAIResponseInputItem } from '@/clients/openai'
import type { RetrievedChunk } from '@/knowledge/contracts'
import { ReducedValue, StateSchema } from '@langchain/langgraph'
import { z } from 'zod/v4'
import { removeKnownGatewayMetadata } from '@/clients/openai'
import {
  InterviewQuizStatus,
  QuizCompletionReason,
  QuizConfigSchema,
  QuizRoundSubmissionSchema,
} from './contracts'
import { InterviewQuizErrorCode } from './errors'

/** initialize 或 replan 已经确定好的当前轮规划参数。 */
export interface QuizRoundContext {
  round: number
  difficulty: QuizDifficulty
  strategy: QuizStrategy
}

export const InterviewQuizStateSchema = new StateSchema({
  /** 业务 Thread ID；同时用于生成稳定的 plan/review/question ID。 */
  threadId: z.string().min(1),

  /** Web 创建 Thread 时提交，题目范围固定为 Agent 工程。 */
  config: QuizConfigSchema,

  /**
   * 模型对话上下文。每个 Node 只返回新增项，Reducer 负责追加；
   * 与 04 Joke Demo 使用同一种 History 机制。
   */
  modelHistory: new ReducedValue(
    z.array(z.custom<OpenAIResponseInputItem>()).default(() => []),
    {
      reducer(
        left: OpenAIResponseInputItem[],
        right: OpenAIResponseInputItem[],
      ) {
        return left.concat(removeKnownGatewayMetadata(right))
      },
    },
  ),

  /** plan_execute 只消费该字段，不在模型调用阶段重新决定难度和策略。 */
  roundContext: z.custom<QuizRoundContext>().nullable().default(null),

  /** 当前正在展示和判分的私有题卷。 */
  currentPlan: z.custom<QuizRoundPlan>().nullable().default(null),

  /** Answer Interrupt Resume 后写入，verify 消费。 */
  submission: QuizRoundSubmissionSchema.nullable().default(null),

  /** 当前 Planner 调用的 usage，在 verify 时并入完成轮次。 */
  currentModelUsage: z.custom<QuizModelUsage>().nullable().default(null),

  /** 当前轮检索结果快照；固定预取和 Planner Tool 都只服务当前轮。 */
  retrievedChunks: z.custom<RetrievedChunk[]>().default(() => []),

  /** QuestionBank 为当前轮返回的有限历史题干；不包含答案和完整题库。 */
  questionBankStems: z.array(z.string()).default(() => []),

  /** 已完成轮次。verify 每次只返回一个新元素，由 Reducer 追加。 */
  rounds: new ReducedValue(
    z.array(z.custom<QuizRoundRecord>()).default(() => []),
    {
      reducer(left: QuizRoundRecord[], right: QuizRoundRecord[]) {
        return left.concat(right)
      },
    },
  ),

  status: z.enum(InterviewQuizStatus)
    .default(InterviewQuizStatus.Planning),

  completionReason: z.enum(QuizCompletionReason).optional(),

  /** 只保存可公开稳定错误，不保存 SDK 原始异常和 stack。 */
  error: z.object({
    code: z.enum(InterviewQuizErrorCode),
    message: z.string(),
  }).optional(),
})

export type InterviewQuizState = typeof InterviewQuizStateSchema.State

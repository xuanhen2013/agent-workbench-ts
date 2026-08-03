import type {
  QuizCategory,
  QuizDifficulty,
  QuizModelUsage,
  QuizRoundPlan,
  QuizRoundRecord,
  QuizSectionPlan,
  QuizStrategy,
} from './contracts'
import type { JdContext } from '@/agent/interview-quiz/jd/contracts'
import type { LearningMemoryContext } from '@/agent/interview-quiz/learning-memory/contracts'
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

  /** 跨 Thread 稳定的学习者身份；HTTP 创建边界只校验一次。 */
  learnerId: z.string().uuid(),

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

  /** initialize 或 replan 确定；Planning Subgraph 只读取。 */
  roundContext: z.custom<QuizRoundContext>().nullable().default(null),

  /** 根据 JD 一次性选出的完整分类，后续 RePlan 不重新猜分类。 */
  categories: z.custom<QuizCategory[]>().default(() => []),

  /** 当前轮实际要生成的分类；Remediate 时只包含上一轮答错分类。 */
  activeCategories: z.custom<QuizCategory[]>().default(() => []),

  /** 指向 activeCategories 中下一次要规划的分类。 */
  categoryCursor: z.number().int().nonnegative().default(0),

  /** Planning Subgraph 刚生成、尚未收进本轮的分类题卷。 */
  currentSection: z.custom<QuizSectionPlan>().nullable().default(null),

  /** 当前轮已经顺序生成的分类题卷。 */
  plannedSections: z.custom<QuizSectionPlan[]>().default(() => []),

  /** 所有分类生成完成后组装，后续题库、Interrupt 和判分共同使用。 */
  currentPlan: z.custom<QuizRoundPlan>().nullable().default(null),

  /** Answer Interrupt Resume 后写入，verify 消费。 */
  submission: QuizRoundSubmissionSchema.nullable().default(null),

  /** 当前 Planner 调用的 usage，在 verify 时并入完成轮次。 */
  currentModelUsage: z.custom<QuizModelUsage>().nullable().default(null),

  /** 当前轮实际使用的有界资料快照。 */
  retrievedChunks: z.custom<RetrievedChunk[]>().default(() => []),

  /** 启动时从 SQL 聚合出的有界长期记忆，不保存完整 attempts。 */
  memoryContext: z.custom<LearningMemoryContext>().default(() => ({
    weakKnowledgePoints: [],
  })),

  /** 当前 Thread 的有界 JD 信号；不保存用户粘贴的 JD 原文。 */
  jdContext: z.custom<JdContext>().nullable().default(null),

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
export type InterviewQuizUpdate = typeof InterviewQuizStateSchema.Update

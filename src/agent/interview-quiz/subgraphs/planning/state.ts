import type { QuizModelUsage, QuizRoundDraft, QuizRoundPlan } from '../../contracts'
import type { InterviewQuizError } from '../../errors'
import type { JdContext } from '../../jd/contracts'
import type { LearningMemoryContext } from '../../learning-memory/contracts'
import type { QuizRoundContext } from '../../state'
import type { OpenAIResponseInputItem } from '@/clients/openai'
import type { RetrievedChunk } from '@/knowledge/contracts'
import { StateSchema } from '@langchain/langgraph'
import { z } from 'zod/v4'

/**
 * Parent 调用 Planning Subgraph 时必须提供的完整输入。
 *
 * 这是应用层契约，不是第二次外部校验边界；进入 Graph 后由 TypeScript
 * 负责内部流转，不在 mapper 内反复 z.parse。
 */
export interface PlanningInput {
  threadId: string
  roundContext: QuizRoundContext
  modelHistory: OpenAIResponseInputItem[]
  completedQuestionStems: string[]
  previousWrongKnowledgePoints: string[]
  memoryContext: LearningMemoryContext
  jdContext: JdContext | null
}

export const PlanningStateSchema = new StateSchema({
  // Parent 显式输入
  threadId: z.string().min(1),
  roundContext: z.custom<QuizRoundContext>(),
  modelHistory: z.array(z.custom<OpenAIResponseInputItem>()),
  completedQuestionStems: z.array(z.string()),
  previousWrongKnowledgePoints: z.array(z.string()),
  memoryContext: z.custom<LearningMemoryContext>(),
  jdContext: z.custom<JdContext>().nullable(),

  // Subgraph 私有状态和最终输出
  questionBankStems: z.array(z.string()).default(() => []),
  retrievedChunks: z.custom<RetrievedChunk[]>().default(() => []),

  // 通过 ToolLoopGraph 得到的领域输出；不保存 ToolLoop 私有协议状态。
  candidateDraft: z.custom<QuizRoundDraft>().nullable().default(null),

  currentPlan: z.custom<QuizRoundPlan>().nullable().default(null),
  continuationItems: z.array(
    z.custom<OpenAIResponseInputItem>(),
  ).default(() => []),
  modelUsage: z.custom<QuizModelUsage>().nullable().default(null),
  error: z.custom<InterviewQuizError>().nullable().default(null),
})

export type PlanningState = typeof PlanningStateSchema.State
export type PlanningUpdate = typeof PlanningStateSchema.Update

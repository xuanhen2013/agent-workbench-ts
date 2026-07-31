import type {
  PlannedQuizQuestion,
  QuizDifficulty,
  QuizRoundPlan,
} from '@/agent/interview-quiz/contracts'

/** D1/InMemory 中保存的完整私有题目；Web DTO 永远不能直接使用它。 */
export interface StoredQuizQuestion {
  bankQuestionId: string
  contentFingerprint: string
  difficulty: QuizDifficulty
  type: PlannedQuizQuestion['type']
  topic: string
  knowledgePoint: string
  stem: string
  options: PlannedQuizQuestion['options']
  correctOptionIds: string[]
  explanation: string
  sourceChunkIds: string[]
  createdAt: string
}

/** Graph 每轮只读取有限题干，不把整个题库或答案交给 Planner。 */
export interface FindRecentStemsInput {
  difficulty: QuizDifficulty
  knowledgePoints: string[]
  limit: number
  signal: AbortSignal
}

/**
 * Graph 依赖的 Provider 无关边界。
 * Cloudflare D1 和 InMemory 都实现同一接口，Graph 不知道底层存储协议。
 */
export interface QuestionBank {
  savePlan: (
    plan: QuizRoundPlan,
    options: { signal: AbortSignal },
  ) => Promise<QuizRoundPlan>

  findRecentStems: (input: FindRecentStemsInput) => Promise<string[]>

  findById: (
    bankQuestionId: string,
    options: { signal: AbortSignal },
  ) => Promise<StoredQuizQuestion | undefined>

  count: (options: { signal: AbortSignal }) => Promise<number>
}

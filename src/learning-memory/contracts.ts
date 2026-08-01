import type { QuizDifficulty } from '@/agent/interview-quiz/contracts'

/** 一道题已经完成判分后的最小作答事实。 */
export interface QuestionAttemptInput {
  questionId: string
  bankQuestionId: string
  knowledgePoint: string
  selectedOptionIds: string[]
  isCorrect: boolean
}

/** Graph 把一轮 QuizRoundRecord 显式投影成该结构后再交给持久层。 */
export interface RoundAttemptInput {
  learnerId: string
  threadId: string
  round: number
  difficulty: QuizDifficulty
  correctCount: number
  total: number
  completedAt: string
  questions: QuestionAttemptInput[]
}

/** 从不可变作答事实计算出的可解释知识点统计，不单独作为事实保存。 */
export interface TopicMastery {
  knowledgePoint: string
  attempts: number
  correct: number
  masteryScore: number
}

/** 进入 Graph State 和 Planner 的有界长期记忆快照。 */
export interface LearningMemoryContext {
  weakKnowledgePoints: string[]
}

export interface LearningMemory {
  recordRound: (
    input: RoundAttemptInput,
    options: { signal: AbortSignal },
  ) => Promise<{ inserted: boolean }>

  listTopicMastery: (
    learnerId: string,
    options: { signal: AbortSignal },
  ) => Promise<TopicMastery[]>

  loadContext: (
    learnerId: string,
    options: { signal: AbortSignal },
  ) => Promise<LearningMemoryContext>
}

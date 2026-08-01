import { z } from 'zod/v4'

export enum QuizDifficulty {
  Foundation = 'foundation',
  Intermediate = 'intermediate',
  Advanced = 'advanced',
}

export enum QuestionType {
  Single = 'single',
  Multiple = 'multiple',
}

export enum QuizStrategy {
  Initial = 'initial',
  Advance = 'advance',
  Remediate = 'remediate',
}

export enum InterviewQuizStatus {
  Planning = 'planning',
  WaitingForAnswers = 'waiting_for_answers',
  Grading = 'grading',
  WaitingForNextRound = 'waiting_for_next_round',
  Completed = 'completed',
  Failed = 'failed',
}

export enum QuizCompletionReason {
  MaxRounds = 'max_rounds',
}

/** 创建 Quiz Thread 时由 Web 提交，题目方向固定为 Agent 工程。 */
export const QuizConfigSchema = z.object({
  initialDifficulty: z.enum(QuizDifficulty),
  maxRounds: z.number().int().min(1).max(3),
}).strict()

/** 创建新 Thread 的 HTTP Body；learnerId 是跨 Session 的 Demo 身份。 */
export const CreateInterviewQuizBodySchema = QuizConfigSchema.extend({
  learnerId: z.string().uuid(),
}).strict()

export const QuizOptionSchema = z.object({
  optionId: z.string().regex(/^[A-F]$/),
  text: z.string().trim().min(1).max(300),
}).strict()

/** 模型返回的私有题目；答案和解析永远不进入问题 Interrupt。 */
export const QuizQuestionDraftSchema = z.object({
  type: z.enum(QuestionType),
  topic: z.string().trim().min(1).max(80),
  knowledgePoint: z.string().trim().min(1).max(120),
  stem: z.string().trim().min(5).max(1000),
  options: z.array(QuizOptionSchema).min(3).max(6),
  correctOptionIds: z.array(z.string().regex(/^[A-F]$/)).min(1).max(6),
  explanation: z.string().trim().min(5).max(2000),
  /** 05 保持为空；06B 接入 RAG 后写入真实 Chunk ID。 */
  sourceChunkIds: z.array(z.string().min(1)).default([]),
}).strict()

export const QuizRoundDraftSchema = z.object({
  questions: z.array(QuizQuestionDraftSchema).length(5),
}).strict()

export const QuizAnswerSchema = z.object({
  questionId: z.string().min(1),
  selectedOptionIds: z.array(z.string().regex(/^[A-F]$/)).min(1).max(6),
}).strict()

export const QuizRoundSubmissionSchema = z.object({
  reviewId: z.string().min(1),
  answers: z.array(QuizAnswerSchema).length(5),
}).strict()

export type QuizConfig = z.infer<typeof QuizConfigSchema>
export type QuizOption = z.infer<typeof QuizOptionSchema>
export type QuizQuestionDraft = z.infer<typeof QuizQuestionDraftSchema>
export type QuizRoundDraft = z.infer<typeof QuizRoundDraftSchema>
export type QuizAnswer = z.infer<typeof QuizAnswerSchema>
export type QuizRoundSubmission = z.infer<typeof QuizRoundSubmissionSchema>

/** Schema 和领域校验通过后，由应用补上确定性 questionId。 */
export interface PlannedQuizQuestion extends QuizQuestionDraft {
  questionId: string
  /** 06C 写入 SQL 题库后才出现。 */
  bankQuestionId?: string
}

export interface QuizRoundPlan {
  reviewId: string
  round: number
  difficulty: QuizDifficulty
  strategy: QuizStrategy
  /** 服务端私有题目，仍然包含正确答案和解析。 */
  questions: PlannedQuizQuestion[]
}

export interface QuizQuestionResult {
  questionId: string
  selectedOptionIds: string[]
  isCorrect: boolean
}

export interface QuizRoundResult {
  correctCount: number
  allCorrect: boolean
  questionResults: QuizQuestionResult[]
  wrongKnowledgePoints: string[]
}

/** OpenAI 或兼容网关实际返回的缓存使用量；缺失时不伪造。 */
export interface QuizModelUsage {
  inputTokens: number
  cachedTokens: number
  cacheWriteTokens: number
}

/** 一轮完成后的业务事实；06D 会把其中的成绩写入 SQL Memory。 */
export interface QuizRoundRecord {
  plan: QuizRoundPlan
  result: QuizRoundResult
  modelUsage?: QuizModelUsage
}

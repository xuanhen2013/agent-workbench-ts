import type { Result } from 'neverthrow'
import type {
  QuizModelUsage,
  QuizOption,
  QuizRoundPlan,
  QuizRoundRecord,
  QuizRoundResult,
  QuizRoundSubmission,
} from './contracts'
import { err, ok } from 'neverthrow'
import { z } from 'zod/v4'
import {
  QuestionType,
  QuizDifficulty,
  QuizOptionSchema,
  QuizRoundSubmissionSchema,
  QuizStrategy,
} from './contracts'

export enum QuizInterruptKind {
  Round = 'interview_quiz_round',
  RoundResult = 'interview_quiz_round_result',
}

export enum QuizNextRoundAction {
  NextRound = 'next_round',
}

export interface PublicQuizQuestion {
  questionId: string
  type: QuestionType
  topic: string
  knowledgePoint: string
  stem: string
  options: QuizOption[]
}

export interface QuizRoundRequest {
  kind: QuizInterruptKind.Round
  reviewId: string
  round: number
  difficulty: QuizDifficulty
  questionCount: 5
  questions: PublicQuizQuestion[]
}

export interface PublicQuizQuestionResult {
  questionId: string
  type: QuestionType
  topic: string
  knowledgePoint: string
  stem: string
  selectedOptions: QuizOption[]
  isCorrect: boolean
}

export interface PublicQuizRoundResult {
  round: number
  difficulty: QuizDifficulty
  strategy: QuizStrategy
  total: number
  correctCount: number
  allCorrect: boolean
  wrongKnowledgePoints: string[]
  questionResults: PublicQuizQuestionResult[]
  modelUsage?: QuizModelUsage
}

export interface QuizRoundResultRequest {
  kind: QuizInterruptKind.RoundResult
  reviewId: string
  result: PublicQuizRoundResult
}

export const QuizNextRoundDecisionSchema = z.object({
  reviewId: z.string().min(1),
  action: z.literal(QuizNextRoundAction.NextRound),
}).strict()

export type QuizNextRoundDecision = z.infer<typeof QuizNextRoundDecisionSchema>

export interface QuizExecutionError {
  code: string
  message: string
}

export type SubmissionValidationResult = Result<
  QuizRoundSubmission,
  QuizExecutionError
>

export const PublicQuizQuestionSchema: z.ZodType<PublicQuizQuestion> = z.object({
  questionId: z.string().min(1),
  type: z.enum(QuestionType),
  topic: z.string().min(1),
  knowledgePoint: z.string().min(1),
  stem: z.string().min(1),
  options: z.array(QuizOptionSchema).min(3).max(6),
}).strict()

export const QuizRoundRequestSchema: z.ZodType<QuizRoundRequest> = z.object({
  kind: z.literal(QuizInterruptKind.Round),
  reviewId: z.string().min(1),
  round: z.number().int().positive(),
  difficulty: z.enum(QuizDifficulty),
  questionCount: z.literal(5),
  questions: z.array(PublicQuizQuestionSchema).length(5),
}).strict()

const QuizModelUsageSchema: z.ZodType<QuizModelUsage> = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
}).strict()

const PublicQuizQuestionResultSchema: z.ZodType<PublicQuizQuestionResult>
  = z.object({
    questionId: z.string().min(1),
    type: z.enum(QuestionType),
    topic: z.string().min(1),
    knowledgePoint: z.string().min(1),
    stem: z.string().min(1),
    selectedOptions: z.array(QuizOptionSchema),
    isCorrect: z.boolean(),
  }).strict()

export const PublicQuizRoundResultSchema: z.ZodType<PublicQuizRoundResult>
  = z.object({
    round: z.number().int().positive(),
    difficulty: z.enum(QuizDifficulty),
    strategy: z.enum(QuizStrategy),
    total: z.number().int().positive(),
    correctCount: z.number().int().min(0).max(5),
    allCorrect: z.boolean(),
    wrongKnowledgePoints: z.array(z.string()),
    questionResults: z.array(PublicQuizQuestionResultSchema).length(5),
    modelUsage: QuizModelUsageSchema.optional(),
  }).strict()

export const QuizRoundResultRequestSchema: z.ZodType<QuizRoundResultRequest>
  = z.object({
    kind: z.literal(QuizInterruptKind.RoundResult),
    reviewId: z.string().min(1),
    result: PublicQuizRoundResultSchema,
  }).strict()

export function projectRoundRequest(plan: QuizRoundPlan): QuizRoundRequest {
  return {
    kind: QuizInterruptKind.Round,
    reviewId: plan.reviewId,
    round: plan.round,
    difficulty: plan.difficulty,
    questionCount: 5,
    questions: plan.questions.map(question => ({
      questionId: question.questionId,
      type: question.type,
      topic: question.topic,
      knowledgePoint: question.knowledgePoint,
      stem: question.stem,
      options: question.options,
    })),
  }
}

export function validateSubmission(
  candidate: unknown,
  plan: QuizRoundPlan,
): SubmissionValidationResult {
  const parsed = QuizRoundSubmissionSchema.safeParse(candidate)
  if (!parsed.success) {
    return err({
      code: 'invalid_submission_shape',
      message: '提交的题卷格式不合法',
    })
  }

  const submission = parsed.data
  if (submission.reviewId !== plan.reviewId) {
    return err({
      code: 'review_id_mismatch',
      message: '提交内容不属于当前题卷',
    })
  }

  const questionById = new Map(
    plan.questions.map(question => [question.questionId, question]),
  )
  const answeredQuestionIds = new Set<string>()

  for (const answer of submission.answers) {
    if (answeredQuestionIds.has(answer.questionId)) {
      return err({
        code: 'duplicate_question_answer',
        message: '同一道题被重复提交',
      })
    }

    const question = questionById.get(answer.questionId)
    if (!question) {
      return err({
        code: 'unknown_question_id',
        message: '提交中包含未知题目',
      })
    }

    const selectedSet = new Set(answer.selectedOptionIds)
    if (selectedSet.size !== answer.selectedOptionIds.length) {
      return err({
        code: 'duplicate_selected_option',
        message: '同一选项被重复提交',
      })
    }

    const validOptionIds = new Set(
      question.options.map(option => option.optionId),
    )
    if (!answer.selectedOptionIds.every(id => validOptionIds.has(id))) {
      return err({
        code: 'unknown_selected_option',
        message: '提交中包含未知选项',
      })
    }

    if (
      question.type === QuestionType.Single
      && answer.selectedOptionIds.length !== 1
    ) {
      return err({
        code: 'invalid_single_selection_count',
        message: '单选题必须选择一个选项',
      })
    }

    answeredQuestionIds.add(answer.questionId)
  }

  if (answeredQuestionIds.size !== plan.questions.length) {
    return err({
      code: 'missing_question_answer',
      message: '必须回答本轮全部题目',
    })
  }

  return ok(submission)
}

function sameStringSet(left: string[], right: string[]) {
  const leftSet = new Set(left)
  const rightSet = new Set(right)

  return leftSet.size === rightSet.size
    && [...leftSet].every(value => rightSet.has(value))
}

export function gradeQuizRound(input: {
  plan: QuizRoundPlan
  submission: QuizRoundSubmission
}): QuizRoundResult {
  const answerByQuestionId = new Map(
    input.submission.answers.map(answer => [answer.questionId, answer]),
  )

  const questionResults = input.plan.questions.map((question) => {
    const answer = answerByQuestionId.get(question.questionId)
    if (!answer)
      throw new Error('validated_submission_answer_missing')

    return {
      questionId: question.questionId,
      selectedOptionIds: [...answer.selectedOptionIds].sort(),
      isCorrect: sameStringSet(
        answer.selectedOptionIds,
        question.correctOptionIds,
      ),
    }
  })

  const correctCount = questionResults.filter(item => item.isCorrect).length
  const wrongKnowledgePoints = [...new Set(
    input.plan.questions
      .filter((_, index) => !questionResults[index]?.isCorrect)
      .map(question => question.knowledgePoint),
  )].sort()

  return {
    correctCount,
    allCorrect: correctCount === 5,
    questionResults,
    wrongKnowledgePoints,
  }
}

export function projectPublicRoundResult(
  record: QuizRoundRecord,
): PublicQuizRoundResult {
  const resultByQuestionId = new Map(
    record.result.questionResults.map(result => [result.questionId, result]),
  )

  return {
    round: record.plan.round,
    difficulty: record.plan.difficulty,
    strategy: record.plan.strategy,
    total: record.plan.questions.length,
    correctCount: record.result.correctCount,
    allCorrect: record.result.allCorrect,
    wrongKnowledgePoints: record.result.wrongKnowledgePoints,
    questionResults: record.plan.questions.map((question) => {
      const result = resultByQuestionId.get(question.questionId)
      if (!result)
        throw new Error('round_result_question_missing')

      const selectedIdSet = new Set(result.selectedOptionIds)
      return {
        questionId: question.questionId,
        type: question.type,
        topic: question.topic,
        knowledgePoint: question.knowledgePoint,
        stem: question.stem,
        selectedOptions: question.options.filter(option => (
          selectedIdSet.has(option.optionId)
        )),
        isCorrect: result.isCorrect,
      }
    }),
    ...(record.modelUsage ? { modelUsage: record.modelUsage } : {}),
  }
}

export function projectRoundResultRequest(input: {
  threadId: string
  record: QuizRoundRecord
}): QuizRoundResultRequest {
  return {
    kind: QuizInterruptKind.RoundResult,
    reviewId: `${input.threadId}:round:${input.record.plan.round}:next`,
    result: projectPublicRoundResult(input.record),
  }
}

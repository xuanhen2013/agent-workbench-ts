import type { Result } from 'neverthrow'
import type {
  QuizCategory,
  QuizModelUsage,
  QuizOption,
  QuizRoundPlan,
  QuizRoundRecord,
  QuizRoundResult,
  QuizRoundSubmission,
} from './contracts'
import type { InterviewQuizError } from './errors'
import { err, ok } from 'neverthrow'
import { z } from 'zod/v4'
import {
  MAX_QUESTIONS_PER_ROUND,
  MAX_QUIZ_CATEGORIES,
  QUESTIONS_PER_CATEGORY,
  QuestionType,
  QuizCategoryId,
  QuizDifficulty,
  QuizOptionSchema,
  QuizRoundSubmissionSchema,
  QuizStrategy,
} from './contracts'
import {
  createInterviewQuizError,
  InterviewQuizErrorCode,
} from './errors'

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

export interface PublicQuizSection {
  category: QuizCategory
  questions: PublicQuizQuestion[]
}

export interface QuizRoundRequest {
  kind: QuizInterruptKind.Round
  reviewId: string
  round: number
  difficulty: QuizDifficulty
  questionCount: number
  sections: PublicQuizSection[]
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

export interface PublicQuizSectionResult {
  category: QuizCategory
  total: number
  correctCount: number
  allCorrect: boolean
  questionResults: PublicQuizQuestionResult[]
}

export interface PublicQuizRoundResult {
  round: number
  difficulty: QuizDifficulty
  strategy: QuizStrategy
  total: number
  correctCount: number
  allCorrect: boolean
  wrongKnowledgePoints: string[]
  sectionResults: PublicQuizSectionResult[]
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

export type QuizExecutionError = InterviewQuizError

export type SubmissionValidationResult = Result<
  QuizRoundSubmission,
  QuizExecutionError
>

export const QuizCategorySchema: z.ZodType<QuizCategory> = z.object({
  categoryId: z.enum(QuizCategoryId),
  name: z.string().min(1),
  knowledgePoints: z.array(z.string().min(1)).min(1),
}).strict()

export const PublicQuizQuestionSchema: z.ZodType<PublicQuizQuestion> = z.object({
  questionId: z.string().min(1),
  type: z.enum(QuestionType),
  topic: z.string().min(1),
  knowledgePoint: z.string().min(1),
  stem: z.string().min(1),
  options: z.array(QuizOptionSchema).min(3).max(6),
}).strict()

export const PublicQuizSectionSchema: z.ZodType<PublicQuizSection> = z.object({
  category: QuizCategorySchema,
  questions: z.array(PublicQuizQuestionSchema).length(QUESTIONS_PER_CATEGORY),
}).strict()

export const QuizRoundRequestSchema: z.ZodType<QuizRoundRequest> = z.object({
  kind: z.literal(QuizInterruptKind.Round),
  reviewId: z.string().min(1),
  round: z.number().int().positive(),
  difficulty: z.enum(QuizDifficulty),
  questionCount: z.number().int().min(QUESTIONS_PER_CATEGORY).max(MAX_QUESTIONS_PER_ROUND),
  sections: z.array(PublicQuizSectionSchema).min(1).max(MAX_QUIZ_CATEGORIES),
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

const PublicQuizSectionResultSchema: z.ZodType<PublicQuizSectionResult>
  = z.object({
    category: QuizCategorySchema,
    total: z.literal(QUESTIONS_PER_CATEGORY),
    correctCount: z.number().int().min(0).max(QUESTIONS_PER_CATEGORY),
    allCorrect: z.boolean(),
    questionResults: z.array(PublicQuizQuestionResultSchema)
      .length(QUESTIONS_PER_CATEGORY),
  }).strict()

export const PublicQuizRoundResultSchema: z.ZodType<PublicQuizRoundResult>
  = z.object({
    round: z.number().int().positive(),
    difficulty: z.enum(QuizDifficulty),
    strategy: z.enum(QuizStrategy),
    total: z.number().int().min(QUESTIONS_PER_CATEGORY).max(MAX_QUESTIONS_PER_ROUND),
    correctCount: z.number().int().min(0).max(MAX_QUESTIONS_PER_ROUND),
    allCorrect: z.boolean(),
    wrongKnowledgePoints: z.array(z.string()),
    sectionResults: z.array(PublicQuizSectionResultSchema)
      .min(1)
      .max(MAX_QUIZ_CATEGORIES),
    modelUsage: QuizModelUsageSchema.optional(),
  }).strict()

export const QuizRoundResultRequestSchema: z.ZodType<QuizRoundResultRequest>
  = z.object({
    kind: z.literal(QuizInterruptKind.RoundResult),
    reviewId: z.string().min(1),
    result: PublicQuizRoundResultSchema,
  }).strict()

function publicQuestion(
  question: QuizRoundPlan['sections'][number]['questions'][number],
): PublicQuizQuestion {
  return {
    questionId: question.questionId,
    type: question.type,
    topic: question.topic,
    knowledgePoint: question.knowledgePoint,
    stem: question.stem,
    options: question.options,
  }
}

export function projectRoundRequest(plan: QuizRoundPlan): QuizRoundRequest {
  const questionCount = plan.sections.reduce(
    (total, section) => total + section.questions.length,
    0,
  )
  return {
    kind: QuizInterruptKind.Round,
    reviewId: plan.reviewId,
    round: plan.round,
    difficulty: plan.difficulty,
    questionCount,
    sections: plan.sections.map(section => ({
      category: structuredClone(section.category),
      questions: section.questions.map(publicQuestion),
    })),
  }
}

export function validateSubmission(
  candidate: unknown,
  plan: QuizRoundPlan,
): SubmissionValidationResult {
  const parsed = QuizRoundSubmissionSchema.safeParse(candidate)
  if (!parsed.success) {
    return err(createInterviewQuizError(
      InterviewQuizErrorCode.InvalidSubmissionShape,
    ))
  }

  const submission = parsed.data
  if (submission.reviewId !== plan.reviewId) {
    return err(createInterviewQuizError(
      InterviewQuizErrorCode.ReviewIdMismatch,
    ))
  }

  const plannedQuestions = plan.sections.flatMap(section => section.questions)
  const questionById = new Map(
    plannedQuestions.map(question => [question.questionId, question]),
  )
  const answeredQuestionIds = new Set<string>()

  for (const answer of submission.answers) {
    if (answeredQuestionIds.has(answer.questionId)) {
      return err(createInterviewQuizError(
        InterviewQuizErrorCode.DuplicateQuestionAnswer,
      ))
    }

    const question = questionById.get(answer.questionId)
    if (!question) {
      return err(createInterviewQuizError(
        InterviewQuizErrorCode.UnknownQuestionId,
      ))
    }

    const selectedSet = new Set(answer.selectedOptionIds)
    if (selectedSet.size !== answer.selectedOptionIds.length) {
      return err(createInterviewQuizError(
        InterviewQuizErrorCode.DuplicateSelectedOption,
      ))
    }

    const validOptionIds = new Set(
      question.options.map(option => option.optionId),
    )
    if (!answer.selectedOptionIds.every(id => validOptionIds.has(id))) {
      return err(createInterviewQuizError(
        InterviewQuizErrorCode.UnknownSelectedOption,
      ))
    }

    if (
      question.type === QuestionType.Single
      && answer.selectedOptionIds.length !== 1
    ) {
      return err(createInterviewQuizError(
        InterviewQuizErrorCode.InvalidSingleSelectionCount,
      ))
    }

    answeredQuestionIds.add(answer.questionId)
  }

  if (answeredQuestionIds.size !== plannedQuestions.length) {
    return err(createInterviewQuizError(
      InterviewQuizErrorCode.MissingQuestionAnswer,
    ))
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

  const sectionResults = input.plan.sections.map((section) => {
    const questionResults = section.questions.map((question) => {
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
    const wrongKnowledgePoints = section.questions
      .filter((_, index) => !questionResults[index]?.isCorrect)
      .map(question => question.knowledgePoint)

    return {
      categoryId: section.category.categoryId,
      correctCount,
      allCorrect: correctCount === section.questions.length,
      questionResults,
      wrongKnowledgePoints: [...new Set(wrongKnowledgePoints)].sort(),
    }
  })

  const correctCount = sectionResults.reduce(
    (total, section) => total + section.correctCount,
    0,
  )
  const total = input.plan.sections.reduce(
    (count, section) => count + section.questions.length,
    0,
  )
  const wrongKnowledgePoints = [...new Set(
    sectionResults.flatMap(section => section.wrongKnowledgePoints),
  )].sort()

  return {
    correctCount,
    allCorrect: correctCount === total,
    sectionResults,
    wrongKnowledgePoints,
  }
}

function projectQuestionResult(
  question: QuizRoundPlan['sections'][number]['questions'][number],
  result: QuizRoundResult['sectionResults'][number]['questionResults'][number],
): PublicQuizQuestionResult {
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
}

export function projectPublicRoundResult(
  record: QuizRoundRecord,
): PublicQuizRoundResult {
  return {
    round: record.plan.round,
    difficulty: record.plan.difficulty,
    strategy: record.plan.strategy,
    total: record.plan.sections.reduce(
      (total, section) => total + section.questions.length,
      0,
    ),
    correctCount: record.result.correctCount,
    allCorrect: record.result.allCorrect,
    wrongKnowledgePoints: record.result.wrongKnowledgePoints,
    sectionResults: record.plan.sections.map((section) => {
      const result = record.result.sectionResults.find(sectionResult => (
        sectionResult.categoryId === section.category.categoryId
      ))
      if (!result)
        throw new Error('round_result_section_missing')

      const resultByQuestionId = new Map(
        result.questionResults.map(question => [question.questionId, question]),
      )
      return {
        category: structuredClone(section.category),
        total: section.questions.length,
        correctCount: result.correctCount,
        allCorrect: result.allCorrect,
        questionResults: section.questions.map((question) => {
          const questionResult = resultByQuestionId.get(question.questionId)
          if (!questionResult)
            throw new Error('round_result_question_missing')
          return projectQuestionResult(question, questionResult)
        }),
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

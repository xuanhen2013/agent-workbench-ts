import type { StoredQuizQuestion } from './contracts'
import type {
  PlannedQuizQuestion,
  QuizDifficulty,
} from '@/agent/interview-quiz/contracts'
import { createHash } from 'node:crypto'

/** 只用于稳定身份，不修改展示给用户的原始文本。 */
export function normalizeQuestionIdentityText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function canonicalizeQuestion(input: {
  difficulty: QuizDifficulty
  question: PlannedQuizQuestion
}) {
  const { difficulty, question } = input

  return {
    difficulty,
    type: question.type,
    topic: normalizeQuestionIdentityText(question.topic),
    knowledgePoint: normalizeQuestionIdentityText(question.knowledgePoint),
    stem: normalizeQuestionIdentityText(question.stem),
    options: question.options
      .map(option => ({
        optionId: option.optionId.toUpperCase(),
        text: normalizeQuestionIdentityText(option.text),
      }))
      .sort((left, right) => left.optionId.localeCompare(right.optionId)),
    correctOptionIds: [...new Set(
      question.correctOptionIds.map(id => id.toUpperCase()),
    )].sort(),
  }
}

export function createQuestionFingerprint(input: {
  difficulty: QuizDifficulty
  question: PlannedQuizQuestion
}): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeQuestion(input)))
    .digest('hex')
}

export function createBankQuestionId(contentFingerprint: string): string {
  return `question:${contentFingerprint.slice(0, 24)}`
}

/** 把当前轮问题投影成可持久化事实；不会原地修改 Plan。 */
export function createStoredQuizQuestion(input: {
  difficulty: QuizDifficulty
  question: PlannedQuizQuestion
  createdAt: string
}): StoredQuizQuestion {
  const contentFingerprint = createQuestionFingerprint(input)

  return {
    bankQuestionId: createBankQuestionId(contentFingerprint),
    contentFingerprint,
    difficulty: input.difficulty,
    type: input.question.type,
    topic: input.question.topic,
    knowledgePoint: input.question.knowledgePoint,
    stem: input.question.stem,
    options: structuredClone(input.question.options),
    correctOptionIds: [...input.question.correctOptionIds],
    explanation: input.question.explanation,
    sourceChunkIds: [...input.question.sourceChunkIds],
    createdAt: input.createdAt,
  }
}

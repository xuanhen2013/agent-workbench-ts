import { describe, expect, test } from 'bun:test'
import { QuizDifficulty } from '@/agent/interview-quiz/contracts'
import {
  canonicalizeQuestion,
  createBankQuestionId,
  createQuestionFingerprint,
} from '@/agent/interview-quiz/question-bank/fingerprint'
import { materializeTestPlan } from '../../../helpers/quiz'

describe('question fingerprint', () => {
  test('忽略展示 ID、大小写、空白、选项顺序和答案顺序', () => {
    const original = materializeTestPlan().questions[2]!
    const equivalent = {
      ...structuredClone(original),
      questionId: 'another-round-question-id',
      topic: `  ${original.topic.toUpperCase()}  `,
      knowledgePoint: ` ${original.knowledgePoint.toUpperCase()} `,
      stem: `  ${original.stem.replaceAll(' ', '   ')}  `,
      options: structuredClone(original.options).reverse(),
      correctOptionIds: ['B', 'A'],
      explanation: '解释措辞发生变化，但题目身份不变。',
      sourceChunkIds: ['another-source'],
    }

    const left = createQuestionFingerprint({
      difficulty: QuizDifficulty.Foundation,
      question: original,
    })
    const right = createQuestionFingerprint({
      difficulty: QuizDifficulty.Foundation,
      question: equivalent,
    })

    expect(right).toBe(left)
    expect(createBankQuestionId(right)).toBe(createBankQuestionId(left))
    expect(canonicalizeQuestion({
      difficulty: QuizDifficulty.Foundation,
      question: equivalent,
    }).options.map(option => option.optionId)).toEqual(['A', 'B', 'C'])
  })

  test('答案、选项文本或难度变化会产生不同身份', () => {
    const question = materializeTestPlan().questions[0]!
    const fingerprint = createQuestionFingerprint({
      difficulty: QuizDifficulty.Foundation,
      question,
    })
    const answerChanged = {
      ...structuredClone(question),
      correctOptionIds: ['B'],
    }
    const optionChanged = {
      ...structuredClone(question),
      options: question.options.map(option => (
        option.optionId === 'A'
          ? { ...option, text: `${option.text}（已修改）` }
          : option
      )),
    }

    expect(createQuestionFingerprint({
      difficulty: QuizDifficulty.Foundation,
      question: answerChanged,
    })).not.toBe(fingerprint)
    expect(createQuestionFingerprint({
      difficulty: QuizDifficulty.Foundation,
      question: optionChanged,
    })).not.toBe(fingerprint)
    expect(createQuestionFingerprint({
      difficulty: QuizDifficulty.Advanced,
      question,
    })).not.toBe(fingerprint)
  })
})

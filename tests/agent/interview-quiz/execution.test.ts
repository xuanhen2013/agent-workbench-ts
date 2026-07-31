import { describe, expect, test } from 'bun:test'
import { QuizDifficulty } from '@/agent/interview-quiz/contracts'
import { InterviewQuizErrorCode } from '@/agent/interview-quiz/errors'
import {
  gradeQuizRound,
  projectPublicRoundResult,
  projectRoundRequest,
  validateSubmission,
} from '@/agent/interview-quiz/execution'
import {
  correctSubmission,
  materializeTestPlan,
  wrongSubmission,
} from '../../helpers/quiz'

describe('Interview Quiz execution', () => {
  test('问题投影不会暴露正确答案、解析或 sourceChunkIds', () => {
    const request = projectRoundRequest(materializeTestPlan())
    const serialized = JSON.stringify(request)

    expect(request.questions).toHaveLength(5)
    expect(serialized).not.toContain('correctOptionIds')
    expect(serialized).not.toContain('explanation')
    expect(serialized).not.toContain('sourceChunkIds')
  })

  test('无效 reviewId 和重复 questionId 会被拒绝', () => {
    const plan = materializeTestPlan()
    const request = projectRoundRequest(plan)
    const mismatch = correctSubmission(request)
    mismatch.reviewId = 'another-review'
    const duplicate = correctSubmission(request)
    duplicate.answers[1] = { ...duplicate.answers[0]! }

    const mismatchResult = validateSubmission(mismatch, plan)
    const duplicateResult = validateSubmission(duplicate, plan)

    expect(mismatchResult.isErr() && mismatchResult.error.code)
      .toBe(InterviewQuizErrorCode.ReviewIdMismatch)
    expect(duplicateResult.isErr() && duplicateResult.error.code)
      .toBe(InterviewQuizErrorCode.DuplicateQuestionAnswer)
  })

  test('多选顺序不同仍然判对', () => {
    const plan = materializeTestPlan()
    const submission = correctSubmission(projectRoundRequest(plan))
    const result = gradeQuizRound({ plan, submission })

    expect(result.correctCount).toBe(5)
    expect(result.allCorrect).toBe(true)
  })

  test('错题生成去重薄弱点，公开结果仍不包含私有答案', () => {
    const plan = materializeTestPlan({
      difficulty: QuizDifficulty.Intermediate,
    })
    const submission = wrongSubmission(projectRoundRequest(plan))
    const result = gradeQuizRound({ plan, submission })
    const publicResult = projectPublicRoundResult({
      plan,
      result,
      modelUsage: {
        inputTokens: 1200,
        cachedTokens: 800,
        cacheWriteTokens: 0,
      },
    })
    const serialized = JSON.stringify(publicResult)

    expect(result.correctCount).toBe(0)
    expect(result.wrongKnowledgePoints.length).toBeGreaterThan(0)
    expect(publicResult.modelUsage?.cachedTokens).toBe(800)
    expect(serialized).not.toContain('correctOptionIds')
    expect(serialized).not.toContain('explanation')
  })
})

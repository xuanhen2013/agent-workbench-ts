import { describe, expect, test } from 'bun:test'
import { QuizDifficulty } from '@/agent/interview-quiz/contracts'
import { InMemoryQuestionBank } from '@/agent/interview-quiz/question-bank/in-memory-question-bank'
import { materializeTestPlan } from '../../../helpers/quiz'

function signal() {
  return new AbortController().signal
}

describe('InMemoryQuestionBank', () => {
  test('重复保存同一 Plan 保持五条稳定记录且不修改输入', async () => {
    const bank = new InMemoryQuestionBank({
      now: () => '2026-08-01T00:00:00.000Z',
    })
    const plan = materializeTestPlan()
    const before = structuredClone(plan)

    const first = await bank.savePlan(plan, { signal: signal() })
    const second = await bank.savePlan(plan, { signal: signal() })
    const firstQuestions = first.sections[0]!.questions
    const secondQuestions = second.sections[0]!.questions

    expect(await bank.count({ signal: signal() })).toBe(5)
    expect(secondQuestions.map(question => question.bankQuestionId))
      .toEqual(firstQuestions.map(question => question.bankQuestionId))
    expect(plan).toEqual(before)
    expect(firstQuestions.every(question => question.bankQuestionId))
      .toBe(true)
  })

  test('相同身份保留首次保存的答案、解释和来源', async () => {
    const bank = new InMemoryQuestionBank()
    const firstPlan = materializeTestPlan()
    const first = await bank.savePlan(firstPlan, { signal: signal() })
    const firstPlanQuestions = firstPlan.sections[0]!.questions
    const changedPrivateFields = {
      ...firstPlan,
      sections: firstPlan.sections.map(section => ({
        ...section,
        questions: section.questions.map((question, index) => (
          index === 0
            ? {
                ...question,
                explanation: '不应覆盖首次保存的解释。',
                sourceChunkIds: ['new-source'],
              }
            : question
        )),
      })),
    }

    await bank.savePlan(changedPrivateFields, { signal: signal() })
    const stored = await bank.findById(
      first.sections[0]!.questions[0]!.bankQuestionId!,
      { signal: signal() },
    )

    expect(stored?.explanation).toBe(firstPlanQuestions[0]!.explanation)
    expect(stored?.sourceChunkIds).toEqual(
      firstPlanQuestions[0]!.sourceChunkIds,
    )
  })

  test('只返回匹配难度和知识点的有界题干', async () => {
    const bank = new InMemoryQuestionBank()
    const plan = materializeTestPlan()
    await bank.savePlan(plan, { signal: signal() })

    const stems = await bank.findRecentStems({
      difficulty: QuizDifficulty.Foundation,
      knowledgePoints: [' LangGraph '],
      limit: 1,
      signal: signal(),
    })
    const noAdvanced = await bank.findRecentStems({
      difficulty: QuizDifficulty.Advanced,
      knowledgePoints: [],
      limit: 30,
      signal: signal(),
    })

    expect(stems).toEqual([plan.sections[0]!.questions[0]!.stem])
    expect(noAdvanced).toEqual([])
  })

  test('已取消的 Signal 不执行读写', async () => {
    const bank = new InMemoryQuestionBank()
    const controller = new AbortController()
    controller.abort()

    await expect(bank.savePlan(materializeTestPlan(), {
      signal: controller.signal,
    })).rejects.toThrow()
    await expect(bank.findRecentStems({
      difficulty: QuizDifficulty.Foundation,
      knowledgePoints: [],
      limit: 30,
      signal: controller.signal,
    })).rejects.toThrow()
    expect(await bank.count({ signal: signal() })).toBe(0)
  })
})

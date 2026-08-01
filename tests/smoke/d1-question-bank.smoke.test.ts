import process from 'node:process'
import { expect, test } from 'bun:test'
import {
  createCloudflareD1QuestionBankFromEnv,
} from '@/agent/interview-quiz/question-bank/cloudflare-d1-question-bank'
import { materializeTestPlan } from '../helpers/quiz'

const requiredEnvironment = [
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_D1_DATABASE_ID',
] as const

function requireQuestionBank() {
  const missing = requiredEnvironment.filter(name => !process.env[name]?.trim())
  if (missing.length > 0) {
    throw new Error(
      `D1 QuestionBank smoke test requires: ${missing.join(', ')}`,
    )
  }

  const questionBank = createCloudflareD1QuestionBankFromEnv(process.env)
  if (!questionBank)
    throw new Error('Expected configured D1 QuestionBank.')
  return questionBank
}

test('真实 D1 重复保存同一 Plan 仍只有五个新 ID', async () => {
  const questionBank = requireQuestionBank()
  const signal = new AbortController().signal
  await questionBank.initialize({ signal })

  const marker = crypto.randomUUID()
  const basePlan = materializeTestPlan({ threadId: `d1-smoke-${marker}` })
  const plan = {
    ...basePlan,
    questions: basePlan.questions.map(question => ({
      ...question,
      // 唯一标记只放内部分类，不污染用户可见题干。
      topic: `smoke:${marker}:${question.topic}`,
      // Fake Fixture 的轮次前缀也不是正式题干的一部分。
      stem: question.stem.replace(/^第 \d+ 轮：/, ''),
    })),
  }
  const before = await questionBank.count({ signal })
  const first = await questionBank.savePlan(plan, { signal })
  const afterFirst = await questionBank.count({ signal })
  const second = await questionBank.savePlan(plan, { signal })
  const afterSecond = await questionBank.count({ signal })

  expect(afterFirst).toBe(before + 5)
  expect(afterSecond).toBe(afterFirst)
  expect(second.questions.map(question => question.bankQuestionId))
    .toEqual(first.questions.map(question => question.bankQuestionId))

  const stored = await questionBank.findById(
    first.questions[0]!.bankQuestionId!,
    { signal },
  )
  expect(stored?.stem).toBe(plan.questions[0]!.stem)
  expect(stored?.stem).not.toContain('[smoke:')
  expect(stored?.stem).not.toMatch(/^第 \d+ 轮：/)
}, 60_000)

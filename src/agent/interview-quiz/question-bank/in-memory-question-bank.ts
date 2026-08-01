import type {
  FindRecentStemsInput,
  QuestionBank,
  StoredQuizQuestion,
} from './contracts'
import type { QuizRoundPlan } from '@/agent/interview-quiz/contracts'
import {
  createStoredQuizQuestion,
  normalizeQuestionIdentityText,
} from './fingerprint'

/** 默认测试和无 D1 配置时的进程内降级；不是跨进程持久化。 */
export class InMemoryQuestionBank implements QuestionBank {
  private readonly rowsByFingerprint = new Map<string, StoredQuizQuestion>()
  private readonly now: () => string

  constructor(options: { now?: () => string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async savePlan(
    plan: QuizRoundPlan,
    options: { signal: AbortSignal },
  ): Promise<QuizRoundPlan> {
    const createdAt = this.now()
    const candidates = plan.questions.map((question) => {
      options.signal.throwIfAborted()
      return createStoredQuizQuestion({
        difficulty: plan.difficulty,
        question,
        createdAt,
      })
    })

    // 先完成所有纯计算，再写 Map，避免计算中断留下半轮数据。
    for (const candidate of candidates) {
      if (!this.rowsByFingerprint.has(candidate.contentFingerprint)) {
        this.rowsByFingerprint.set(
          candidate.contentFingerprint,
          structuredClone(candidate),
        )
      }
    }

    return {
      ...plan,
      questions: plan.questions.map((question, index) => ({
        ...question,
        bankQuestionId: candidates[index]!.bankQuestionId,
      })),
    }
  }

  async findRecentStems(input: FindRecentStemsInput): Promise<string[]> {
    input.signal.throwIfAborted()
    const limit = Math.min(Math.max(Math.trunc(input.limit), 0), 100)
    if (limit === 0)
      return []

    const knowledgePoints = new Set(
      input.knowledgePoints.map(normalizeQuestionIdentityText),
    )

    return [...this.rowsByFingerprint.values()]
      .filter(row => row.difficulty === input.difficulty)
      .filter(row => (
        knowledgePoints.size === 0
        || knowledgePoints.has(
          normalizeQuestionIdentityText(row.knowledgePoint),
        )
      ))
      .sort((left, right) => (
        right.createdAt.localeCompare(left.createdAt)
        || left.bankQuestionId.localeCompare(right.bankQuestionId)
      ))
      .slice(0, limit)
      .map(row => row.stem)
  }

  async findById(
    bankQuestionId: string,
    options: { signal: AbortSignal },
  ): Promise<StoredQuizQuestion | undefined> {
    options.signal.throwIfAborted()
    const row = [...this.rowsByFingerprint.values()]
      .find(candidate => candidate.bankQuestionId === bankQuestionId)
    return row ? structuredClone(row) : undefined
  }

  async count(options: { signal: AbortSignal }): Promise<number> {
    options.signal.throwIfAborted()
    return this.rowsByFingerprint.size
  }
}

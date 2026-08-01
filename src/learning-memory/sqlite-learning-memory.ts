import type { Database } from 'bun:sqlite'
import type {
  LearningMemory,
  LearningMemoryContext,
  RoundAttemptInput,
  TopicMastery,
} from './contracts'

const MAX_WEAK_KNOWLEDGE_POINTS = 8
const WEAK_MASTERY_THRESHOLD = 0.8

export enum LearningMemoryInputErrorCode {
  InvalidIdentity = 'invalid_learning_memory_identity',
  InvalidRound = 'invalid_learning_memory_round',
  InconsistentQuestionCount = 'inconsistent_question_count',
  InconsistentCorrectCount = 'inconsistent_correct_count',
  DuplicateQuestionId = 'duplicate_question_id',
  MissingQuestionReference = 'missing_question_reference',
}

/** Adapter 边界只暴露稳定输入错误，不携带 SQL 或本地路径。 */
export class LearningMemoryInputError extends Error {
  constructor(readonly code: LearningMemoryInputErrorCode) {
    super(code)
    this.name = 'LearningMemoryInputError'
  }
}

interface TopicMasteryRow {
  knowledge_point: string
  attempts: number
  correct: number
}

/**
 * attemptId 是一次作答的幂等身份，不是题目内容 Fingerprint。
 * learnerId 明确进入身份，避免同一 thread/round 被错误换绑给其他学习者。
 */
export function buildAttemptId(input: Pick<
  RoundAttemptInput,
  'learnerId' | 'threadId' | 'round'
>): string {
  return `${input.learnerId}:${input.threadId}:round:${input.round}:attempt`
}

function validateRoundAttempt(input: RoundAttemptInput): void {
  if (!input.learnerId.trim() || !input.threadId.trim()) {
    throw new LearningMemoryInputError(
      LearningMemoryInputErrorCode.InvalidIdentity,
    )
  }
  if (!Number.isInteger(input.round) || input.round < 1) {
    throw new LearningMemoryInputError(
      LearningMemoryInputErrorCode.InvalidRound,
    )
  }
  if (input.total !== input.questions.length || input.total < 1) {
    throw new LearningMemoryInputError(
      LearningMemoryInputErrorCode.InconsistentQuestionCount,
    )
  }

  const correctCount = input.questions.filter(question => question.isCorrect)
    .length
  if (input.correctCount !== correctCount) {
    throw new LearningMemoryInputError(
      LearningMemoryInputErrorCode.InconsistentCorrectCount,
    )
  }

  const questionIds = new Set<string>()
  for (const question of input.questions) {
    if (questionIds.has(question.questionId)) {
      throw new LearningMemoryInputError(
        LearningMemoryInputErrorCode.DuplicateQuestionId,
      )
    }
    if (
      !question.questionId.trim()
      || !question.bankQuestionId.trim()
      || !question.knowledgePoint.trim()
    ) {
      throw new LearningMemoryInputError(
        LearningMemoryInputErrorCode.MissingQuestionReference,
      )
    }
    questionIds.add(question.questionId)
  }
}

/**
 * SQLite 保存作答事实；TopicMastery 始终查询时聚合。
 * Database 由 Composition Root 或测试创建，便于明确控制文件和生命周期。
 */
export class SqliteLearningMemory implements LearningMemory {
  constructor(private readonly database: Database) {
    this.database.exec('PRAGMA foreign_keys = ON')
    this.database.exec(`
CREATE TABLE IF NOT EXISTS quiz_round_attempts (
  attempt_id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  difficulty TEXT NOT NULL,
  correct_count INTEGER NOT NULL,
  total INTEGER NOT NULL,
  completed_at TEXT NOT NULL,
  UNIQUE (learner_id, thread_id, round)
);

CREATE TABLE IF NOT EXISTS quiz_question_attempts (
  attempt_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  bank_question_id TEXT NOT NULL,
  knowledge_point TEXT NOT NULL,
  selected_option_ids_json TEXT NOT NULL,
  is_correct INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
  PRIMARY KEY (attempt_id, question_id),
  FOREIGN KEY (attempt_id)
    REFERENCES quiz_round_attempts(attempt_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_round_attempts_learner
  ON quiz_round_attempts(learner_id);

CREATE INDEX IF NOT EXISTS idx_question_attempts_knowledge
  ON quiz_question_attempts(knowledge_point);
    `)
  }

  async recordRound(
    input: RoundAttemptInput,
    options: { signal: AbortSignal },
  ): Promise<{ inserted: boolean }> {
    options.signal.throwIfAborted()
    validateRoundAttempt(input)

    const attemptId = buildAttemptId(input)
    const existingStatement = this.database.prepare(
      'SELECT attempt_id FROM quiz_round_attempts WHERE attempt_id = ? LIMIT 1',
    )
    const insertRoundStatement = this.database.prepare(`
INSERT INTO quiz_round_attempts (
  attempt_id, learner_id, thread_id, round, difficulty,
  correct_count, total, completed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertQuestionStatement = this.database.prepare(`
INSERT INTO quiz_question_attempts (
  attempt_id, question_id, bank_question_id, knowledge_point,
  selected_option_ids_json, is_correct
) VALUES (?, ?, ?, ?, ?, ?)
    `)

    const transaction = this.database.transaction(() => {
      options.signal.throwIfAborted()
      if (existingStatement.get(attemptId))
        return false

      insertRoundStatement.run(
        attemptId,
        input.learnerId,
        input.threadId,
        input.round,
        input.difficulty,
        input.correctCount,
        input.total,
        input.completedAt,
      )

      for (const question of input.questions) {
        options.signal.throwIfAborted()
        insertQuestionStatement.run(
          attemptId,
          question.questionId,
          question.bankQuestionId,
          question.knowledgePoint,
          JSON.stringify([...question.selectedOptionIds].sort()),
          question.isCorrect ? 1 : 0,
        )
      }
      return true
    })

    return { inserted: transaction.immediate() }
  }

  async listTopicMastery(
    learnerId: string,
    options: { signal: AbortSignal },
  ): Promise<TopicMastery[]> {
    options.signal.throwIfAborted()
    if (!learnerId.trim()) {
      throw new LearningMemoryInputError(
        LearningMemoryInputErrorCode.InvalidIdentity,
      )
    }

    const rows = this.database.query(`
SELECT
  q.knowledge_point,
  COUNT(*) AS attempts,
  SUM(q.is_correct) AS correct
FROM quiz_question_attempts q
JOIN quiz_round_attempts r
  ON r.attempt_id = q.attempt_id
WHERE r.learner_id = ?
GROUP BY q.knowledge_point
    `).all(learnerId) as TopicMasteryRow[]

    options.signal.throwIfAborted()
    return rows
      .map(row => ({
        knowledgePoint: row.knowledge_point,
        attempts: row.attempts,
        correct: row.correct,
        masteryScore: row.correct / row.attempts,
      }))
      .sort((left, right) => (
        left.masteryScore - right.masteryScore
        || right.attempts - left.attempts
        || left.knowledgePoint.localeCompare(right.knowledgePoint)
      ))
  }

  async loadContext(
    learnerId: string,
    options: { signal: AbortSignal },
  ): Promise<LearningMemoryContext> {
    const mastery = await this.listTopicMastery(learnerId, options)
    return {
      weakKnowledgePoints: mastery
        .filter(topic => topic.masteryScore < WEAK_MASTERY_THRESHOLD)
        .slice(0, MAX_WEAK_KNOWLEDGE_POINTS)
        .map(topic => topic.knowledgePoint),
    }
  }
}

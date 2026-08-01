import type { RoundAttemptInput } from '@/learning-memory/contracts'
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { QuizDifficulty } from '@/agent/interview-quiz/contracts'
import {
  buildAttemptId,
  LearningMemoryInputError,
  LearningMemoryInputErrorCode,
  SqliteLearningMemory,
} from '@/learning-memory/sqlite-learning-memory'

const signal = new AbortController().signal

function attempt(input: Partial<RoundAttemptInput> = {}): RoundAttemptInput {
  const questions = [
    ['question-1', 'StateGraph', false, ['B']],
    ['question-2', 'Tool Calling', true, ['B', 'A']],
    ['question-3', 'StateGraph', true, ['A']],
    ['question-4', 'Context', false, ['C']],
    ['question-5', 'Memory', true, ['A']],
  ].map(([questionId, knowledgePoint, isCorrect, selectedOptionIds]) => ({
    questionId: questionId as string,
    bankQuestionId: `bank:${questionId}`,
    knowledgePoint: knowledgePoint as string,
    selectedOptionIds: selectedOptionIds as string[],
    isCorrect: isCorrect as boolean,
  }))

  return {
    learnerId: '00000000-0000-4000-8000-000000000001',
    threadId: 'thread-A',
    round: 1,
    difficulty: QuizDifficulty.Foundation,
    correctCount: 3,
    total: 5,
    completedAt: '2026-08-01T00:00:00.000Z',
    questions,
    ...input,
  }
}

function countRows(database: Database, table: string): number {
  const row = database.query(`SELECT COUNT(*) AS count FROM ${table}`)
    .get() as { count: number }
  return row.count
}

describe('SqliteLearningMemory', () => {
  test('一轮原子写入五题，相同 attempt 重放不会重复计分', async () => {
    const database = new Database(':memory:')
    const memory = new SqliteLearningMemory(database)

    try {
      expect(buildAttemptId(attempt())).toBe(
        '00000000-0000-4000-8000-000000000001:thread-A:round:1:attempt',
      )
      expect(await memory.recordRound(attempt(), { signal }))
        .toEqual({ inserted: true })
      expect(await memory.recordRound(attempt(), { signal }))
        .toEqual({ inserted: false })

      expect(countRows(database, 'quiz_round_attempts')).toBe(1)
      expect(countRows(database, 'quiz_question_attempts')).toBe(5)
      expect(database.query(`
SELECT selected_option_ids_json
FROM quiz_question_attempts
WHERE question_id = 'question-2'
      `).get()).toEqual({ selected_option_ids_json: '["A","B"]' })
    }
    finally {
      database.close()
    }
  })

  test('按 learner 隔离并从全部事实聚合有界薄弱点', async () => {
    const database = new Database(':memory:')
    const memory = new SqliteLearningMemory(database)

    try {
      await memory.recordRound(attempt(), { signal })
      await memory.recordRound(attempt({
        learnerId: '00000000-0000-4000-8000-000000000002',
        threadId: 'thread-B',
        questions: attempt().questions.map(question => ({
          ...question,
          isCorrect: true,
        })),
        correctCount: 5,
      }), { signal })

      expect(await memory.listTopicMastery(
        '00000000-0000-4000-8000-000000000001',
        { signal },
      )).toEqual([
        {
          knowledgePoint: 'Context',
          attempts: 1,
          correct: 0,
          masteryScore: 0,
        },
        {
          knowledgePoint: 'StateGraph',
          attempts: 2,
          correct: 1,
          masteryScore: 0.5,
        },
        {
          knowledgePoint: 'Memory',
          attempts: 1,
          correct: 1,
          masteryScore: 1,
        },
        {
          knowledgePoint: 'Tool Calling',
          attempts: 1,
          correct: 1,
          masteryScore: 1,
        },
      ])
      expect(await memory.loadContext(
        '00000000-0000-4000-8000-000000000001',
        { signal },
      )).toEqual({ weakKnowledgePoints: ['Context', 'StateGraph'] })
      expect(await memory.loadContext(
        '00000000-0000-4000-8000-000000000002',
        { signal },
      )).toEqual({ weakKnowledgePoints: [] })
    }
    finally {
      database.close()
    }
  })

  test('不一致输入在事务前失败且不会留下记录', async () => {
    const database = new Database(':memory:')
    const memory = new SqliteLearningMemory(database)

    try {
      const invalid = attempt({
        questions: attempt().questions.map((question, index) => (
          index === 0 ? { ...question, bankQuestionId: '' } : question
        )),
      })

      await expect(memory.recordRound(invalid, { signal })).rejects.toEqual(
        new LearningMemoryInputError(
          LearningMemoryInputErrorCode.MissingQuestionReference,
        ),
      )
      expect(countRows(database, 'quiz_round_attempts')).toBe(0)
      expect(countRows(database, 'quiz_question_attempts')).toBe(0)
    }
    finally {
      database.close()
    }
  })

  test('第三道题 SQL 失败时整轮回滚', async () => {
    const database = new Database(':memory:')
    const memory = new SqliteLearningMemory(database)
    database.exec(`
CREATE TRIGGER fail_third_question
BEFORE INSERT ON quiz_question_attempts
WHEN NEW.question_id = 'question-3'
BEGIN
  SELECT RAISE(ABORT, 'forced test failure');
END;
    `)

    try {
      await expect(memory.recordRound(attempt(), { signal })).rejects.toThrow()
      expect(countRows(database, 'quiz_round_attempts')).toBe(0)
      expect(countRows(database, 'quiz_question_attempts')).toBe(0)
    }
    finally {
      database.close()
    }
  })

  test('调用前已取消时不写入任何记录', async () => {
    const database = new Database(':memory:')
    const memory = new SqliteLearningMemory(database)
    const controller = new AbortController()
    controller.abort()

    try {
      await expect(memory.recordRound(attempt(), {
        signal: controller.signal,
      })).rejects.toThrow()
      expect(countRows(database, 'quiz_round_attempts')).toBe(0)
      expect(countRows(database, 'quiz_question_attempts')).toBe(0)
    }
    finally {
      database.close()
    }
  })
})

import type {
  FindRecentStemsInput,
  QuestionBank,
  StoredQuizQuestion,
} from './contracts'
import type { QuizRoundPlan } from '@/agent/interview-quiz/contracts'
import type { FetchLike } from '@/knowledge/cloudflare-ai-search'
import process from 'node:process'
import { z } from 'zod/v4'
import {
  QuestionType,
  QuizDifficulty,
  QuizOptionSchema,
} from '@/agent/interview-quiz/contracts'
import {
  createStoredQuizQuestion,
  normalizeQuestionIdentityText,
} from './fingerprint'

export enum CloudflareD1QuestionBankErrorCode {
  RequestFailed = 'cloudflare_d1_question_bank_request_failed',
  InvalidResponse = 'cloudflare_d1_question_bank_invalid_response',
}

/** Adapter 只暴露稳定错误，不把 Cloudflare 响应正文、SQL 或 Token 带出去。 */
export class CloudflareD1QuestionBankError extends Error {
  constructor(
    readonly code: CloudflareD1QuestionBankErrorCode,
    readonly status?: number,
  ) {
    super(code === CloudflareD1QuestionBankErrorCode.RequestFailed
      ? 'Cloudflare D1 question bank request failed.'
      : 'Cloudflare D1 question bank returned an invalid response.')
    this.name = 'CloudflareD1QuestionBankError'
  }
}

export interface CloudflareD1QuestionBankOptions {
  queryUrl: string
  apiToken: string
  fetch?: FetchLike
  now?: () => string
}

const D1StatementResultSchema = z.object({
  success: z.boolean(),
  results: z.array(z.record(z.string(), z.unknown())).optional(),
})

const D1ResponseSchema = z.object({
  success: z.boolean(),
  result: z.array(z.unknown()).optional(),
})

const StoredQuestionRowSchema = z.object({
  bank_question_id: z.string().min(1),
  content_fingerprint: z.string().min(1),
  difficulty: z.enum(QuizDifficulty),
  question_type: z.enum(QuestionType),
  topic: z.string(),
  knowledge_point: z.string(),
  stem: z.string(),
  options_json: z.string(),
  correct_option_ids_json: z.string(),
  explanation: z.string(),
  source_chunk_ids_json: z.string(),
  created_at: z.string(),
})

const CountRowSchema = z.object({
  count: z.union([z.number(), z.string()]).transform(Number),
})

const StemRowSchema = z.object({
  stem: z.string(),
})

const CorrectOptionIdsSchema = z.array(z.string().regex(/^[A-F]$/))
const SourceChunkIdsSchema = z.array(z.string())

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS question_bank (
  bank_question_id TEXT PRIMARY KEY,
  content_fingerprint TEXT NOT NULL UNIQUE,
  difficulty TEXT NOT NULL,
  question_type TEXT NOT NULL,
  topic TEXT NOT NULL,
  knowledge_point TEXT NOT NULL,
  stem TEXT NOT NULL,
  options_json TEXT NOT NULL,
  correct_option_ids_json TEXT NOT NULL,
  explanation TEXT NOT NULL,
  source_chunk_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
)
`.trim()

const CREATE_RECENT_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_question_bank_recent
ON question_bank(difficulty, knowledge_point, created_at DESC)
`.trim()

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    throw new CloudflareD1QuestionBankError(
      CloudflareD1QuestionBankErrorCode.InvalidResponse,
    )
  }
}

function parseStoredQuestion(value: unknown): StoredQuizQuestion {
  const row = StoredQuestionRowSchema.safeParse(value)
  if (!row.success) {
    throw new CloudflareD1QuestionBankError(
      CloudflareD1QuestionBankErrorCode.InvalidResponse,
    )
  }

  const options = z.array(QuizOptionSchema).safeParse(
    parseJson(row.data.options_json),
  )
  const correctOptionIds = CorrectOptionIdsSchema.safeParse(
    parseJson(row.data.correct_option_ids_json),
  )
  const sourceChunkIds = SourceChunkIdsSchema.safeParse(
    parseJson(row.data.source_chunk_ids_json),
  )
  if (!options.success || !correctOptionIds.success || !sourceChunkIds.success) {
    throw new CloudflareD1QuestionBankError(
      CloudflareD1QuestionBankErrorCode.InvalidResponse,
    )
  }

  return {
    bankQuestionId: row.data.bank_question_id,
    contentFingerprint: row.data.content_fingerprint,
    difficulty: row.data.difficulty,
    type: row.data.question_type,
    topic: row.data.topic,
    knowledgePoint: row.data.knowledge_point,
    stem: row.data.stem,
    options: options.data,
    correctOptionIds: correctOptionIds.data,
    explanation: row.data.explanation,
    sourceChunkIds: sourceChunkIds.data,
    createdAt: row.data.created_at,
  }
}

/** Bun/Hono 通过 D1 REST Query API 使用的正式 QuestionBank Adapter。 */
export class CloudflareD1QuestionBank implements QuestionBank {
  private readonly request: FetchLike
  private readonly now: () => string

  constructor(private readonly options: CloudflareD1QuestionBankOptions) {
    this.request = options.fetch ?? globalThis.fetch
    this.now = options.now ?? (() => new Date().toISOString())
  }

  private async query(
    sql: string,
    params: unknown[],
    options: { signal: AbortSignal },
  ): Promise<Array<Record<string, unknown>>> {
    options.signal.throwIfAborted()

    let response: Response
    try {
      response = await this.request(this.options.queryUrl, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${this.options.apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sql, params }),
        signal: options.signal,
      })
    }
    catch {
      if (options.signal.aborted)
        options.signal.throwIfAborted()
      throw new CloudflareD1QuestionBankError(
        CloudflareD1QuestionBankErrorCode.RequestFailed,
      )
    }

    if (!response.ok) {
      throw new CloudflareD1QuestionBankError(
        CloudflareD1QuestionBankErrorCode.RequestFailed,
        response.status,
      )
    }

    let body: unknown
    try {
      body = await response.json()
    }
    catch {
      throw new CloudflareD1QuestionBankError(
        CloudflareD1QuestionBankErrorCode.InvalidResponse,
        response.status,
      )
    }

    const parsed = D1ResponseSchema.safeParse(body)
    if (!parsed.success || !parsed.data.success || !parsed.data.result?.length) {
      throw new CloudflareD1QuestionBankError(
        CloudflareD1QuestionBankErrorCode.InvalidResponse,
        response.status,
      )
    }

    const rows: Array<Record<string, unknown>> = []
    for (const rawResult of parsed.data.result) {
      const result = D1StatementResultSchema.safeParse(rawResult)
      if (!result.success || !result.data.success) {
        throw new CloudflareD1QuestionBankError(
          CloudflareD1QuestionBankErrorCode.InvalidResponse,
          response.status,
        )
      }
      rows.push(...(result.data.results ?? []))
    }
    return rows
  }

  async initialize(options: { signal: AbortSignal }): Promise<void> {
    await this.query(CREATE_TABLE_SQL, [], options)
    await this.query(CREATE_RECENT_INDEX_SQL, [], options)
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

    if (candidates.length > 0) {
      const columnsPerRow = 12
      const placeholders = candidates
        .map(() => `(${Array.from({ length: columnsPerRow }).fill('?').join(', ')})`)
        .join(', ')
      const sql = `
INSERT OR IGNORE INTO question_bank (
  bank_question_id,
  content_fingerprint,
  difficulty,
  question_type,
  topic,
  knowledge_point,
  stem,
  options_json,
  correct_option_ids_json,
  explanation,
  source_chunk_ids_json,
  created_at
)
VALUES ${placeholders}
      `.trim()
      const params = candidates.flatMap(question => [
        question.bankQuestionId,
        question.contentFingerprint,
        question.difficulty,
        question.type,
        question.topic,
        question.knowledgePoint,
        question.stem,
        JSON.stringify(question.options),
        JSON.stringify(question.correctOptionIds),
        question.explanation,
        JSON.stringify(question.sourceChunkIds),
        question.createdAt,
      ])

      await this.query(sql, params, options)
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

    const knowledgePoints = [...new Set(
      input.knowledgePoints.map(normalizeQuestionIdentityText),
    )]
    const knowledgeFilter = knowledgePoints.length > 0
      ? ` AND LOWER(TRIM(knowledge_point)) IN (${knowledgePoints.map(() => '?').join(', ')})`
      : ''
    const rows = await this.query(
      `SELECT stem FROM question_bank
       WHERE difficulty = ?${knowledgeFilter}
       ORDER BY created_at DESC, bank_question_id ASC
       LIMIT ?`,
      [input.difficulty, ...knowledgePoints, limit],
      input,
    )

    return rows.map((value) => {
      const row = StemRowSchema.safeParse(value)
      if (!row.success) {
        throw new CloudflareD1QuestionBankError(
          CloudflareD1QuestionBankErrorCode.InvalidResponse,
        )
      }
      return row.data.stem
    })
  }

  async findById(
    bankQuestionId: string,
    options: { signal: AbortSignal },
  ): Promise<StoredQuizQuestion | undefined> {
    const rows = await this.query(
      `SELECT * FROM question_bank WHERE bank_question_id = ? LIMIT 1`,
      [bankQuestionId],
      options,
    )
    return rows[0] ? parseStoredQuestion(rows[0]) : undefined
  }

  async count(options: { signal: AbortSignal }): Promise<number> {
    const rows = await this.query(
      `SELECT COUNT(*) AS count FROM question_bank`,
      [],
      options,
    )
    const count = CountRowSchema.safeParse(rows[0])
    if (!count.success || !Number.isSafeInteger(count.data.count)) {
      throw new CloudflareD1QuestionBankError(
        CloudflareD1QuestionBankErrorCode.InvalidResponse,
      )
    }
    return count.data.count
  }
}

/** 配置不完整时返回 undefined，让 Composition Root 使用 InMemory 降级。 */
export function createCloudflareD1QuestionBankFromEnv(
  env: Record<string, string | undefined> = process.env,
  request: FetchLike = globalThis.fetch,
): CloudflareD1QuestionBank | undefined {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
  const databaseId = env.CLOUDFLARE_D1_DATABASE_ID?.trim()
  if (!accountId || !apiToken || !databaseId)
    return undefined

  return new CloudflareD1QuestionBank({
    queryUrl: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
    apiToken,
    fetch: request,
  })
}

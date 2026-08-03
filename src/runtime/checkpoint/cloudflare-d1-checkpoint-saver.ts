import type { RunnableConfig } from '@langchain/core/runnables'
import type {
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
} from '@langchain/langgraph-checkpoint'
import type { FetchLike } from '@/knowledge/cloudflare-ai-search'
import process from 'node:process'
import {
  BaseCheckpointSaver,
  copyCheckpoint,
} from '@langchain/langgraph'
import { z } from 'zod'
import {
  createTimeoutSignal,
  DEFAULT_CLOUDFLARE_REQUEST_TIMEOUT_MS,
  waitForSignal,
} from '@/runtime/reliability/request-timeout'

/** D1 Checkpointer 只暴露稳定错误，不把 SQL、响应正文或 Token 带给上层。 */
export enum CloudflareD1CheckpointErrorCode {
  RequestFailed = 'cloudflare_d1_checkpoint_request_failed',
  RequestTimeout = 'cloudflare_d1_checkpoint_request_timeout',
  InvalidResponse = 'cloudflare_d1_checkpoint_invalid_response',
  MissingThreadId = 'cloudflare_d1_checkpoint_missing_thread_id',
  InvalidConfig = 'cloudflare_d1_checkpoint_invalid_config',
}

export class CloudflareD1CheckpointError extends Error {
  constructor(
    readonly code: CloudflareD1CheckpointErrorCode,
    readonly status?: number,
  ) {
    super(code === CloudflareD1CheckpointErrorCode.RequestTimeout
      ? 'Cloudflare D1 checkpoint request timed out.'
      : code === CloudflareD1CheckpointErrorCode.RequestFailed
        ? 'Cloudflare D1 checkpoint request failed.'
        : code === CloudflareD1CheckpointErrorCode.MissingThreadId
          ? 'Cloudflare D1 checkpoint requires a thread id.'
          : code === CloudflareD1CheckpointErrorCode.InvalidConfig
            ? 'Cloudflare D1 checkpoint configuration is invalid.'
            : 'Cloudflare D1 checkpoint returned an invalid response.')
    this.name = 'CloudflareD1CheckpointError'
  }
}

export interface CloudflareD1CheckpointSaverOptions {
  queryUrl: string
  apiToken: string
  fetch?: FetchLike
  timeoutMs?: number
}

const D1StatementResultSchema = z.object({
  success: z.boolean(),
  results: z.array(z.record(z.string(), z.unknown())).optional(),
})

const D1ResponseSchema = z.object({
  success: z.boolean(),
  result: z.array(z.unknown()).optional(),
})

const CheckpointRowSchema = z.object({
  thread_id: z.string().min(1),
  checkpoint_ns: z.string(),
  checkpoint_id: z.string().min(1),
  parent_checkpoint_id: z.string().nullable().optional(),
  checkpoint_type: z.string().min(1),
  checkpoint_blob: z.string(),
  metadata_type: z.string().min(1),
  metadata_blob: z.string(),
})

const WriteRowSchema = z.object({
  task_id: z.string().min(1),
  channel: z.string(),
  value_type: z.string().min(1),
  value_blob: z.string(),
})

export const CREATE_CHECKPOINT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  checkpoint_type TEXT NOT NULL,
  checkpoint_blob TEXT NOT NULL,
  metadata_type TEXT NOT NULL,
  metadata_blob TEXT NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
)
`.trim()

export const CREATE_CHECKPOINT_WRITES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS langgraph_checkpoint_writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  write_index INTEGER NOT NULL,
  channel TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value_blob TEXT NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, write_index)
)
`.trim()

export const CREATE_CHECKPOINT_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_langgraph_checkpoints_thread
ON langgraph_checkpoints(thread_id, checkpoint_ns, checkpoint_id DESC)
`.trim()

const SPECIAL_WRITE_INDEX: Record<string, number> = {
  __error__: -1,
  __scheduled__: -2,
  __interrupt__: -3,
  __resume__: -4,
}

interface StoredBlob {
  type: string
  data: string
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index)
  return bytes
}

function getCheckpointId(config: RunnableConfig): string | undefined {
  const configurable = config.configurable
  const value = configurable?.checkpoint_id ?? configurable?.thread_ts
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readThreadId(config: RunnableConfig, required: boolean): string | undefined {
  const value = config.configurable?.thread_id
  if (value === undefined && !required)
    return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CloudflareD1CheckpointError(
      CloudflareD1CheckpointErrorCode.MissingThreadId,
    )
  }
  return value
}

function readNamespace(config: RunnableConfig): string {
  const value = config.configurable?.checkpoint_ns ?? ''
  if (typeof value !== 'string') {
    throw new CloudflareD1CheckpointError(
      CloudflareD1CheckpointErrorCode.InvalidConfig,
    )
  }
  return value
}

/**
 * 只把序列化后的 bytes 作为 Base64 保存到 D1，恢复时仍交给 LangGraph
 * 自己的 serde。这样 Set、Map、Uint8Array 等 checkpoint 值不会被普通
 * JSON.stringify 悄悄改变形状。
 */
async function dumpBlob(
  saver: BaseCheckpointSaver,
  value: unknown,
): Promise<StoredBlob> {
  const [type, bytes] = await saver.serde.dumpsTyped(value)
  return { type, data: bytesToBase64(bytes) }
}

async function loadBlob(
  saver: BaseCheckpointSaver,
  blob: StoredBlob,
): Promise<unknown> {
  return saver.serde.loadsTyped(blob.type, base64ToBytes(blob.data))
}

/** Bun/Hono 通过 Cloudflare D1 REST Query API 使用的 LangGraph Saver。 */
export class CloudflareD1CheckpointSaver extends BaseCheckpointSaver {
  private readonly request: FetchLike

  constructor(private readonly options: CloudflareD1CheckpointSaverOptions) {
    super()
    this.request = options.fetch ?? globalThis.fetch
    if (!options.queryUrl.trim() || !options.apiToken.trim()) {
      throw new CloudflareD1CheckpointError(
        CloudflareD1CheckpointErrorCode.InvalidConfig,
      )
    }
  }

  private async query(
    sql: string,
    params: unknown[],
    parentSignal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    const timeout = createTimeoutSignal(
      parentSignal,
      this.options.timeoutMs ?? DEFAULT_CLOUDFLARE_REQUEST_TIMEOUT_MS,
    )

    try {
      const response = await waitForSignal(this.request(this.options.queryUrl, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${this.options.apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sql, params }),
        signal: timeout.signal,
      }), timeout.signal)

      if (!response.ok) {
        throw new CloudflareD1CheckpointError(
          CloudflareD1CheckpointErrorCode.RequestFailed,
          response.status,
        )
      }

      let body: unknown
      try {
        body = await waitForSignal(response.json(), timeout.signal)
      }
      catch {
        if (timeout.timedOut()) {
          throw new CloudflareD1CheckpointError(
            CloudflareD1CheckpointErrorCode.RequestTimeout,
          )
        }
        if (parentSignal?.aborted)
          parentSignal.throwIfAborted()
        throw new CloudflareD1CheckpointError(
          CloudflareD1CheckpointErrorCode.InvalidResponse,
          response.status,
        )
      }

      const parsed = D1ResponseSchema.safeParse(body)
      if (!parsed.success || !parsed.data.success || !parsed.data.result) {
        throw new CloudflareD1CheckpointError(
          CloudflareD1CheckpointErrorCode.InvalidResponse,
          response.status,
        )
      }

      const rows: Array<Record<string, unknown>> = []
      for (const rawResult of parsed.data.result) {
        const result = D1StatementResultSchema.safeParse(rawResult)
        if (!result.success || !result.data.success) {
          throw new CloudflareD1CheckpointError(
            CloudflareD1CheckpointErrorCode.InvalidResponse,
            response.status,
          )
        }
        rows.push(...(result.data.results ?? []))
      }
      return rows
    }
    catch (error) {
      if (error instanceof CloudflareD1CheckpointError)
        throw error
      if (timeout.timedOut()) {
        throw new CloudflareD1CheckpointError(
          CloudflareD1CheckpointErrorCode.RequestTimeout,
        )
      }
      if (parentSignal?.aborted)
        parentSignal.throwIfAborted()
      throw new CloudflareD1CheckpointError(
        CloudflareD1CheckpointErrorCode.RequestFailed,
      )
    }
    finally {
      timeout.dispose()
    }
  }

  async initialize(): Promise<void> {
    await this.query(CREATE_CHECKPOINT_TABLE_SQL, [])
    await this.query(CREATE_CHECKPOINT_WRITES_TABLE_SQL, [])
    await this.query(CREATE_CHECKPOINT_INDEX_SQL, [])
  }

  private async readWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
    signal?: AbortSignal,
  ): Promise<CheckpointTuple['pendingWrites']> {
    const rows = await this.query(
      `SELECT task_id, channel, value_type, value_blob
       FROM langgraph_checkpoint_writes
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
       ORDER BY task_id ASC, write_index ASC`,
      [threadId, checkpointNs, checkpointId],
      signal,
    )
    const writes: NonNullable<CheckpointTuple['pendingWrites']> = []
    for (const value of rows) {
      const row = WriteRowSchema.safeParse(value)
      if (!row.success) {
        throw new CloudflareD1CheckpointError(
          CloudflareD1CheckpointErrorCode.InvalidResponse,
        )
      }
      writes.push([
        row.data.task_id,
        row.data.channel,
        await loadBlob(this, {
          type: row.data.value_type,
          data: row.data.value_blob,
        }),
      ])
    }
    return writes
  }

  private async toTuple(
    rowValue: unknown,
    signal?: AbortSignal,
  ): Promise<CheckpointTuple> {
    const row = CheckpointRowSchema.safeParse(rowValue)
    if (!row.success) {
      throw new CloudflareD1CheckpointError(
        CloudflareD1CheckpointErrorCode.InvalidResponse,
      )
    }

    const checkpoint = await loadBlob(this, {
      type: row.data.checkpoint_type,
      data: row.data.checkpoint_blob,
    }) as Checkpoint
    const metadata = await loadBlob(this, {
      type: row.data.metadata_type,
      data: row.data.metadata_blob,
    }) as CheckpointMetadata
    const config: RunnableConfig = {
      configurable: {
        thread_id: row.data.thread_id,
        checkpoint_ns: row.data.checkpoint_ns,
        checkpoint_id: row.data.checkpoint_id,
      },
    }
    const tuple: CheckpointTuple = {
      config,
      checkpoint,
      metadata,
      pendingWrites: await this.readWrites(
        row.data.thread_id,
        row.data.checkpoint_ns,
        row.data.checkpoint_id,
        signal,
      ),
    }
    if (row.data.parent_checkpoint_id) {
      tuple.parentConfig = {
        configurable: {
          thread_id: row.data.thread_id,
          checkpoint_ns: row.data.checkpoint_ns,
          checkpoint_id: row.data.parent_checkpoint_id,
        },
      }
    }
    return tuple
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = readThreadId(config, false)
    if (!threadId)
      return undefined
    const checkpointNs = readNamespace(config)
    const checkpointId = getCheckpointId(config)
    const rows = await this.query(
      checkpointId
        ? `SELECT * FROM langgraph_checkpoints
           WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
           LIMIT 1`
        : `SELECT * FROM langgraph_checkpoints
           WHERE thread_id = ? AND checkpoint_ns = ?
           ORDER BY checkpoint_id DESC LIMIT 1`,
      checkpointId
        ? [threadId, checkpointNs, checkpointId]
        : [threadId, checkpointNs],
      config.signal,
    )
    return rows[0] ? this.toTuple(rows[0], config.signal) : undefined
  }

  async* list(
    config: RunnableConfig,
    options: CheckpointListOptions = {},
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = readThreadId(config, false)
    const checkpointNs = config.configurable?.checkpoint_ns === undefined
      ? undefined
      : readNamespace(config)
    const checkpointId = getCheckpointId(config)
    const beforeId = getCheckpointId(options.before ?? {})
    const params: unknown[] = []
    const where: string[] = []
    if (threadId) {
      where.push('thread_id = ?')
      params.push(threadId)
    }
    if (checkpointNs !== undefined) {
      where.push('checkpoint_ns = ?')
      params.push(checkpointNs)
    }
    if (checkpointId) {
      where.push('checkpoint_id = ?')
      params.push(checkpointId)
    }
    if (beforeId) {
      where.push('checkpoint_id < ?')
      params.push(beforeId)
    }
    const rows = await this.query(
      `SELECT * FROM langgraph_checkpoints
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY checkpoint_id DESC${options.limit !== undefined ? ' LIMIT ?' : ''}`,
      options.limit !== undefined ? [...params, Math.max(0, options.limit)] : params,
      config.signal,
    )
    let yielded = 0
    for (const value of rows) {
      const tuple = await this.toTuple(value, config.signal)
      if (options.filter && !Object.entries(options.filter).every(([key, expected]) => (
        (tuple.metadata as Record<string, unknown> | undefined)?.[key] === expected
      ))) {
        continue
      }
      yield tuple
      yielded++
      if (options.limit !== undefined && yielded >= options.limit)
        break
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: Record<string, string | number>,
  ): Promise<RunnableConfig> {
    const threadId = readThreadId(config, true)!
    const checkpointNs = readNamespace(config)
    const checkpointId = checkpoint.id
    const checkpointBlob = await dumpBlob(this, copyCheckpoint(checkpoint))
    const metadataBlob = await dumpBlob(this, metadata)
    await this.query(
      `INSERT INTO langgraph_checkpoints (
        thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
        checkpoint_type, checkpoint_blob, metadata_type, metadata_blob
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET
        parent_checkpoint_id = excluded.parent_checkpoint_id,
        checkpoint_type = excluded.checkpoint_type,
        checkpoint_blob = excluded.checkpoint_blob,
        metadata_type = excluded.metadata_type,
        metadata_blob = excluded.metadata_blob`,
      [
        threadId,
        checkpointNs,
        checkpointId,
        getCheckpointId(config) ?? null,
        checkpointBlob.type,
        checkpointBlob.data,
        metadataBlob.type,
        metadataBlob.data,
      ],
      config.signal,
    )
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpointId,
      },
    }
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const threadId = readThreadId(config, true)!
    const checkpointNs = readNamespace(config)
    const checkpointId = getCheckpointId(config)
    if (!checkpointId) {
      throw new CloudflareD1CheckpointError(
        CloudflareD1CheckpointErrorCode.InvalidConfig,
      )
    }
    for (let index = 0; index < writes.length; index++) {
      const write = writes[index]
      if (!write)
        continue
      const [channel, value] = write
      const serialized = await dumpBlob(this, value)
      const writeIndex = SPECIAL_WRITE_INDEX[channel] ?? index
      await this.query(
        `INSERT OR IGNORE INTO langgraph_checkpoint_writes (
          thread_id, checkpoint_ns, checkpoint_id, task_id,
          write_index, channel, value_type, value_blob
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          writeIndex,
          channel,
          serialized.type,
          serialized.data,
        ],
        config.signal,
      )
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    if (!threadId.trim()) {
      throw new CloudflareD1CheckpointError(
        CloudflareD1CheckpointErrorCode.MissingThreadId,
      )
    }
    await this.query(
      'DELETE FROM langgraph_checkpoint_writes WHERE thread_id = ?',
      [threadId],
    )
    await this.query(
      'DELETE FROM langgraph_checkpoints WHERE thread_id = ?',
      [threadId],
    )
  }
}

/** 环境未配置完整时返回 undefined，让本地开发继续使用 MemorySaver。 */
export function createCloudflareD1CheckpointSaverFromEnv(
  env: Record<string, string | undefined> = process.env,
  request: FetchLike = globalThis.fetch,
): CloudflareD1CheckpointSaver | undefined {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
  const databaseId = env.CLOUDFLARE_D1_DATABASE_ID?.trim()
  if (!accountId || !apiToken || !databaseId)
    return undefined

  return new CloudflareD1CheckpointSaver({
    queryUrl: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
    apiToken,
    fetch: request,
  })
}

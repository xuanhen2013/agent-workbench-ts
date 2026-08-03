import type {
  KnowledgeFilter,
  KnowledgeSearchRetriever,
  RetrievedChunk,
} from './contracts'
import process from 'node:process'
import { z } from 'zod'
import {
  createTimeoutSignal,
  DEFAULT_CLOUDFLARE_REQUEST_TIMEOUT_MS,
  waitForSignal,
} from '@/runtime/reliability/request-timeout'
import {
  KnowledgeEvidenceRole,
  KnowledgeSourceType,
} from './contracts'

/** Cloudflare Adapter 自己的稳定错误码；不会把响应正文或 Token 写进错误。 */
export enum CloudflareAiSearchErrorCode {
  RequestFailed = 'cloudflare_ai_search_request_failed',
  RequestTimeout = 'cloudflare_ai_search_request_timeout',
  InvalidResponse = 'cloudflare_ai_search_invalid_response',
}

export class CloudflareAiSearchError extends Error {
  constructor(
    readonly code: CloudflareAiSearchErrorCode,
    readonly status?: number,
  ) {
    super(code === CloudflareAiSearchErrorCode.RequestTimeout
      ? 'Cloudflare AI Search request timed out.'
      : code === CloudflareAiSearchErrorCode.RequestFailed
        ? 'Cloudflare AI Search request failed.'
        : 'Cloudflare AI Search returned an invalid response.')
    this.name = 'CloudflareAiSearchError'
  }
}

/**
 * Adapter 最终只依赖一个 Search URL。
 * Composition Root 可以用 Account ID + Instance Name 生成官方 REST URL，
 * 也可以为公共端点或内部代理直接传入完整 URL。
 */
export interface CloudflareAiSearchRetrieverOptions {
  searchUrl: string
  apiToken?: string
  /** 当前 Retriever 允许读取的来源；会转换成服务端固定 Filter。 */
  sourceTypes: readonly KnowledgeSourceType[]
  /** 当前 Retriever 允许读取的唯一证据角色。 */
  evidenceRole: KnowledgeEvidenceRole
  fetch?: FetchLike
  timeoutMs?: number
}

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

interface CloudflareSearchChunk {
  id: string
  score: number
  text: string
  itemKey?: string
  metadata: Record<string, unknown>
}

const CloudflareSearchChunkSchema = z.object({
  id: z.string().min(1),
  score: z.number().finite().default(0),
  text: z.string(),
  item: z.object({
    key: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
})

const CloudflareSearchResponseSchema = z.object({
  success: z.boolean(),
  result: z.object({
    chunks: z.array(z.unknown()),
  }).optional(),
})

/**
 * 把 Cloudflare 的返回结构缩小成项目自己的 RetrievedChunk。
 * Graph 和 Planner 不应该依赖 Cloudflare 的 item/scoring_details 字段。
 */
function parseChunks(
  body: unknown,
): CloudflareSearchChunk[] {
  const response = CloudflareSearchResponseSchema.safeParse(body)
  if (!response.success || !response.data.success || !response.data.result) {
    throw new CloudflareAiSearchError(
      CloudflareAiSearchErrorCode.InvalidResponse,
    )
  }

  const chunks: CloudflareSearchChunk[] = []
  for (const rawChunk of response.data.result.chunks) {
    const chunk = CloudflareSearchChunkSchema.safeParse(rawChunk)
    if (!chunk.success)
      continue

    chunks.push({
      id: chunk.data.id,
      score: chunk.data.score,
      text: chunk.data.text,
      itemKey: chunk.data.item?.key,
      metadata: chunk.data.item?.metadata ?? {},
    })
  }

  return chunks
}

function filterContains<T>(values: readonly T[] | undefined, value: T) {
  return !values?.length || values.includes(value)
}

function resolveSourceTypes(
  filter: KnowledgeFilter | undefined,
  options: CloudflareAiSearchRetrieverOptions,
): KnowledgeSourceType[] {
  if (!filterContains(filter?.evidenceRoles, options.evidenceRole))
    return []

  return options.sourceTypes.filter(sourceType => (
    filterContains(filter?.sourceTypes, sourceType)
  ))
}

/**
 * KnowledgeFilter 使用项目自己的 documentId；Cloudflare Item Key 带目录，
 * Search Filter 则按内置 filename 精确匹配。只接受简单文件名，避免把任意
 * Filter 表达式从上层透传给远程服务。
 */
function resolveFilenames(filter: KnowledgeFilter | undefined) {
  if (!filter?.documentIds)
    return undefined

  const filenames = filter.documentIds
    .map(documentId => documentId.split('/').at(-1)?.trim())
    .filter((filename): filename is string => (
      typeof filename === 'string' && /^[\w.-]+$/.test(filename)
    ))

  return [...new Set(filenames)]
}

function metadataString(
  metadata: Record<string, unknown>,
  key: string,
) {
  const value = metadata[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

// 首次请求之外最多重试两次，对应 250ms、1000ms 两段退避。
const SEARCH_MAX_ATTEMPTS = 3
const SEARCH_INITIAL_RETRY_DELAY_MS = 250
const SEARCH_MAX_RETRY_DELAY_MS = 1_000

/**
 * Search 是只读操作，因此只重试“可能没有收到响应”的传输错误、408、429
 * 和 5xx。鉴权、参数、解析错误不能靠重试解决。
 */
function isRetryableSearchError(error: CloudflareAiSearchError) {
  // status 缺失只代表“没有收到 HTTP 响应”的 RequestFailed。
  // InvalidResponse 同样没有 status，但响应已经到达，重试无法修复解析问题。
  return error.code === CloudflareAiSearchErrorCode.RequestFailed
    && (error.status === undefined
      || error.status === 408
      || error.status === 429
      || error.status >= 500)
}

/** 可取消、会清理计时器的重试退避等待。 */
function sleepWithSignal(delayMs: number, signal: AbortSignal) {
  signal.throwIfAborted()

  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const onAbort = () => {
      if (timer)
        clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }

    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 同一个 AI Search 实例可以保存多类资料，但每个 Retriever 仍然只负责
 * 一个证据角色，并在服务端固定提交 evidence_role + source_type Filter。
 * 模型只能提供 query，不能改变信任边界或扩大检索范围。
 */
export class CloudflareAiSearchRetriever implements KnowledgeSearchRetriever {
  private readonly request: FetchLike

  constructor(private readonly options: CloudflareAiSearchRetrieverOptions) {
    this.request = options.fetch ?? globalThis.fetch
  }

  async search(input: {
    query: string
    limit: number
    filter?: KnowledgeFilter
    signal: AbortSignal
  }): Promise<RetrievedChunk[]> {
    input.signal.throwIfAborted()

    const sourceTypes = resolveSourceTypes(input.filter, this.options)
    // 如果 Graph 请求的是另一个角色或来源，不应访问远程实例。
    if (sourceTypes.length === 0)
      return []

    const filenames = resolveFilenames(input.filter)
    // 调用方明确指定 documentIds 却没有一个可安全转换时，必须返回空结果，
    // 不能静默退化为跨整个实例的语义搜索。
    if (filenames?.length === 0)
      return []

    // 一个总超时覆盖首次请求、两次重试和退避等待，避免“每次重试都重新获得 30 秒”。
    const timeout = createTimeoutSignal(
      input.signal,
      this.options.timeoutMs ?? DEFAULT_CLOUDFLARE_REQUEST_TIMEOUT_MS,
    )

    try {
      for (let attempt = 1; attempt <= SEARCH_MAX_ATTEMPTS; attempt++) {
        try {
          return await this.searchOnce(
            input,
            sourceTypes,
            filenames,
            timeout.signal,
          )
        }
        catch (error) {
          const classified = error instanceof CloudflareAiSearchError
            ? error
            : new CloudflareAiSearchError(
                CloudflareAiSearchErrorCode.RequestFailed,
              )

          if (attempt >= SEARCH_MAX_ATTEMPTS || !isRetryableSearchError(classified))
            throw classified

          const delayMs = Math.min(
            SEARCH_INITIAL_RETRY_DELAY_MS * 4 ** (attempt - 1),
            SEARCH_MAX_RETRY_DELAY_MS,
          )
          await sleepWithSignal(delayMs, timeout.signal)
        }
      }

      throw new CloudflareAiSearchError(
        CloudflareAiSearchErrorCode.RequestFailed,
      )
    }
    catch (error) {
      if (timeout.timedOut()) {
        throw new CloudflareAiSearchError(
          CloudflareAiSearchErrorCode.RequestTimeout,
        )
      }
      if (input.signal.aborted)
        input.signal.throwIfAborted()
      if (error instanceof CloudflareAiSearchError)
        throw error
      throw new CloudflareAiSearchError(
        CloudflareAiSearchErrorCode.RequestFailed,
      )
    }
    finally {
      timeout.dispose()
    }
  }

  private async searchOnce(
    input: {
      query: string
      limit: number
      filter?: KnowledgeFilter
      signal: AbortSignal
    },
    sourceTypes: KnowledgeSourceType[],
    filenames: string[] | undefined,
    signal: AbortSignal,
  ): Promise<RetrievedChunk[]> {
    const headers = new Headers({
      'content-type': 'application/json',
    })
    if (this.options.apiToken)
      headers.set('authorization', `Bearer ${this.options.apiToken}`)

    const response = await waitForSignal(this.request(this.options.searchUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: [{ role: 'user', content: input.query }],
        ai_search_options: {
          retrieval: {
            max_num_results: Math.min(Math.max(input.limit, 0), 50),
            filters: {
              evidence_role: this.options.evidenceRole,
              source_type: sourceTypes.length === 1
                ? sourceTypes[0]
                : { $in: sourceTypes },
              ...(filenames
                ? {
                    filename: filenames.length === 1
                      ? filenames[0]
                      : { $in: filenames },
                  }
                : {}),
            },
          },
        },
      }),
      signal,
    }), signal)

    if (!response.ok) {
      throw new CloudflareAiSearchError(
        CloudflareAiSearchErrorCode.RequestFailed,
        response.status,
      )
    }

    let body: unknown
    try {
      body = await waitForSignal(response.json(), signal)
    }
    catch (error) {
      if (signal.aborted)
        throw error
      throw new CloudflareAiSearchError(
        CloudflareAiSearchErrorCode.InvalidResponse,
        response.status,
      )
    }

    return parseChunks(body)
      .filter((chunk) => {
        const sourceType = metadataString(chunk.metadata, 'source_type')
        const evidenceRole = metadataString(chunk.metadata, 'evidence_role')
        return sourceTypes.includes(sourceType as KnowledgeSourceType)
          && evidenceRole === this.options.evidenceRole
      })
      .slice(0, Math.max(0, input.limit))
      .map((chunk, ordinal) => {
        const sourceType = metadataString(
          chunk.metadata,
          'source_type',
        ) as KnowledgeSourceType

        return {
          chunkId: `cloudflare-ai-search:${chunk.id}`,
          documentId: chunk.itemKey ?? chunk.id,
          sourceType,
          evidenceRole: this.options.evidenceRole,
          ownerId: null,
          title: chunk.itemKey ?? 'Cloudflare AI Search result',
          sourceUri: `cloudflare-ai-search:${chunk.itemKey ?? chunk.id}`,
          heading: metadataString(chunk.metadata, 'heading')
            ?? chunk.itemKey
            ?? 'Cloudflare AI Search result',
          text: chunk.text,
          ordinal,
          score: chunk.score,
        }
      })
  }
}

export interface CreateCloudflareAiSearchRetrieverOptions {
  sourceTypes?: readonly KnowledgeSourceType[]
  evidenceRole?: KnowledgeEvidenceRole
  request?: FetchLike
}

/**
 * 默认用 Account ID + Instance Name 生成 Cloudflare 官方 REST URL。
 * 完整 URL 只作为公共端点、Namespace 或内部代理的可选覆盖项。
 * 配置不足时返回 undefined，让本地模式继续使用 InMemory Retriever。
 */
export function createCloudflareAiSearchRetrieverFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: CreateCloudflareAiSearchRetrieverOptions = {},
): CloudflareAiSearchRetriever | undefined {
  const explicitSearchUrl = env.CLOUDFLARE_AI_SEARCH_SEARCH_URL?.trim()
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const instanceName = env.CLOUDFLARE_AI_SEARCH_INSTANCE?.trim()
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
  const searchUrl = explicitSearchUrl || (
    accountId && instanceName
      ? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai-search/instances/${encodeURIComponent(instanceName)}/search`
      : undefined
  )

  if (!searchUrl)
    return undefined

  return new CloudflareAiSearchRetriever({
    searchUrl,
    ...(apiToken ? { apiToken } : {}),
    sourceTypes: options.sourceTypes ?? [KnowledgeSourceType.Official],
    evidenceRole: options.evidenceRole
      ?? KnowledgeEvidenceRole.AnswerEvidence,
    fetch: options.request ?? globalThis.fetch,
  })
}

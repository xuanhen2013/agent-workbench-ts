import type {
  KnowledgeFilter,
  KnowledgeRetriever,
  RetrievedChunk,
} from './contracts'
import process from 'node:process'
import { z } from 'zod'
import {
  KnowledgeEvidenceRole,
  KnowledgeSourceType,
} from './contracts'

/** Cloudflare Adapter 自己的稳定错误码；不会把响应正文或 Token 写进错误。 */
export enum CloudflareAiSearchErrorCode {
  RequestFailed = 'cloudflare_ai_search_request_failed',
  InvalidResponse = 'cloudflare_ai_search_invalid_response',
}

export class CloudflareAiSearchError extends Error {
  constructor(
    readonly code: CloudflareAiSearchErrorCode,
    readonly status?: number,
  ) {
    super(code === CloudflareAiSearchErrorCode.RequestFailed
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
  /** 这个实例里的资料默认属于什么来源。 */
  sourceType: KnowledgeSourceType
  /** 这个实例里的资料默认承担什么证据角色。 */
  evidenceRole: KnowledgeEvidenceRole
  fetch?: FetchLike
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

function matchesConfiguredRole(
  filter: KnowledgeFilter | undefined,
  options: CloudflareAiSearchRetrieverOptions,
) {
  return filterContains(filter?.sourceTypes, options.sourceType)
    && filterContains(filter?.evidenceRoles, options.evidenceRole)
}

function metadataString(
  metadata: Record<string, unknown>,
  key: string,
) {
  const value = metadata[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * 一个 AI Search 实例对应一个稳定的来源/证据角色。
 *
 * 本项目当前把配置的远程实例当作 answer_evidence 实例，
 * interview-bank 的 question_signal 仍由本地 Retriever 提供。这样不会
 * 把“来源角色”交给模型猜，也不要求在第一版就实现多租户 metadata 路由。
 */
export class CloudflareAiSearchRetriever implements KnowledgeRetriever {
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

    // 如果本次 Graph 请求的是另一个角色，不应访问这个实例。
    if (!matchesConfiguredRole(input.filter, this.options))
      return []

    const headers = new Headers({
      'content-type': 'application/json',
    })
    if (this.options.apiToken)
      headers.set('authorization', `Bearer ${this.options.apiToken}`)

    let response: Response
    try {
      response = await this.request(this.options.searchUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: [{ role: 'user', content: input.query }],
          ai_search_options: {
            retrieval: {
              max_num_results: Math.min(Math.max(input.limit, 0), 50),
            },
          },
        }),
        signal: input.signal,
      })
    }
    catch {
      throw new CloudflareAiSearchError(
        CloudflareAiSearchErrorCode.RequestFailed,
      )
    }

    if (!response.ok) {
      throw new CloudflareAiSearchError(
        CloudflareAiSearchErrorCode.RequestFailed,
        response.status,
      )
    }

    let body: unknown
    try {
      body = await response.json()
    }
    catch {
      throw new CloudflareAiSearchError(
        CloudflareAiSearchErrorCode.InvalidResponse,
        response.status,
      )
    }

    return parseChunks(body)
      .slice(0, Math.max(0, input.limit))
      .map((chunk, ordinal) => ({
        chunkId: `cloudflare-ai-search:${chunk.id}`,
        documentId: chunk.itemKey ?? chunk.id,
        sourceType: this.options.sourceType,
        evidenceRole: this.options.evidenceRole,
        title: chunk.itemKey ?? 'Cloudflare AI Search result',
        sourceUri: `cloudflare-ai-search:${chunk.itemKey ?? chunk.id}`,
        heading: metadataString(chunk.metadata, 'heading')
          ?? chunk.itemKey
          ?? 'Cloudflare AI Search result',
        text: chunk.text,
        ordinal,
        score: chunk.score,
      }))
  }
}

/**
 * 默认用 Account ID + Instance Name 生成 Cloudflare 官方 REST URL。
 * 完整 URL 只作为公共端点、Namespace 或内部代理的可选覆盖项。
 * 配置不足时返回 undefined，让本地模式继续使用 InMemory Retriever。
 */
export function createCloudflareAiSearchRetrieverFromEnv(
  env: Record<string, string | undefined> = process.env,
  request: FetchLike = globalThis.fetch,
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
    sourceType: KnowledgeSourceType.Official,
    evidenceRole: KnowledgeEvidenceRole.AnswerEvidence,
    fetch: request,
  })
}

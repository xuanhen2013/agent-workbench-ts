import type { FetchLike } from './cloudflare-ai-search'
import { z } from 'zod'

/** Cloudflare 对单个上传文件公开的索引状态。 */
export enum CloudflareAiSearchItemStatus {
  Queued = 'queued',
  Running = 'running',
  Completed = 'completed',
  Error = 'error',
  Skipped = 'skipped',
  Outdated = 'outdated',
}
export interface CloudflareAiSearchItem {
  id: string
  key: string
  status: CloudflareAiSearchItemStatus
  chunksCount: number
  error?: string
}

export enum CloudflareAiSearchUploadErrorCode {
  RequestFailed = 'cloudflare_ai_search_upload_request_failed',
  InvalidResponse = 'cloudflare_ai_search_upload_invalid_response',
}

/**
 * 上传边界只公开稳定错误码和 HTTP status。
 * Cloudflare 的原始响应可能包含内部细节，因此不进入错误 message。
 */
export class CloudflareAiSearchUploadError extends Error {
  constructor(
    readonly code: CloudflareAiSearchUploadErrorCode,
    readonly status?: number,
  ) {
    super(code === CloudflareAiSearchUploadErrorCode.RequestFailed
      ? 'Cloudflare AI Search item request failed.'
      : 'Cloudflare AI Search returned an invalid item response.')
    this.name = 'CloudflareAiSearchUploadError'
  }
}

export interface CloudflareAiSearchUploaderOptions {
  itemsUrl: string
  apiToken: string
  fetch?: FetchLike
}

const CloudflareAiSearchItemSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  status: z.enum(CloudflareAiSearchItemStatus),
  // queued/running 时实际 API 可能返回 null，completed 后才是数字。
  chunks_count: z
    .number()
    .int()
    .nonnegative()
    .nullish()
    .transform(value => value ?? 0),
  error: z.string().nullish(),
})

const UploadResponseSchema = z.object({
  success: z.literal(true),
  // Cloudflare 当前实例返回数组，官方示例仍展示单个 object；兼容两者。
  result: z.union([
    CloudflareAiSearchItemSchema,
    z.array(CloudflareAiSearchItemSchema).min(1),
  ]),
})

const ListResponseSchema = z.object({
  success: z.literal(true),
  result: z.array(CloudflareAiSearchItemSchema),
})

function toItem(
  item: z.infer<typeof CloudflareAiSearchItemSchema>,
): CloudflareAiSearchItem {
  return {
    id: item.id,
    key: item.key,
    status: item.status,
    chunksCount: item.chunks_count,
    ...(item.error ? { error: item.error } : {}),
  }
}

/**
 * 教学用的最小 Items API Client：
 * - upload 负责把一个本地文件交给 Cloudflare；
 * - listByKey 负责观察异步索引是否完成。
 */
export class CloudflareAiSearchUploader {
  private readonly request: FetchLike

  constructor(private readonly options: CloudflareAiSearchUploaderOptions) {
    this.request = options.fetch ?? globalThis.fetch
  }

  async upload(input: {
    filename: string
    file: Blob
    signal?: AbortSignal
  }): Promise<CloudflareAiSearchItem> {
    const form = new FormData()
    form.append('file', input.file, input.filename)

    const response = await this.call(this.options.itemsUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiToken}`,
      },
      body: form,
      signal: input.signal,
    })

    const parsed = UploadResponseSchema.safeParse(response)
    if (!parsed.success) {
      throw new CloudflareAiSearchUploadError(
        CloudflareAiSearchUploadErrorCode.InvalidResponse,
      )
    }

    const item = Array.isArray(parsed.data.result)
      ? parsed.data.result[0]
      : parsed.data.result
    if (!item) {
      throw new CloudflareAiSearchUploadError(
        CloudflareAiSearchUploadErrorCode.InvalidResponse,
      )
    }

    return toItem(item)
  }

  async listByKey(
    key: string,
    signal?: AbortSignal,
  ): Promise<CloudflareAiSearchItem[]> {
    const url = new URL(this.options.itemsUrl)
    url.searchParams.set('key', key)
    url.searchParams.set('source', 'builtin')

    const response = await this.call(url, {
      headers: {
        authorization: `Bearer ${this.options.apiToken}`,
      },
      signal,
    })

    const parsed = ListResponseSchema.safeParse(response)
    if (!parsed.success) {
      throw new CloudflareAiSearchUploadError(
        CloudflareAiSearchUploadErrorCode.InvalidResponse,
      )
    }

    return parsed.data.result.map(toItem)
  }

  private async call(
    input: RequestInfo | URL,
    init: RequestInit,
  ): Promise<unknown> {
    let response: Response
    try {
      response = await this.request(input, init)
    }
    catch {
      throw new CloudflareAiSearchUploadError(
        CloudflareAiSearchUploadErrorCode.RequestFailed,
      )
    }

    if (!response.ok) {
      throw new CloudflareAiSearchUploadError(
        CloudflareAiSearchUploadErrorCode.RequestFailed,
        response.status,
      )
    }

    try {
      return await response.json()
    }
    catch {
      throw new CloudflareAiSearchUploadError(
        CloudflareAiSearchUploadErrorCode.InvalidResponse,
        response.status,
      )
    }
  }
}

/** 用官方 account-level Items URL 创建 Client；配置不足时保持显式失败。 */
export function createCloudflareAiSearchUploaderFromEnv(
  env: Record<string, string | undefined>,
  request: FetchLike = globalThis.fetch,
): CloudflareAiSearchUploader | undefined {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const instanceName = env.CLOUDFLARE_AI_SEARCH_INSTANCE?.trim()
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()

  if (!accountId || !instanceName || !apiToken)
    return undefined

  return new CloudflareAiSearchUploader({
    itemsUrl: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai-search/instances/${encodeURIComponent(instanceName)}/items`,
    apiToken,
    fetch: request,
  })
}

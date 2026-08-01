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
  metadata: Record<string, string | number | boolean>
  error?: string
}

export enum CloudflareAiSearchMetadataType {
  Text = 'text',
  Number = 'number',
  Boolean = 'boolean',
  Datetime = 'datetime',
}

export interface CloudflareAiSearchMetadataField {
  fieldName: string
  dataType: CloudflareAiSearchMetadataType
}

export enum CloudflareAiSearchUploadErrorCode {
  RequestFailed = 'cloudflare_ai_search_upload_request_failed',
  InvalidResponse = 'cloudflare_ai_search_upload_invalid_response',
  InvalidMetadataSchema = 'cloudflare_ai_search_invalid_metadata_schema',
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
      : code === CloudflareAiSearchUploadErrorCode.InvalidMetadataSchema
        ? 'Cloudflare AI Search metadata schema is invalid.'
        : 'Cloudflare AI Search returned an invalid item response.')
    this.name = 'CloudflareAiSearchUploadError'
  }
}

export interface CloudflareAiSearchUploaderOptions {
  instanceUrl: string
  itemsUrl: string
  apiToken: string
  fetch?: FetchLike
}

const CloudflareMetadataValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
])

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
  metadata: z
    .record(z.string(), CloudflareMetadataValueSchema)
    .nullish()
    .transform(value => value ?? {}),
})

const CloudflareAiSearchMetadataFieldSchema = z.object({
  field_name: z.string().min(1),
  data_type: z.enum(CloudflareAiSearchMetadataType),
})

const InstanceResponseSchema = z.object({
  success: z.literal(true),
  result: z.object({
    custom_metadata: z.array(CloudflareAiSearchMetadataFieldSchema).nullish(),
  }),
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
  result_info: z.object({
    page: z.number().int().positive(),
    per_page: z.number().int().positive(),
    total_count: z.number().int().nonnegative(),
  }).optional(),
})

function toItem(
  item: z.infer<typeof CloudflareAiSearchItemSchema>,
): CloudflareAiSearchItem {
  return {
    id: item.id,
    key: item.key,
    status: item.status,
    chunksCount: item.chunks_count,
    metadata: item.metadata,
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
    /** 带目录前缀的稳定 Item Key，例如 official/openai/doc.md。 */
    key: string
    file: Blob
    /** 必须先在实例 custom_metadata schema 中声明。 */
    metadata: Record<string, string | number | boolean>
    signal?: AbortSignal
  }): Promise<CloudflareAiSearchItem> {
    const form = new FormData()
    form.append('file', input.file, input.key)
    form.append('metadata', JSON.stringify(input.metadata))

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

  /**
   * 读取并合并实例的自定义 metadata schema。
   * PUT 只发送 custom_metadata，不覆盖模型、Chunk 或公开端点等其他配置。
   */
  async ensureMetadataSchema(
    requiredFields: readonly CloudflareAiSearchMetadataField[],
    signal?: AbortSignal,
  ): Promise<{ changed: boolean, fields: CloudflareAiSearchMetadataField[] }> {
    const currentResponse = await this.call(this.options.instanceUrl, {
      headers: {
        authorization: `Bearer ${this.options.apiToken}`,
      },
      signal,
    })
    const current = InstanceResponseSchema.safeParse(currentResponse)
    if (!current.success) {
      throw new CloudflareAiSearchUploadError(
        CloudflareAiSearchUploadErrorCode.InvalidResponse,
      )
    }

    const fields = new Map<string, CloudflareAiSearchMetadataField>()
    for (const field of current.data.result.custom_metadata ?? []) {
      fields.set(field.field_name.toLowerCase(), {
        fieldName: field.field_name.toLowerCase(),
        dataType: field.data_type,
      })
    }

    let changed = false
    for (const required of requiredFields) {
      const fieldName = required.fieldName.trim().toLowerCase()
      if (!fieldName || ['filename', 'folder', 'timestamp'].includes(fieldName)) {
        throw new CloudflareAiSearchUploadError(
          CloudflareAiSearchUploadErrorCode.InvalidMetadataSchema,
        )
      }

      const existing = fields.get(fieldName)
      if (!existing || existing.dataType !== required.dataType) {
        fields.set(fieldName, {
          fieldName,
          dataType: required.dataType,
        })
        changed = true
      }
    }

    const merged = [...fields.values()]
    if (merged.length > 5) {
      throw new CloudflareAiSearchUploadError(
        CloudflareAiSearchUploadErrorCode.InvalidMetadataSchema,
      )
    }

    if (!changed)
      return { changed: false, fields: merged }

    const updateResponse = await this.call(this.options.instanceUrl, {
      method: 'PUT',
      headers: {
        'authorization': `Bearer ${this.options.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        custom_metadata: merged.map(field => ({
          field_name: field.fieldName,
          data_type: field.dataType,
        })),
      }),
      signal,
    })
    const updated = InstanceResponseSchema.safeParse(updateResponse)
    if (!updated.success) {
      throw new CloudflareAiSearchUploadError(
        CloudflareAiSearchUploadErrorCode.InvalidResponse,
      )
    }

    return { changed: true, fields: merged }
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

  /** 一次列出内置存储条目，供批量状态检查和精确清理旧 Key。 */
  async listAll(signal?: AbortSignal): Promise<CloudflareAiSearchItem[]> {
    const items: CloudflareAiSearchItem[] = []
    let page = 1

    while (true) {
      const url = new URL(this.options.itemsUrl)
      url.searchParams.set('source', 'builtin')
      url.searchParams.set('page', String(page))
      url.searchParams.set('per_page', '50')
      url.searchParams.set('sort_by', 'modified_at')

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

      items.push(...parsed.data.result.map(toItem))
      const info = parsed.data.result_info
      if (!info || items.length >= info.total_count || parsed.data.result.length === 0)
        return items

      page += 1
    }
  }

  async deleteById(itemId: string, signal?: AbortSignal): Promise<void> {
    const url = new URL(`${this.options.itemsUrl}/${encodeURIComponent(itemId)}`)
    await this.call(url, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${this.options.apiToken}`,
      },
      signal,
    })
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
    instanceUrl: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai-search/instances/${encodeURIComponent(instanceName)}`,
    itemsUrl: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai-search/instances/${encodeURIComponent(instanceName)}/items`,
    apiToken,
    fetch: request,
  })
}

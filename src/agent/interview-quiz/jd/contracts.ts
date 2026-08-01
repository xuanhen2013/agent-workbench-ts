import { z } from 'zod/v4'

export enum SelectedJdSource {
  UserUpload = 'user_upload',
  Market = 'market',
}

export const MarketJdItemKeySchema = z.string().regex(
  /^question-signal\/jd-market\/jd-market-[a-f0-9]+\.md$/,
)

/**
 * Web 只能提交两种明确的 JD 引用。用户上传文档和公共市场条目使用
 * 不同的标识与读取边界，不能继续伪装成同一种 jdDocumentId。
 */
export const SelectedJdReferenceSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal(SelectedJdSource.UserUpload),
    documentId: z.string().min(1),
  }).strict(),
  z.object({
    source: z.literal(SelectedJdSource.Market),
    itemKey: MarketJdItemKeySchema,
  }).strict(),
])

export type SelectedJdReference = z.infer<typeof SelectedJdReferenceSchema>

/** Web 导入 JD 时唯一需要强校验的外部输入。 */
export const ImportJdBodySchema = z.object({
  learnerId: z.string().uuid(),
  title: z.string().trim().min(2).max(200),
  content: z.string().trim().min(50).max(20_000),
}).strict()

export type ImportJdInput = z.infer<typeof ImportJdBodySchema>

/** 导入接口只返回引用信息，不回显原文、Chunk 或 ownerId。 */
export interface ImportedJdView {
  jdDocumentId: string
  title: string
  chunkCount: number
}

/** Graph 当前 Thread 使用的有界 JD 信号，不保存 JD 全文。 */
export interface JdContext {
  reference: SelectedJdReference
  title: string
  focusKnowledgePoints: string[]
}

/** Web 直接展示的公共岗位字段。 */
export interface MarketJdCard {
  itemKey: string
  title: string
  company: string
  location: string
  salary: string
  highlights: string[]
}

/**
 * Catalog 的内部搜索结果。Route 和 Tool 分别投影自己需要的字段，
 * 避免为了两个入口重复调用 Cloudflare。
 */
export interface MarketJdSearchResult extends MarketJdCard {
  focusKnowledgePoints: string[]
  summary: string
}

/** Planner 只需要岗位共同关注的方向，不接收完整 JD。 */
export interface SimilarJdSignal {
  itemKey: string
  title: string
  company: string
  focusKnowledgePoints: string[]
  summary: string
}

export interface MarketJdCatalog {
  search: (input: {
    query: string
    limit: number
    excludeItemKey?: string
    signal: AbortSignal
  }) => Promise<MarketJdSearchResult[]>

  load: (input: {
    itemKey: string
    signal: AbortSignal
  }) => Promise<JdContext | null>
}

export const SearchMarketJdsQuerySchema = z.object({
  query: z.string().trim().min(2).max(200),
}).strict()

export type ImportJdDocument = (
  input: ImportJdInput,
  options: { signal: AbortSignal },
) => Promise<ImportedJdView>

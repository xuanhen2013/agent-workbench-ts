import type {
  JdContext,
  MarketJdCatalog,
  MarketJdSearchResult,
} from './contracts'
import type {
  KnowledgeSearchRetriever,
  RetrievedChunk,
} from '@/knowledge/contracts'
import {
  KnowledgeEvidenceRole,
  KnowledgeSourceType,
} from '@/knowledge/contracts'
import {
  MarketJdItemKeySchema,
  SelectedJdSource,
} from './contracts'
import { extractJdFocus } from './extract-jd-focus'

const MARKET_JD_LOAD_QUERY = '岗位职责 任职要求 技能标签'
const MAX_MARKET_JD_CANDIDATE_CHUNKS = 30
const MAX_MARKET_JD_SUMMARY_LENGTH = 500

function readField(text: string, label: string) {
  const prefix = `- ${label}:`
  const line = text
    .split('\n')
    .map(value => value.trim())
    .find(value => value.startsWith(prefix))
  return line?.slice(prefix.length).trim() || undefined
}

function readTitle(text: string) {
  const line = text
    .split('\n')
    .map(value => value.trim())
    .find(value => value.startsWith('# ') && !value.startsWith('## '))
  return line?.slice(2).trim() || undefined
}

function readSection(text: string, heading: string) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trim() === `## ${heading}`)
  if (start < 0)
    return ''

  const endOffset = lines
    .slice(start + 1)
    .findIndex(line => line.trim().startsWith('## '))
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset
  return lines.slice(start + 1, end).join('\n').trim()
}

function readHighlights(text: string) {
  return readSection(text, '技能标签')
    .split('\n')
    .map((line) => {
      const value = line.trim()
      return value.startsWith('- ') ? value.slice(2).trim() : undefined
    })
    .filter((value): value is string => (
      Boolean(value) && value !== '未提供'
    ))
    .slice(0, 6)
}

function summarizeJobDescription(text: string) {
  return readSection(text, '岗位描述')
    .split('\n')
    .map((line) => {
      let value = line.trim()
      while (value.startsWith('#'))
        value = value.slice(1)
      return value.trim()
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MARKET_JD_SUMMARY_LENGTH)
}

function mergeItemChunks(chunks: readonly RetrievedChunk[]) {
  const groups = new Map<string, RetrievedChunk[]>()

  for (const chunk of chunks) {
    const itemKey = MarketJdItemKeySchema.safeParse(chunk.documentId)
    if (
      !itemKey.success
      || chunk.sourceType !== KnowledgeSourceType.Jd
      || chunk.evidenceRole !== KnowledgeEvidenceRole.QuestionSignal
      || chunk.ownerId !== null
    ) {
      continue
    }

    const current = groups.get(itemKey.data) ?? []
    current.push(chunk)
    groups.set(itemKey.data, current)
  }

  return groups
}

function toSearchResult(
  itemKey: string,
  chunks: readonly RetrievedChunk[],
): MarketJdSearchResult | null {
  const text = [...chunks]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map(chunk => chunk.text)
    .join('\n\n')
  const title = readTitle(text)
  if (!title)
    return null

  const focusKnowledgePoints = extractJdFocus(text)

  return {
    itemKey,
    title,
    company: readField(text, '公司展示名') ?? '未提供',
    location: readField(text, '城市/区域') ?? '未提供',
    salary: readField(text, '薪资') ?? '未提供',
    highlights: readHighlights(text),
    focusKnowledgePoints,
    summary: summarizeJobDescription(text),
  }
}

/**
 * Web 和 Planner Tool 共用的市场 JD 目录。
 *
 * 它不直接拼 Cloudflare HTTP 请求，而是依赖项目现有 Retriever。这样来源、
 * evidence role、超时和安全错误仍由同一个 Adapter 负责。
 */
export class RetrievedMarketJdCatalog implements MarketJdCatalog {
  constructor(
    private readonly retriever: KnowledgeSearchRetriever,
  ) {}

  async search(input: {
    query: string
    limit: number
    excludeItemKey?: string
    signal: AbortSignal
  }): Promise<MarketJdSearchResult[]> {
    const limit = Math.max(0, input.limit)
    if (limit === 0)
      return []

    const chunks = await this.retriever.search({
      query: input.query,
      // 一份 JD 可能返回多个 Chunk，因此先多取一些候选，再按 itemKey 去重。
      limit: Math.min(
        Math.max(limit * 4, limit),
        MAX_MARKET_JD_CANDIDATE_CHUNKS,
      ),
      filter: {
        sourceTypes: [KnowledgeSourceType.Jd],
        evidenceRoles: [KnowledgeEvidenceRole.QuestionSignal],
      },
      signal: input.signal,
    })

    const results: MarketJdSearchResult[] = []
    for (const [itemKey, itemChunks] of mergeItemChunks(chunks)) {
      if (itemKey === input.excludeItemKey)
        continue

      const result = toSearchResult(itemKey, itemChunks)
      if (result)
        results.push(result)
      if (results.length >= limit)
        break
    }

    return results
  }

  async load(input: {
    itemKey: string
    signal: AbortSignal
  }): Promise<JdContext | null> {
    const itemKey = MarketJdItemKeySchema.safeParse(input.itemKey)
    if (!itemKey.success)
      return null

    const chunks = await this.retriever.search({
      // Query 只负责选择这份文档中最有用的内容；documentIds 才是精确边界。
      query: MARKET_JD_LOAD_QUERY,
      limit: 20,
      filter: {
        sourceTypes: [KnowledgeSourceType.Jd],
        evidenceRoles: [KnowledgeEvidenceRole.QuestionSignal],
        documentIds: [itemKey.data],
      },
      signal: input.signal,
    })
    const itemChunks = mergeItemChunks(chunks).get(itemKey.data)
    if (!itemChunks)
      return null

    const result = toSearchResult(itemKey.data, itemChunks)
    if (!result)
      return null

    return {
      reference: {
        source: SelectedJdSource.Market,
        itemKey: itemKey.data,
      },
      title: result.title,
      focusKnowledgePoints: result.focusKnowledgePoints,
    }
  }
}

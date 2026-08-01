import type {
  KnowledgeFilter,
  KnowledgeSearchRetriever,
  RetrievedChunk,
} from '@/knowledge/contracts'
import { describe, expect, test } from 'bun:test'
import { SelectedJdSource } from '@/agent/interview-quiz/jd/contracts'
import { RetrievedMarketJdCatalog } from '@/agent/interview-quiz/jd/market-jd-catalog'
import {
  KnowledgeEvidenceRole,
  KnowledgeSourceType,
} from '@/knowledge/contracts'

const firstItemKey
  = 'question-signal/jd-market/jd-market-aaaaaaaaaaaaaaaaaaaa.md'
const secondItemKey
  = 'question-signal/jd-market/jd-market-bbbbbbbbbbbbbbbbbbbb.md'

function jdChunk(input: {
  itemKey: string
  chunkId: string
  title: string
  company: string
  ordinal?: number
}): RetrievedChunk {
  return {
    chunkId: input.chunkId,
    documentId: input.itemKey,
    sourceType: KnowledgeSourceType.Jd,
    evidenceRole: KnowledgeEvidenceRole.QuestionSignal,
    ownerId: null,
    title: input.itemKey,
    sourceUri: `cloudflare-ai-search:${input.itemKey}`,
    heading: input.title,
    text: `# ${input.title}

- 公司展示名: ${input.company}
- 城市/区域: 广州 / 天河区
- 薪资: 20-35K

## 技能标签

- TypeScript
- LangGraph
- RAG

## 岗位描述

负责 Agent Workflow、Tool Calling 和 RAG 应用开发。`,
    ordinal: input.ordinal ?? 0,
    score: 0.9,
  }
}

class FakeRetriever implements KnowledgeSearchRetriever {
  readonly calls: Array<{
    query: string
    limit: number
    filter?: KnowledgeFilter
  }> = []

  constructor(
    private readonly results: RetrievedChunk[],
  ) {}

  async search(input: {
    query: string
    limit: number
    filter?: KnowledgeFilter
    signal: AbortSignal
  }) {
    input.signal.throwIfAborted()
    this.calls.push({
      query: input.query,
      limit: input.limit,
      filter: input.filter,
    })

    if (input.filter?.documentIds) {
      return this.results.filter(chunk => (
        input.filter?.documentIds?.includes(chunk.documentId)
      ))
    }
    return this.results.slice(0, input.limit)
  }
}

function signal() {
  return new AbortController().signal
}

describe('RetrievedMarketJdCatalog', () => {
  test('解析岗位卡片、按 itemKey 去重并排除当前 JD', async () => {
    const retriever = new FakeRetriever([
      jdChunk({
        itemKey: firstItemKey,
        chunkId: 'first:1',
        title: 'Agent 前端工程师',
        company: '示例公司 A',
      }),
      jdChunk({
        itemKey: firstItemKey,
        chunkId: 'first:2',
        title: 'Agent 前端工程师',
        company: '示例公司 A',
        ordinal: 1,
      }),
      jdChunk({
        itemKey: secondItemKey,
        chunkId: 'second:1',
        title: 'AI 应用工程师',
        company: '示例公司 B',
      }),
    ])
    const catalog = new RetrievedMarketJdCatalog(retriever)

    const results = await catalog.search({
      query: 'Agent 前端',
      limit: 3,
      excludeItemKey: firstItemKey,
      signal: signal(),
    })

    expect(results).toEqual([{
      itemKey: secondItemKey,
      title: 'AI 应用工程师',
      company: '示例公司 B',
      location: '广州 / 天河区',
      salary: '20-35K',
      highlights: ['TypeScript', 'LangGraph', 'RAG'],
      focusKnowledgePoints: ['LangGraph', 'Tool Calling', 'RAG'],
      summary: '负责 Agent Workflow、Tool Calling 和 RAG 应用开发。',
    }])
    expect(retriever.calls[0]?.limit).toBe(12)
    expect(retriever.calls[0]?.filter).toMatchObject({
      sourceTypes: [KnowledgeSourceType.Jd],
      evidenceRoles: [KnowledgeEvidenceRole.QuestionSignal],
    })
  })

  test('load 使用 documentIds 精确过滤并只返回有界 JdContext', async () => {
    const retriever = new FakeRetriever([
      jdChunk({
        itemKey: firstItemKey,
        chunkId: 'first:1',
        title: 'Agent 前端工程师',
        company: '示例公司 A',
      }),
      jdChunk({
        itemKey: secondItemKey,
        chunkId: 'second:1',
        title: 'AI 应用工程师',
        company: '示例公司 B',
      }),
    ])
    const catalog = new RetrievedMarketJdCatalog(retriever)

    const context = await catalog.load({
      itemKey: firstItemKey,
      signal: signal(),
    })

    expect(retriever.calls[0]?.filter?.documentIds).toEqual([firstItemKey])
    expect(context).toEqual({
      reference: {
        source: SelectedJdSource.Market,
        itemKey: firstItemKey,
      },
      title: 'Agent 前端工程师',
      focusKnowledgePoints: ['LangGraph', 'Tool Calling', 'RAG'],
    })
    expect(context).not.toHaveProperty('summary')
  })

  test('非法或不存在的 itemKey 返回 null', async () => {
    const catalog = new RetrievedMarketJdCatalog(new FakeRetriever([]))

    expect(await catalog.load({
      itemKey: '../secret.md',
      signal: signal(),
    })).toBeNull()
    expect(await catalog.load({
      itemKey: firstItemKey,
      signal: signal(),
    })).toBeNull()
  })
})

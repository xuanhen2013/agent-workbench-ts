import type { SourceDocument } from '@/knowledge/contracts'
import { describe, expect, test } from 'bun:test'
import {
  KnowledgeEvidenceRole,
  KnowledgeSourceType,
} from '@/knowledge/contracts'
import {
  chunkDocuments,
  FakeEmbeddingModel,
  InMemoryKnowledgeRetriever,
  InMemoryKnowledgeStore,
} from '@/knowledge/in-memory-rag'

const documents: SourceDocument[] = [
  {
    documentId: 'doc:graph',
    sourceType: KnowledgeSourceType.Official,
    evidenceRole: KnowledgeEvidenceRole.AnswerEvidence,
    ownerId: null,
    title: 'Graph',
    sourceUri: 'fixture:graph',
    content: '## Interrupt\nLangGraph interrupt pauses execution and resume continues it.',
  },
  {
    documentId: 'doc:tool',
    sourceType: KnowledgeSourceType.InterviewBank,
    evidenceRole: KnowledgeEvidenceRole.QuestionSignal,
    ownerId: null,
    title: 'Tool',
    sourceUri: 'fixture:tool',
    content: '## Tool\nTool Calling lets a model request an external tool.',
  },
  {
    documentId: 'doc:weather',
    sourceType: KnowledgeSourceType.UserNote,
    evidenceRole: KnowledgeEvidenceRole.AnswerEvidence,
    ownerId: null,
    title: 'Weather',
    sourceUri: 'fixture:weather',
    content: '## Weather\nWeather forecasts describe temperature and rain.',
  },
]

async function createRetriever() {
  const chunks = chunkDocuments(documents)
  const embeddingModel = new FakeEmbeddingModel()
  const vectors = await embeddingModel.embedDocuments(
    chunks.map(chunk => chunk.text),
    { signal: new AbortController().signal },
  )
  const store = new InMemoryKnowledgeStore()
  await store.upsert(
    chunks.map((chunk, index) => ({
      chunk,
      vector: vectors[index]!,
    })),
    { signal: new AbortController().signal },
  )

  return { chunks, store, retriever: new InMemoryKnowledgeRetriever(embeddingModel, store) }
}

describe('最小本地 RAG', () => {
  test('相同文档重复切分会产生相同 Chunk ID', () => {
    expect(chunkDocuments(documents)).toEqual(chunkDocuments(documents))
  })

  test('检索 LangGraph interrupt 时相关 Chunk 排在天气资料前', async () => {
    const { retriever } = await createRetriever()
    const results = await retriever.search({
      query: 'LangGraph interrupt resume',
      limit: 2,
      signal: new AbortController().signal,
    })

    expect(results[0]).toMatchObject({
      documentId: 'doc:graph',
    })
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0)
  })

  test('Store 保存 Chunk 和向量，重复 upsert 不增加数量，Filter 能隔离证据角色', async () => {
    const { chunks, store, retriever } = await createRetriever()
    expect(store.size).toBe(3)

    await store.upsert([{
      chunk: chunks[0]!,
      vector: [1, 0, 0],
    }], { signal: new AbortController().signal })
    expect(store.size).toBe(3)

    const signals = await retriever.search({
      query: 'Tool Calling',
      limit: 10,
      filter: {
        evidenceRoles: [KnowledgeEvidenceRole.QuestionSignal],
      },
      signal: new AbortController().signal,
    })
    expect(signals.every(item => (
      item.evidenceRole === KnowledgeEvidenceRole.QuestionSignal
    ))).toBe(true)
  })

  test('已取消的 signal 不执行检索', async () => {
    const { retriever } = await createRetriever()
    const controller = new AbortController()
    controller.abort()

    await expect(retriever.search({
      query: 'interrupt',
      limit: 2,
      signal: controller.signal,
    })).rejects.toThrow()
  })
})

import type { SourceDocument } from '@/knowledge/contracts'
import { describe, expect, test } from 'bun:test'
import { importJdDocument, normalizeJdContent } from '@/jd/import-jd'
import { KnowledgeEvidenceRole, KnowledgeSourceType } from '@/knowledge/contracts'
import {
  chunkDocuments,
  FakeEmbeddingModel,
  InMemoryKnowledgeRetriever,
  InMemoryKnowledgeStore,
} from '@/knowledge/in-memory-rag'

const signal = new AbortController().signal
const learnerA = '00000000-0000-4000-8000-000000000001'
const learnerB = '00000000-0000-4000-8000-000000000002'

function deps() {
  const embedder = new FakeEmbeddingModel()
  const store = new InMemoryKnowledgeStore()
  return { embedder, store }
}

const content = `
岗位职责
负责 LangGraph、RAG 和 MCP 相关 Agent 应用建设。

任职要求
熟悉 TypeScript、Tool Calling、上下文工程和可靠性设计。
`.trim()

describe('JD import', () => {
  test('normalize 保留段落、折叠行内空白', () => {
    expect(normalizeJdContent('  A  B\r\n\r\n\r\n C ')).toBe('A B\n\nC')
  })

  test('同 learner 同内容稳定 upsert，owner 传播到每个 Chunk', async () => {
    const first = deps()
    const second = deps()
    const a = await importJdDocument({
      learnerId: learnerA,
      title: 'Agent 前端工程师',
      content,
    }, first, { signal })
    const again = await importJdDocument({
      learnerId: learnerA,
      title: '另一个标题',
      content,
    }, first, { signal })
    const b = await importJdDocument({
      learnerId: learnerB,
      title: 'Agent 前端工程师',
      content,
    }, second, { signal })

    expect(a.jdDocumentId).toBe(again.jdDocumentId)
    expect(a.jdDocumentId).not.toBe(b.jdDocumentId)
    expect(first.store.size).toBe(a.chunkCount)
    const chunks = await new InMemoryKnowledgeRetriever(
      first.embedder,
      first.store,
    ).loadDocument({
      documentId: a.jdDocumentId,
      ownerId: learnerA,
      sourceType: KnowledgeSourceType.Jd,
      signal,
    })
    expect(chunks.length).toBe(a.chunkCount)
    expect(chunks.every(chunk => (
      chunk.ownerId === learnerA
      && chunk.sourceType === KnowledgeSourceType.Jd
      && chunk.evidenceRole === KnowledgeEvidenceRole.QuestionSignal
    ))).toBe(true)
  })

  test('精确加载带 owner，不会读到另一个 learner 的 JD', async () => {
    const { embedder, store } = deps()
    const a = await importJdDocument({ learnerId: learnerA, title: 'A', content }, { embedder, store }, { signal })
    const retriever = new InMemoryKnowledgeRetriever(embedder, store)

    expect(await retriever.loadDocument({
      documentId: a.jdDocumentId,
      ownerId: learnerB,
      sourceType: KnowledgeSourceType.Jd,
      signal,
    })).toEqual([])
  })

  test('公共 answer evidence 可以通过 ownerId=null 与私人 JD 隔离', async () => {
    const { store } = deps()
    const publicDocument: SourceDocument = {
      documentId: 'official:test',
      sourceType: KnowledgeSourceType.Official,
      evidenceRole: KnowledgeEvidenceRole.AnswerEvidence,
      ownerId: null,
      title: 'Official',
      sourceUri: 'official:test',
      content: 'StateGraph node reads state and returns partial updates.',
    }
    await store.upsert(
      [{
        chunk: chunkDocuments([publicDocument])[0]!,
        vector: [1, 0, 0],
      }],
      { signal },
    )

    const rows = await store.list({
      filter: { evidenceRoles: [KnowledgeEvidenceRole.AnswerEvidence], ownerId: null },
      signal,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.ownerId).toBeNull()
  })
})

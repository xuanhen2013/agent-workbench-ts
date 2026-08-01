import type { ImportedJdView, ImportJdInput } from './contracts'
import type { EmbeddingModel, KnowledgeStore, SourceDocument } from '@/knowledge/contracts'
import { createHash } from 'node:crypto'
import {
  KnowledgeEvidenceRole,
  KnowledgeSourceType,
} from '@/knowledge/contracts'
import { chunkDocuments } from '@/knowledge/in-memory-rag'

/**
 * 只做稳定 identity 所需的轻量规范化，不尝试理解 JD 语义。
 * 段落边界会保留，便于后续 Markdown/文本切块。
 */
export function normalizeJdContent(content: string) {
  return content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim().replace(/\s+/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function importJdDocument(
  input: ImportJdInput,
  deps: {
    embedder: EmbeddingModel
    store: Pick<KnowledgeStore, 'upsert'>
  },
  options: { signal: AbortSignal },
): Promise<ImportedJdView> {
  options.signal.throwIfAborted()

  const content = normalizeJdContent(input.content)
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 24)
  const documentId = `jd:${input.learnerId}:${hash}`
  const document: SourceDocument = {
    documentId,
    sourceType: KnowledgeSourceType.Jd,
    evidenceRole: KnowledgeEvidenceRole.QuestionSignal,
    ownerId: input.learnerId,
    title: input.title.trim(),
    sourceUri: `user-upload:${documentId}`,
    content,
  }
  const chunks = chunkDocuments([document])
  const vectors = await deps.embedder.embedDocuments(
    chunks.map(chunk => chunk.text),
    { signal: options.signal },
  )

  await deps.store.upsert(
    chunks.map((chunk, index) => ({
      chunk,
      vector: vectors[index] ?? [],
    })),
    { signal: options.signal },
  )

  return {
    jdDocumentId: documentId,
    title: document.title,
    chunkCount: chunks.length,
  }
}

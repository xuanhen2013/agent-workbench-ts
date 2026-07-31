import type {
  EmbeddingModel,
  KnowledgeChunk,
  KnowledgeFilter,
  KnowledgeRetriever,
  KnowledgeStore,
  RetrievedChunk,
  SourceDocument,
} from './contracts'
import {
  cosineSimilarity,
  createFakeEmbedding,
  createStableChunkId,
  splitDocumentIntoParts,
} from './rag-algorithms'

/**
 * 阅读顺序：
 *
 * 1. chunkDocuments：完整文档变成 Chunk；
 * 2. InMemoryKnowledgeStore.upsert：保存 Chunk + Vector；
 * 3. InMemoryKnowledgeRetriever.search：Query 变向量后交给 Store；
 * 4. InMemoryKnowledgeStore.search：计算分数、排序、返回 Top K。
 *
 * Fake Embedding、Markdown 切分、Hash 和 cosine 公式都在
 * rag-algorithms.ts。初学阶段可以把它们当成已经提供好的函数。
 */

/**
 * RAG 的第一步：Document[] → Chunk[]。
 *
 * 这里负责组装领域对象；具体怎样识别 Markdown 标题、怎样切超长文本，
 * 交给 rag-algorithms.ts，避免机械细节挡住主流程。
 */
export function chunkDocuments(
  documents: readonly SourceDocument[],
): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = []

  for (const document of documents) {
    const parts = splitDocumentIntoParts(document)

    for (const [ordinal, part] of parts.entries()) {
      chunks.push({
        chunkId: createStableChunkId(document.documentId, ordinal, part.text),
        documentId: document.documentId,
        sourceType: document.sourceType,
        evidenceRole: document.evidenceRole,
        title: document.title,
        sourceUri: document.sourceUri,
        heading: part.heading,
        text: part.text,
        ordinal,
      })
    }
  }

  return chunks
}

/**
 * Fake Embedding 只让测试能够免费、离线、确定地运行。
 *
 * 阅读时只需记住两个输入输出：
 * - embedDocuments：多个 Chunk 文本 → 多个向量；
 * - embedQuery：一个查询文本 → 一个向量。
 *
 * 未来接真实 Embedding Provider 时，Graph 和 Store 都不需要修改。
 */
export class FakeEmbeddingModel implements EmbeddingModel {
  async embedDocuments(
    texts: string[],
    options: { signal: AbortSignal },
  ): Promise<number[][]> {
    return texts.map((text) => {
      options.signal.throwIfAborted()
      return createFakeEmbedding(text)
    })
  }

  async embedQuery(
    text: string,
    options: { signal: AbortSignal },
  ): Promise<number[]> {
    options.signal.throwIfAborted()
    return createFakeEmbedding(text)
  }
}

/**
 * 最小向量 Store，内部只有一张 Map：
 *
 * chunkId → { 原始 Chunk, Vector }
 *
 * 它只用于学习和离线测试；进程关闭后数据会消失。
 */
export class InMemoryKnowledgeStore implements KnowledgeStore {
  private readonly rows = new Map<
    string,
    { chunk: KnowledgeChunk, vector: number[] }
  >()

  /** 只给测试确认重复 upsert 不会增加记录数。 */
  get size() {
    return this.rows.size
  }

  /**
   * 保存阶段：把已经配对好的 Chunk + Vector 写入 Map。
   * 相同 chunkId 再次写入时覆盖旧值，这就是最小 upsert。
   */
  async upsert(
    items: Array<{ chunk: KnowledgeChunk, vector: number[] }>,
    options: { signal: AbortSignal },
  ): Promise<void> {
    for (const item of items) {
      options.signal.throwIfAborted()
      this.rows.set(item.chunk.chunkId, {
        chunk: { ...item.chunk },
        vector: [...item.vector],
      })
    }
  }

  /**
   * 查询阶段：
   *
   * 1. 按 sourceType/evidenceRole 过滤；
   * 2. Query Vector 与每个 Chunk Vector 计算相似度；
   * 3. score 从高到低排序；
   * 4. 返回前 limit 个原始 Chunk。
   */
  async search(input: {
    vector: number[]
    limit: number
    filter?: KnowledgeFilter
    signal: AbortSignal
  }): Promise<RetrievedChunk[]> {
    const results: RetrievedChunk[] = []

    for (const { chunk, vector } of this.rows.values()) {
      input.signal.throwIfAborted()
      if (!matchesFilter(chunk, input.filter))
        continue

      results.push({
        ...chunk,
        score: cosineSimilarity(input.vector, vector),
      })
    }

    return results
      .sort((left, right) => (
        right.score - left.score
        || left.chunkId.localeCompare(right.chunkId)
      ))
      .slice(0, Math.max(0, input.limit))
  }
}

/** 资料角色过滤属于 RAG 业务规则，所以保留在主流程文件中。 */
function matchesFilter(
  chunk: KnowledgeChunk,
  filter: KnowledgeFilter | undefined,
) {
  if (
    filter?.sourceTypes?.length
    && !filter.sourceTypes.includes(chunk.sourceType)
  ) {
    return false
  }

  if (
    filter?.evidenceRoles?.length
    && !filter.evidenceRoles.includes(chunk.evidenceRole)
  ) {
    return false
  }

  return true
}

/**
 * Retriever 是 Graph 真正调用的入口。
 *
 * 它本身不保存数据，只串起两步：
 * Query Text → Query Vector → Store.search()。
 */
export class InMemoryKnowledgeRetriever implements KnowledgeRetriever {
  constructor(
    private readonly embeddingModel: EmbeddingModel,
    private readonly store: KnowledgeStore,
  ) {}

  async search(input: {
    query: string
    limit: number
    filter?: KnowledgeFilter
    signal: AbortSignal
  }): Promise<RetrievedChunk[]> {
    const queryVector = await this.embeddingModel.embedQuery(input.query, {
      signal: input.signal,
    })

    return await this.store.search({
      vector: queryVector,
      limit: input.limit,
      filter: input.filter,
      signal: input.signal,
    })
  }
}

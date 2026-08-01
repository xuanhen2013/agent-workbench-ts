/** 资料来自哪里。它描述来源，不代表资料天然可信。 */
export enum KnowledgeSourceType {
  InterviewBank = 'interview_bank',
  HelloAgents = 'hello_agents',
  Xiaolin = 'xiaolin',
  Official = 'official',
  UserNote = 'user_note',
  Jd = 'jd',
}

/**
 * 资料在出题时承担什么角色。
 *
 * QuestionSignal 只能帮助 Planner 决定“考什么”；
 * AnswerEvidence 才能证明题目的正确答案。
 */
export enum KnowledgeEvidenceRole {
  QuestionSignal = 'question_signal',
  AnswerEvidence = 'answer_evidence',
}

/** 还没有切块的完整文档。 */
export interface SourceDocument {
  documentId: string
  sourceType: KnowledgeSourceType
  evidenceRole: KnowledgeEvidenceRole
  /** null 表示公共资料；用户 JD 使用 learnerId。 */
  ownerId: string | null
  title: string
  sourceUri: string
  content: string
}

/** 可以独立参与检索的一小段资料。 */
export interface KnowledgeChunk {
  chunkId: string
  documentId: string
  sourceType: KnowledgeSourceType
  evidenceRole: KnowledgeEvidenceRole
  /** 由 SourceDocument 传播；检索前必须按 owner 边界过滤。 */
  ownerId: string | null
  title: string
  sourceUri: string
  heading: string
  text: string
  ordinal: number
}

/** Retriever 返回给 Graph 的结果；score 越大表示越相关。 */
export interface RetrievedChunk extends KnowledgeChunk {
  score: number
}

/** 第一版只按来源和证据角色过滤。 */
export interface KnowledgeFilter {
  sourceTypes?: KnowledgeSourceType[]
  evidenceRoles?: KnowledgeEvidenceRole[]
  documentIds?: string[]
  /** undefined 表示不限制；null 表示只读取公共资料。 */
  ownerId?: string | null
}

/** 文本转向量的边界。未来可以换成真实 Embedding Provider。 */
export interface EmbeddingModel {
  embedDocuments: (
    texts: string[],
    options: { signal: AbortSignal },
  ) => Promise<number[][]>

  embedQuery: (
    text: string,
    options: { signal: AbortSignal },
  ) => Promise<number[]>
}

/** 保存 Chunk + Vector，并执行向量相似度搜索。 */
export interface KnowledgeStore {
  upsert: (
    items: Array<{ chunk: KnowledgeChunk, vector: number[] }>,
    options: { signal: AbortSignal },
  ) => Promise<void>

  search: (input: {
    vector: number[]
    limit: number
    filter?: KnowledgeFilter
    signal: AbortSignal
  }) => Promise<RetrievedChunk[]>

  /** 精确列出文档 Chunk；不能用向量 Top-K 代替。 */
  list: (input: {
    filter: KnowledgeFilter
    signal: AbortSignal
  }) => Promise<KnowledgeChunk[]>
}

/** Graph/Tool 的通用语义检索边界。 */
export interface KnowledgeSearchRetriever {
  search: (input: {
    query: string
    limit: number
    filter?: KnowledgeFilter
    signal: AbortSignal
  }) => Promise<RetrievedChunk[]>
}

/** 本地可枚举 Store 额外支持按 owner 精确加载文档。 */
export interface KnowledgeRetriever extends KnowledgeSearchRetriever {
  /** 按 documentId + ownerId 精确加载一份用户文档。 */
  loadDocument: (input: {
    documentId: string
    ownerId: string
    sourceType: KnowledgeSourceType
    signal: AbortSignal
  }) => Promise<KnowledgeChunk[]>
}

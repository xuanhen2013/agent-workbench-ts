import type {
  KnowledgeEvidenceRole,
  KnowledgeRetriever,
  RetrievedChunk,
} from '@/knowledge/contracts'
import type { MiniTool } from '@/tools/_core/types'
import { z } from 'zod/v4'
import { KnowledgeEvidenceRole as EvidenceRole } from '@/knowledge/contracts'
import { defineTool } from '@/tools/_core'

/** 模型看到的稳定 Tool 名称，也是 Planner 识别 Tool Output 的依据。 */
export enum KnowledgeToolName {
  SearchQuestionSignal = 'search_question_signal',
  SearchAnswerEvidence = 'search_answer_evidence',
}

/** Top-K 和正文长度由服务端控制，模型只能决定搜索词。 */
export const QUESTION_SIGNAL_LIMIT_PER_SEARCH = 5
export const ANSWER_EVIDENCE_LIMIT_PER_SEARCH = 5
export const MAX_KNOWLEDGE_CHUNK_TEXT_LENGTH = 1200

export const SearchKnowledgeInputSchema = z.object({
  query: z.string().trim().min(3).max(300),
}).strict()

export interface SearchKnowledgeOutput {
  chunks: RetrievedChunk[]
}

function createSearchKnowledgeTool(input: {
  name: KnowledgeToolName
  description: string
  evidenceRole: KnowledgeEvidenceRole
  limit: number
  retriever: Pick<KnowledgeRetriever, 'search'>
}): MiniTool<typeof SearchKnowledgeInputSchema, SearchKnowledgeOutput> {
  return defineTool({
    name: input.name,
    description: input.description,
    schema: SearchKnowledgeInputSchema,
    async handler({ query }, runtime): Promise<SearchKnowledgeOutput> {
      const chunks = await input.retriever.search({
        query,
        limit: input.limit,
        filter: {
          evidenceRoles: [input.evidenceRole],
        },
        signal: runtime.signal,
      })

      return {
        // Retriever 应当执行过滤；这里再守一次 Tool 输出边界，避免把另一
        // 角色的资料意外交给模型，并限制每段进入上下文的正文长度。
        chunks: chunks
          .filter(chunk => chunk.evidenceRole === input.evidenceRole)
          .slice(0, input.limit)
          .map(chunk => ({
            ...chunk,
            text: chunk.text.slice(0, MAX_KNOWLEDGE_CHUNK_TEXT_LENGTH),
          })),
      }
    },
  })
}

/** 搜索行业常考方向；结果不能用于证明正确答案。 */
export function createSearchQuestionSignalTool(
  retriever: Pick<KnowledgeRetriever, 'search'>,
) {
  return createSearchKnowledgeTool({
    name: KnowledgeToolName.SearchQuestionSignal,
    description: '当现有常考方向不足时，追加搜索 question_signal。结果只能决定考什么，不能证明正确答案。',
    evidenceRole: EvidenceRole.QuestionSignal,
    limit: QUESTION_SIGNAL_LIMIT_PER_SEARCH,
    retriever,
  })
}

/** 搜索核验资料；最终题目的 sourceChunkIds 只能引用这类结果。 */
export function createSearchAnswerEvidenceTool(
  retriever: Pick<KnowledgeRetriever, 'search'>,
) {
  return createSearchKnowledgeTool({
    name: KnowledgeToolName.SearchAnswerEvidence,
    description: '当现有资料不足以证明题目答案时，搜索已核验的 answer_evidence。',
    evidenceRole: EvidenceRole.AnswerEvidence,
    limit: ANSWER_EVIDENCE_LIMIT_PER_SEARCH,
    retriever,
  })
}

import type {
  MarketJdCatalog,
  SimilarJdSignal,
} from '@/agent/interview-quiz/jd/contracts'
import type { MiniTool } from '@/tools/_core/types'
import { z } from 'zod/v4'
import { defineTool } from '@/tools/_core'

export enum JdToolName {
  SearchSimilarJds = 'search_similar_jds',
}

export const SIMILAR_JD_LIMIT_PER_SEARCH = 3

/** 模型只决定语义查询；返回数量、来源、角色和排除项都由服务端固定。 */
export const SearchSimilarJdsInputSchema = z.object({
  query: z.string().trim().min(2).max(200),
}).strict()

export interface SearchSimilarJdsOutput {
  jobs: SimilarJdSignal[]
}

export function createSearchSimilarJdsTool(
  catalog: Pick<MarketJdCatalog, 'search'>,
  excludeItemKey: string,
): MiniTool<typeof SearchSimilarJdsInputSchema, SearchSimilarJdsOutput> {
  return defineTool({
    name: JdToolName.SearchSimilarJds,
    description: '搜索与当前已选市场 JD 相近的岗位，只用于补充面试出题方向，不能证明技术答案。',
    schema: SearchSimilarJdsInputSchema,
    async handler({ query }, runtime): Promise<SearchSimilarJdsOutput> {
      const jobs = await catalog.search({
        query,
        limit: SIMILAR_JD_LIMIT_PER_SEARCH,
        excludeItemKey,
        signal: runtime.signal,
      })

      return {
        jobs: jobs.map(job => ({
          itemKey: job.itemKey,
          title: job.title,
          company: job.company,
          focusKnowledgePoints: job.focusKnowledgePoints,
          summary: job.summary,
        })),
      }
    },
  })
}

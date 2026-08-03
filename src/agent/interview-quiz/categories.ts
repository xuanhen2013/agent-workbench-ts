import type { QuizCategory } from './contracts'
import type { JdContext } from './jd/contracts'
import {
  MAX_QUIZ_CATEGORIES,
  QuizCategoryId,
} from './contracts'

interface CategoryDefinition {
  categoryId: QuizCategoryId
  name: string
  knowledgePoints: readonly string[]
}

/**
 * 第一版只做可审计的确定性归类，不再增加一个 JD Analyzer 模型调用。
 * JD 中出现稳定漏判后，再根据真实数据升级为 Structured Output。
 */
const CATEGORY_DEFINITIONS: readonly CategoryDefinition[] = [
  {
    categoryId: QuizCategoryId.Orchestration,
    name: 'Agent 编排',
    knowledgePoints: ['LangGraph', 'Multi-Agent'],
  },
  {
    categoryId: QuizCategoryId.Tooling,
    name: '工具与协议',
    knowledgePoints: ['Tool Calling', 'MCP', 'Skill'],
  },
  {
    categoryId: QuizCategoryId.Knowledge,
    name: '知识与上下文',
    knowledgePoints: ['RAG', 'Memory'],
  },
  {
    categoryId: QuizCategoryId.Reliability,
    name: '可靠性与运行时',
    knowledgePoints: ['Harness'],
  },
]

function cloneCategory(
  definition: CategoryDefinition,
  knowledgePoints: readonly string[] = definition.knowledgePoints,
): QuizCategory {
  return {
    categoryId: definition.categoryId,
    name: definition.name,
    knowledgePoints: [...knowledgePoints],
  }
}

/**
 * 有 JD 时只选择 JD 实际命中的分类，按命中知识点数量和固定优先级排序；
 * 无 JD 或 JD 没命中 Agent 词表时，退化为三个通用 Agent 工程分类。
 */
export function selectQuizCategories(
  jdContext: JdContext | null,
): QuizCategory[] {
  const jdPoints = new Set(jdContext?.focusKnowledgePoints ?? [])
  if (jdPoints.size === 0) {
    return CATEGORY_DEFINITIONS
      .slice(0, MAX_QUIZ_CATEGORIES)
      .map(definition => cloneCategory(definition))
  }

  return CATEGORY_DEFINITIONS
    .map((definition, priority) => ({
      definition,
      priority,
      matched: definition.knowledgePoints.filter(point => jdPoints.has(point)),
    }))
    .filter(candidate => candidate.matched.length > 0)
    .sort((left, right) => (
      right.matched.length - left.matched.length
      || left.priority - right.priority
    ))
    .slice(0, MAX_QUIZ_CATEGORIES)
    .map(candidate => cloneCategory(
      candidate.definition,
      candidate.matched,
    ))
}

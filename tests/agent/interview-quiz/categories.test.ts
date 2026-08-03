import { describe, expect, test } from 'bun:test'
import { selectQuizCategories } from '@/agent/interview-quiz/categories'
import { QuizCategoryId } from '@/agent/interview-quiz/contracts'
import { SelectedJdSource } from '@/agent/interview-quiz/jd/contracts'

describe('Interview Quiz categories', () => {
  test('无 JD 时返回三个稳定通用分类', () => {
    expect(selectQuizCategories(null).map(category => category.categoryId))
      .toEqual([
        QuizCategoryId.Orchestration,
        QuizCategoryId.Tooling,
        QuizCategoryId.Knowledge,
      ])
  })

  test('按 JD 命中数量选择最多三个分类，并只保留命中的知识点', () => {
    const categories = selectQuizCategories({
      reference: {
        source: SelectedJdSource.UserUpload,
        documentId: 'jd:test',
      },
      title: 'Agent Engineer',
      focusKnowledgePoints: [
        'MCP',
        'Skill',
        'RAG',
        'LangGraph',
        'Harness',
      ],
    })

    expect(categories).toHaveLength(3)
    expect(categories[0]).toMatchObject({
      categoryId: QuizCategoryId.Tooling,
      knowledgePoints: ['MCP', 'Skill'],
    })
    expect(categories.map(category => category.categoryId)).not.toContain(
      QuizCategoryId.Reliability,
    )
  })
})

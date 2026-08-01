import { describe, expect, test } from 'bun:test'
import { extractJdFocus } from '@/agent/interview-quiz/jd/extract-jd-focus'

describe('extractJdFocus', () => {
  test('按固定别名提取有界 Agent 重点', () => {
    expect(extractJdFocus('需要 LangGraph、RAG、MCP、Tool Calling 和长期记忆经验。'))
      .toEqual(['LangGraph', 'Tool Calling', 'RAG', 'Memory', 'MCP'])
  })

  test('没有相关关键词时返回空数组，不调用模型', () => {
    expect(extractJdFocus('负责常规页面开发和样式维护。')).toEqual([])
  })
})

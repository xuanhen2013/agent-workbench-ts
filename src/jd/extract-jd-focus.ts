const AgentFocusAliases: ReadonlyArray<{
  knowledgePoint: string
  aliases: readonly string[]
}> = [
  { knowledgePoint: 'LangGraph', aliases: ['langgraph', 'stategraph', '状态图'] },
  { knowledgePoint: 'Tool Calling', aliases: ['tool calling', 'function calling', '工具调用'] },
  { knowledgePoint: 'RAG', aliases: ['rag', '检索增强', '向量数据库', 'embedding'] },
  { knowledgePoint: 'Memory', aliases: ['memory', '长期记忆', 'checkpointer'] },
  { knowledgePoint: 'Skill', aliases: ['skill', '技能系统'] },
  { knowledgePoint: 'MCP', aliases: ['mcp', 'model context protocol'] },
  { knowledgePoint: 'Multi-Agent', aliases: ['multi-agent', 'multi agent', '多智能体', '子 agent', '子agent'] },
  { knowledgePoint: 'Harness', aliases: ['harness', '重试', '超时', '幂等'] },
]

/**
 * 教学版使用可审计的关键词映射，不额外调用一个 JD Analyzer 模型。
 * 真实 JD 出现稳定漏判后，再用数据决定是否升级为 Structured Output。
 */
export function extractJdFocus(text: string): string[] {
  const normalized = text.toLowerCase()

  return AgentFocusAliases
    .filter(item => item.aliases.some(alias => (
      normalized.includes(alias.toLowerCase())
    )))
    .map(item => item.knowledgePoint)
    .slice(0, 8)
}

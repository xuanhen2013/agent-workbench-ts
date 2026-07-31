import process from 'node:process'
import { expect, test } from 'bun:test'
import { createCloudflareAiSearchRetrieverFromEnv } from '@/knowledge/cloudflare-ai-search'
import { KnowledgeEvidenceRole } from '@/knowledge/contracts'

test('真实 Cloudflare AI Search 返回可用答案证据 Chunk', async () => {
  const retriever = createCloudflareAiSearchRetrieverFromEnv(process.env)
  if (!retriever) {
    throw new Error(
      'Cloudflare AI Search smoke test requires Account ID + Instance or a Search URL override.',
    )
  }

  const chunks = await retriever.search({
    query: 'Agent 工程 LangGraph Tool Calling Context Memory 核心概念',
    limit: 5,
    filter: {
      evidenceRoles: [KnowledgeEvidenceRole.AnswerEvidence],
    },
    signal: new AbortController().signal,
  })

  expect(chunks.length).toBeGreaterThan(0)
  expect(chunks.every(chunk => (
    chunk.evidenceRole === KnowledgeEvidenceRole.AnswerEvidence
    && chunk.chunkId.startsWith('cloudflare-ai-search:')
    && chunk.text.trim().length > 0
  ))).toBe(true)
}, 30_000)

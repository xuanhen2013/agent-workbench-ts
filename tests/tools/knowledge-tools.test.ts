import type { KnowledgeRetriever, RetrievedChunk } from '@/knowledge/contracts'
import { describe, expect, test } from 'bun:test'
import {
  KnowledgeEvidenceRole,
  KnowledgeSourceType,
} from '@/knowledge/contracts'
import {
  ANSWER_EVIDENCE_LIMIT_PER_SEARCH,
  createSearchAnswerEvidenceTool,
  createSearchQuestionSignalTool,
  MAX_KNOWLEDGE_CHUNK_TEXT_LENGTH,
  QUESTION_SIGNAL_LIMIT_PER_SEARCH,
} from '@/tools/knowledge'

function chunk(
  evidenceRole: KnowledgeEvidenceRole,
  input: { id?: string, text?: string } = {},
): RetrievedChunk {
  return {
    chunkId: input.id ?? `chunk:${evidenceRole}`,
    documentId: 'document:test',
    sourceType: KnowledgeSourceType.UserNote,
    evidenceRole,
    title: 'Test knowledge',
    sourceUri: 'fixture:test',
    heading: 'Test',
    text: input.text ?? 'Test knowledge text.',
    ordinal: 0,
    score: 1,
  }
}

class RecordingRetriever implements Pick<KnowledgeRetriever, 'search'> {
  readonly calls: Parameters<KnowledgeRetriever['search']>[0][] = []

  constructor(private readonly chunks: RetrievedChunk[]) {}

  async search(
    input: Parameters<KnowledgeRetriever['search']>[0],
  ): Promise<RetrievedChunk[]> {
    this.calls.push(input)
    return this.chunks
  }
}

function runtime(signal: AbortSignal) {
  return {
    runId: 'knowledge-tool-test',
    toolCallId: 'knowledge-call-1',
    signal,
  }
}

describe('Knowledge Tools', () => {
  test('Question Tool 固定角色、Top-K 和 AbortSignal', async () => {
    const signal = new AbortController().signal
    const retriever = new RecordingRetriever([
      chunk(KnowledgeEvidenceRole.QuestionSignal),
    ])
    const tool = createSearchQuestionSignalTool(retriever)

    const output = await tool.invoke(
      { query: '  LangGraph 高频误区  ' },
      runtime(signal),
    )

    expect(retriever.calls).toHaveLength(1)
    expect(retriever.calls[0]).toMatchObject({
      query: 'LangGraph 高频误区',
      limit: QUESTION_SIGNAL_LIMIT_PER_SEARCH,
      filter: {
        evidenceRoles: [KnowledgeEvidenceRole.QuestionSignal],
      },
      signal,
    })
    expect(output.chunks).toHaveLength(1)
  })

  test('Answer Tool 固定角色、Top-K，并过滤错误角色', async () => {
    const retriever = new RecordingRetriever([
      chunk(KnowledgeEvidenceRole.AnswerEvidence),
      chunk(KnowledgeEvidenceRole.QuestionSignal),
    ])
    const tool = createSearchAnswerEvidenceTool(retriever)

    const output = await tool.invoke(
      { query: 'LangGraph checkpoint replay' },
      runtime(new AbortController().signal),
    )

    expect(retriever.calls[0]).toMatchObject({
      limit: ANSWER_EVIDENCE_LIMIT_PER_SEARCH,
      filter: {
        evidenceRoles: [KnowledgeEvidenceRole.AnswerEvidence],
      },
    })
    expect(output.chunks.map(item => item.evidenceRole)).toEqual([
      KnowledgeEvidenceRole.AnswerEvidence,
    ])
  })

  test('正文截断到有界长度，空结果保持成功', async () => {
    const longText = 'x'.repeat(MAX_KNOWLEDGE_CHUNK_TEXT_LENGTH + 100)
    const withResult = createSearchAnswerEvidenceTool(
      new RecordingRetriever([
        chunk(KnowledgeEvidenceRole.AnswerEvidence, { text: longText }),
      ]),
    )
    const empty = createSearchAnswerEvidenceTool(new RecordingRetriever([]))

    const output = await withResult.invoke(
      { query: 'LangGraph state update' },
      runtime(new AbortController().signal),
    )
    const emptyOutput = await empty.invoke(
      { query: 'missing evidence query' },
      runtime(new AbortController().signal),
    )

    expect(output.chunks[0]?.text).toHaveLength(
      MAX_KNOWLEDGE_CHUNK_TEXT_LENGTH,
    )
    expect(emptyOutput).toEqual({ chunks: [] })
  })

  test('模型不能提交 role 或 limit 覆盖服务端策略', async () => {
    const retriever = new RecordingRetriever([])
    const tool = createSearchAnswerEvidenceTool(retriever)

    await expect(tool.invoke({
      query: 'LangGraph state update',
      limit: 50,
      evidenceRole: KnowledgeEvidenceRole.QuestionSignal,
    }, runtime(new AbortController().signal))).rejects.toBeDefined()

    expect(retriever.calls).toHaveLength(0)
  })
})

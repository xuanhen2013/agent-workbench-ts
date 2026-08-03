import type { FetchLike } from '@/knowledge/cloudflare-ai-search'
import { describe, expect, test } from 'bun:test'
import {
  CloudflareAiSearchError,
  CloudflareAiSearchErrorCode,
  CloudflareAiSearchRetriever,
  createCloudflareAiSearchRetrieverFromEnv,
} from '@/knowledge/cloudflare-ai-search'
import {
  KnowledgeEvidenceRole,
  KnowledgeSourceType,
} from '@/knowledge/contracts'

function config(fetch: FetchLike) {
  return {
    searchUrl: 'https://search.example.test/search',
    apiToken: 'test-token',
    sourceTypes: [KnowledgeSourceType.Official],
    evidenceRole: KnowledgeEvidenceRole.AnswerEvidence,
    fetch,
  }
}

function signal() {
  return new AbortController().signal
}

describe('CloudflareAiSearchRetriever', () => {
  test('把 Search chunks 归一化为 RetrievedChunk，并发送查询参数', async () => {
    let requestUrl = ''
    let requestInit: RequestInit | undefined
    const fetch: FetchLike = async (input, init) => {
      requestUrl = String(input)
      requestInit = init
      return new Response(JSON.stringify({
        success: true,
        result: {
          chunks: [{
            id: 'chunk-1',
            score: 0.91,
            text: 'StateGraph 的 Node 返回局部状态更新。',
            item: {
              key: 'official/langgraph.md',
              metadata: {
                heading: 'StateGraph',
                evidence_role: 'answer_evidence',
                source_type: 'official',
              },
            },
          }],
        },
      }), { status: 200 })
    }

    const retriever = new CloudflareAiSearchRetriever(config(fetch))
    const result = await retriever.search({
      query: 'StateGraph Node',
      limit: 3,
      filter: { evidenceRoles: [KnowledgeEvidenceRole.AnswerEvidence] },
      signal: signal(),
    })

    expect(requestUrl).toBe('https://search.example.test/search')
    expect(new Headers(requestInit?.headers).get('authorization'))
      .toBe('Bearer test-token')
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      messages: [{ role: 'user', content: 'StateGraph Node' }],
      ai_search_options: {
        retrieval: {
          max_num_results: 3,
          filters: {
            evidence_role: 'answer_evidence',
            source_type: 'official',
          },
        },
      },
    })
    expect(result).toEqual([{
      chunkId: 'cloudflare-ai-search:chunk-1',
      documentId: 'official/langgraph.md',
      sourceType: KnowledgeSourceType.Official,
      evidenceRole: KnowledgeEvidenceRole.AnswerEvidence,
      ownerId: null,
      title: 'official/langgraph.md',
      sourceUri: 'cloudflare-ai-search:official/langgraph.md',
      heading: 'StateGraph',
      text: 'StateGraph 的 Node 返回局部状态更新。',
      ordinal: 0,
      score: 0.91,
    }])
  })

  test('请求另一个证据角色时直接返回空，不访问错误的实例', async () => {
    let called = false
    const fetch: FetchLike = async () => {
      called = true
      return new Response('{}')
    }

    const retriever = new CloudflareAiSearchRetriever(config(fetch))
    const result = await retriever.search({
      query: 'question signal',
      limit: 4,
      filter: { evidenceRoles: [KnowledgeEvidenceRole.QuestionSignal] },
      signal: signal(),
    })

    expect(result).toEqual([])
    expect(called).toBe(false)
  })

  test('不可重试的 HTTP 失败转换为安全的 CloudflareAiSearchError', async () => {
    const fetch: FetchLike = async () => (
      new Response('secret provider error', { status: 400 })
    )
    const retriever = new CloudflareAiSearchRetriever(config(fetch))

    await expect(retriever.search({
      query: 'StateGraph',
      limit: 2,
      signal: signal(),
    })).rejects.toBeInstanceOf(CloudflareAiSearchError)

    try {
      await retriever.search({
        query: 'StateGraph',
        limit: 2,
        signal: signal(),
      })
    }
    catch (error) {
      expect(error).toMatchObject({
        code: CloudflareAiSearchErrorCode.RequestFailed,
        status: 400,
        message: 'Cloudflare AI Search request failed.',
      })
      expect(String(error)).not.toContain('secret provider error')
    }
  })

  test('只读搜索遇到传输失败时最多重试两次', async () => {
    let calls = 0
    const fetch: FetchLike = async () => {
      calls++
      if (calls <= 2)
        throw new TypeError('simulated connection reset')
      return Response.json({ success: true, result: { chunks: [] } })
    }

    const retriever = new CloudflareAiSearchRetriever(config(fetch))
    const result = await retriever.search({
      query: 'StateGraph',
      limit: 2,
      signal: signal(),
    })

    expect(result).toEqual([])
    expect(calls).toBe(3)
  })

  test('鉴权失败不重试', async () => {
    let calls = 0
    const fetch: FetchLike = async () => {
      calls++
      return new Response('unauthorized', { status: 401 })
    }
    const retriever = new CloudflareAiSearchRetriever(config(fetch))

    await expect(retriever.search({
      query: 'StateGraph',
      limit: 2,
      signal: signal(),
    })).rejects.toMatchObject({
      code: CloudflareAiSearchErrorCode.RequestFailed,
      status: 401,
    })
    expect(calls).toBe(1)
  })

  test('响应解析失败不重试', async () => {
    let calls = 0
    // 无效 chunk 会被安全丢弃，整个响应仍是合法结构；用非法顶层响应
    // 验证 InvalidResponse 不会进入重试分支。
    const invalidResponse = new CloudflareAiSearchRetriever(config(async () => {
      calls++
      return Response.json({ success: true, result: {} })
    }))

    await expect(invalidResponse.search({
      query: 'StateGraph',
      limit: 2,
      signal: signal(),
    })).rejects.toMatchObject({
      code: CloudflareAiSearchErrorCode.InvalidResponse,
    })
    expect(calls).toBe(1)
  })

  test('请求和响应正文超时都转换为稳定超时错误', async () => {
    const pendingRequest = new CloudflareAiSearchRetriever({
      ...config(async () => await new Promise<Response>(() => {})),
      timeoutMs: 5,
    })
    await expect(pendingRequest.search({
      query: 'StateGraph',
      limit: 2,
      signal: signal(),
    })).rejects.toMatchObject({
      code: CloudflareAiSearchErrorCode.RequestTimeout,
      message: 'Cloudflare AI Search request timed out.',
    })

    const response = new Response(null, { status: 200 })
    response.json = async () => await new Promise<never>(() => {})
    const pendingBody = new CloudflareAiSearchRetriever({
      ...config(async () => response),
      timeoutMs: 5,
    })
    await expect(pendingBody.search({
      query: 'StateGraph',
      limit: 2,
      signal: signal(),
    })).rejects.toMatchObject({
      code: CloudflareAiSearchErrorCode.RequestTimeout,
    })
  })

  test('没有 Account/Instance 或覆盖 URL 时保持离线模式', () => {
    expect(createCloudflareAiSearchRetrieverFromEnv({})).toBeUndefined()
  })

  test('使用 Account ID 和 Instance Name 生成官方 REST URL', async () => {
    let requestUrl = ''
    const fetch: FetchLike = async (input) => {
      requestUrl = String(input)
      return new Response(JSON.stringify({
        success: true,
        result: { chunks: [] },
      }))
    }
    const retriever = createCloudflareAiSearchRetrieverFromEnv({
      CLOUDFLARE_ACCOUNT_ID: 'account/id',
      CLOUDFLARE_AI_SEARCH_INSTANCE: 'agent search',
      CLOUDFLARE_API_TOKEN: 'token',
    }, { request: fetch })
    if (!retriever)
      throw new Error('Expected Cloudflare retriever.')

    await retriever.search({
      query: 'StateGraph',
      limit: 1,
      signal: signal(),
    })

    expect(requestUrl).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account%2Fid/ai-search/instances/agent%20search/search',
    )
  })

  test('question_signal Retriever 用服务端固定的多来源 Filter', async () => {
    let requestInit: RequestInit | undefined
    const fetch: FetchLike = async (_input, init) => {
      requestInit = init
      return Response.json({ success: true, result: { chunks: [] } })
    }
    const retriever = new CloudflareAiSearchRetriever({
      searchUrl: 'https://search.example.test/search',
      sourceTypes: [
        KnowledgeSourceType.Jd,
        KnowledgeSourceType.InterviewBank,
      ],
      evidenceRole: KnowledgeEvidenceRole.QuestionSignal,
      fetch,
    })

    await retriever.search({
      query: 'Agent 工程岗位常见要求',
      limit: 5,
      filter: { evidenceRoles: [KnowledgeEvidenceRole.QuestionSignal] },
      signal: signal(),
    })

    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      ai_search_options: {
        retrieval: {
          filters: {
            evidence_role: 'question_signal',
            source_type: { $in: ['jd', 'interview_bank'] },
          },
        },
      },
    })
  })

  test('受信任 documentIds 会转换为 Cloudflare filename 精确 Filter', async () => {
    let requestInit: RequestInit | undefined
    const fetch: FetchLike = async (_input, init) => {
      requestInit = init
      return Response.json({ success: true, result: { chunks: [] } })
    }
    const retriever = new CloudflareAiSearchRetriever({
      searchUrl: 'https://search.example.test/search',
      sourceTypes: [KnowledgeSourceType.Jd],
      evidenceRole: KnowledgeEvidenceRole.QuestionSignal,
      fetch,
    })

    await retriever.search({
      query: '岗位职责 任职要求',
      limit: 10,
      filter: {
        documentIds: [
          'question-signal/jd-market/jd-market-abc123.md',
        ],
      },
      signal: signal(),
    })

    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      ai_search_options: {
        retrieval: {
          filters: {
            evidence_role: 'question_signal',
            source_type: 'jd',
            filename: 'jd-market-abc123.md',
          },
        },
      },
    })
  })
})

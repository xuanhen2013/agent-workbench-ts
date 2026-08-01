import type { FetchLike } from '@/knowledge/cloudflare-ai-search'
import { describe, expect, test } from 'bun:test'
import {
  CloudflareAiSearchItemStatus,
  CloudflareAiSearchMetadataType,
  CloudflareAiSearchUploader,
  CloudflareAiSearchUploadError,
  CloudflareAiSearchUploadErrorCode,
  createCloudflareAiSearchUploaderFromEnv,
} from '@/knowledge/cloudflare-ai-search-uploader'

function uploader(fetch: FetchLike) {
  return new CloudflareAiSearchUploader({
    instanceUrl: 'https://api.example.test/instance',
    itemsUrl: 'https://api.example.test/items',
    apiToken: 'secret-token',
    fetch,
  })
}

describe('CloudflareAiSearchUploader', () => {
  test('以带 folder 的 key 上传文件，并附带 JSON metadata', async () => {
    let requestInit: RequestInit | undefined
    const fetch: FetchLike = async (_input, init) => {
      requestInit = init
      return Response.json({
        success: true,
        result: [{
          id: 'item-1',
          key: 'openai-function-calling.md',
          status: 'queued',
          chunks_count: null,
          error: null,
        }],
      })
    }

    const result = await uploader(fetch).upload({
      key: 'official/openai/openai-function-calling.md',
      file: new Blob(['verified content'], { type: 'text/markdown' }),
      metadata: {
        evidence_role: 'answer_evidence',
        source_type: 'official',
      },
    })

    expect(requestInit?.method).toBe('POST')
    expect(new Headers(requestInit?.headers).get('authorization'))
      .toBe('Bearer secret-token')
    expect(new Headers(requestInit?.headers).has('content-type')).toBe(false)
    expect(requestInit?.body).toBeInstanceOf(FormData)

    const file = (requestInit?.body as FormData).get('file')
    expect(file).toBeInstanceOf(File)
    expect((file as File).name)
      .toBe('official/openai/openai-function-calling.md')
    expect(await (file as File).text()).toBe('verified content')
    expect((requestInit?.body as FormData).get('metadata')).toBe(JSON.stringify({
      evidence_role: 'answer_evidence',
      source_type: 'official',
    }))
    expect(result).toEqual({
      id: 'item-1',
      key: 'openai-function-calling.md',
      status: CloudflareAiSearchItemStatus.Queued,
      chunksCount: 0,
      metadata: {},
    })
  })

  test('合并已有字段并只 PUT custom_metadata', async () => {
    const requests: Array<{ url: string, init?: RequestInit }> = []
    const fetch: FetchLike = async (input, init) => {
      requests.push({ url: String(input), init })
      if (init?.method === 'PUT') {
        return Response.json({
          success: true,
          result: {
            custom_metadata: [
              { field_name: 'language', data_type: 'text' },
              { field_name: 'evidence_role', data_type: 'text' },
              { field_name: 'source_type', data_type: 'text' },
            ],
          },
        })
      }

      return Response.json({
        success: true,
        result: {
          custom_metadata: [{ field_name: 'language', data_type: 'text' }],
        },
      })
    }

    const result = await uploader(fetch).ensureMetadataSchema([
      {
        fieldName: 'evidence_role',
        dataType: CloudflareAiSearchMetadataType.Text,
      },
      {
        fieldName: 'source_type',
        dataType: CloudflareAiSearchMetadataType.Text,
      },
    ])

    expect(result.changed).toBe(true)
    expect(requests).toHaveLength(2)
    expect(requests[0]?.url).toBe('https://api.example.test/instance')
    expect(requests[1]?.init?.method).toBe('PUT')
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      custom_metadata: [
        { field_name: 'language', data_type: 'text' },
        { field_name: 'evidence_role', data_type: 'text' },
        { field_name: 'source_type', data_type: 'text' },
      ],
    })
  })

  test('按 key 和 builtin source 查询异步索引状态', async () => {
    let requestUrl = ''
    const fetch: FetchLike = async (input) => {
      requestUrl = String(input)
      return Response.json({
        success: true,
        result: [{
          id: 'item-1',
          key: 'langgraph-graph-api.md',
          status: 'completed',
          chunks_count: 3,
        }],
      })
    }

    const result = await uploader(fetch).listByKey('langgraph-graph-api.md')

    expect(requestUrl).toBe(
      'https://api.example.test/items?key=langgraph-graph-api.md&source=builtin',
    )
    expect(result[0]).toMatchObject({
      status: CloudflareAiSearchItemStatus.Completed,
      chunksCount: 3,
      metadata: {},
    })
  })

  test('HTTP 错误不泄漏 Cloudflare 原始响应', async () => {
    const fetch: FetchLike = async () => (
      new Response('secret provider detail', { status: 403 })
    )

    try {
      await uploader(fetch).listByKey('document.md')
      throw new Error('Expected request to fail.')
    }
    catch (error) {
      expect(error).toBeInstanceOf(CloudflareAiSearchUploadError)
      expect(error).toMatchObject({
        code: CloudflareAiSearchUploadErrorCode.RequestFailed,
        status: 403,
      })
      expect(String(error)).not.toContain('secret provider detail')
    }
  })

  test('从环境变量生成 account-level Items URL', async () => {
    let requestUrl = ''
    const fetch: FetchLike = async (input) => {
      requestUrl = String(input)
      return Response.json({ success: true, result: [] })
    }
    const client = createCloudflareAiSearchUploaderFromEnv({
      CLOUDFLARE_ACCOUNT_ID: 'account/id',
      CLOUDFLARE_AI_SEARCH_INSTANCE: 'agent search',
      CLOUDFLARE_API_TOKEN: 'token',
    }, fetch)

    if (!client)
      throw new Error('Expected uploader.')

    await client.listByKey('document.md')
    expect(requestUrl).toStartWith(
      'https://api.cloudflare.com/client/v4/accounts/account%2Fid/ai-search/instances/agent%20search/items?',
    )
  })

  test('配置不完整时不创建 uploader', () => {
    expect(createCloudflareAiSearchUploaderFromEnv({}))
      .toBeUndefined()
  })
})

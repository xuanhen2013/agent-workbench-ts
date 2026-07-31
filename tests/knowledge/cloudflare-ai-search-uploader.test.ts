import type { FetchLike } from '@/knowledge/cloudflare-ai-search'
import { describe, expect, test } from 'bun:test'
import {
  CloudflareAiSearchItemStatus,
  CloudflareAiSearchUploader,
  CloudflareAiSearchUploadError,
  CloudflareAiSearchUploadErrorCode,
  createCloudflareAiSearchUploaderFromEnv,
} from '@/knowledge/cloudflare-ai-search-uploader'

function uploader(fetch: FetchLike) {
  return new CloudflareAiSearchUploader({
    itemsUrl: 'https://api.example.test/items',
    apiToken: 'secret-token',
    fetch,
  })
}

describe('CloudflareAiSearchUploader', () => {
  test('以 file multipart 字段上传文件，并返回索引状态', async () => {
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
      filename: 'openai-function-calling.md',
      file: new Blob(['verified content'], { type: 'text/markdown' }),
    })

    expect(requestInit?.method).toBe('POST')
    expect(new Headers(requestInit?.headers).get('authorization'))
      .toBe('Bearer secret-token')
    expect(new Headers(requestInit?.headers).has('content-type')).toBe(false)
    expect(requestInit?.body).toBeInstanceOf(FormData)

    const file = (requestInit?.body as FormData).get('file')
    expect(file).toBeInstanceOf(File)
    expect((file as File).name).toBe('openai-function-calling.md')
    expect(await (file as File).text()).toBe('verified content')
    expect(result).toEqual({
      id: 'item-1',
      key: 'openai-function-calling.md',
      status: CloudflareAiSearchItemStatus.Queued,
      chunksCount: 0,
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

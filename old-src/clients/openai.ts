import type { Logger } from 'pino'
import process from 'node:process'
import OpenAI from 'openai'
import { logger as appLogger } from '../logger'

const DEFAULT_MODEL = 'gpt-5.6-luna'

interface ThinkOptions {
  prompt: OpenAI.Responses.ResponseInput
  systemPrompt: string
  tools?: Array<OpenAI.Responses.Tool>
  logger?: Logger
  createOptions?: any
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`缺少环境变量 ${name}`)
  }

  return value
}

function errorDetails(error: unknown) {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
    }
  }

  return {
    errorName: typeof error,
    errorMessage: String(error),
  }
}

export class OpenAiCompatibleClient {
  private readonly client: OpenAI
  private readonly model: string

  constructor() {
    this.client = new OpenAI({
      // baseURL 包含 /v1；SDK 会自动追加 /responses。
      baseURL: readRequiredEnv('OPENROUTER_URL'),
      apiKey: readRequiredEnv('OPENROUTER_KEY'),
      timeout: 60_000,
    })
    this.model = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL
  }

  async think({ prompt, systemPrompt, tools = [], logger, createOptions = {} }: ThinkOptions): Promise<OpenAI.Responses.Response> {
    // 网关会在 output item 上附加 index；它是响应元数据，不能作为下一轮 input 提交。
    const input = prompt.map((item) => {
      const { index: _index, ...inputItem } = item as typeof item & { index?: number }
      return inputItem
    }) as OpenAI.Responses.ResponseInput

    const log = (logger ?? appLogger).child({ component: 'openai', model: this.model })
    const startedAt = performance.now()
    const toolNames = tools.map(tool => tool.type === 'function' ? tool.name : tool.type)

    log.info({ historyItems: input.length, toolNames }, '请求模型')

    try {
      const response = await this.client.responses.create({
        model: this.model,
        instructions: systemPrompt,
        input,
        reasoning: { effort: 'low' },
        tools,
        tool_choice: 'auto',
        parallel_tool_calls: true,
        store: false,
        stream: false,
        ...createOptions,
      })

      if (response.output.length === 0) {
        throw new Error('模型没有返回输出')
      }

      log.info({
        durationMs: Math.round(performance.now() - startedAt),
        outputItemTypes: response.output.map(item => item.type),
        outputTextLength: response.output_text.length,
        responseId: response.id,
      }, '模型响应完成')

      return response
    }
    catch (error) {
      log.error({
        durationMs: Math.round(performance.now() - startedAt),
        ...errorDetails(error),
      }, '模型请求失败')
      throw error
    }
  }
}

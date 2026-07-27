import type OpenAI from 'openai'
import type { OpenAIResponse, OpenAIResponseFunctionTool, OpenAIResponseInputItem } from '@/clients/openai'
import { APIConnectionError } from 'openai'
import {
  toResponseInputItems,
} from 'openai/lib/responses/ResponseInputItems'
import { createAbortedError, executeWithPolicy, FailureCode, FailureKind } from '@/runtime'

export interface ModelTurn {
  continuationItems: OpenAIResponseInputItem[]
  functionCalls: Array<{
    callId: string
    name: string
    arguments: string
  }>
  finalText?: string
}

/**
 * Provider-neutral policy for whether a model turn may call a tool.
 * Concrete model adapters translate this policy to their native API shape.
 */
export type ToolChoicePolicy = 'auto' | 'none' | 'required'

export interface ReActModel {
  runTurn: (input: {
    instructions: string
    history: OpenAIResponseInputItem[]
    tools: OpenAIResponseFunctionTool[]
    signal: AbortSignal
    toolChoice?: ToolChoicePolicy
  }) => Promise<ModelTurn>
}

const networkErrorCodes = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
])

function getHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined
  }

  return typeof error.status === 'number' ? error.status : undefined
}

function hasNetworkErrorCode(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false
  }

  return typeof error.code === 'string' && networkErrorCodes.has(error.code)
}

function isExplicitNetworkError(error: unknown): boolean {
  if (error instanceof APIConnectionError || hasNetworkErrorCode(error)) {
    return true
  }

  return typeof error === 'object'
    && error !== null
    && 'cause' in error
    && hasNetworkErrorCode(error.cause)
}

function classifyModelError(error: unknown) {
  const status = getHttpStatus(error)

  if (status === 429) {
    return {
      kind: FailureKind.Transient,
      code: FailureCode.RateLimited,
      message: 'Model service rate limit reached.',
    }
  }

  if (status !== undefined && status >= 500 && status <= 599) {
    return {
      kind: FailureKind.Transient,
      code: FailureCode.ServiceUnavailable,
      message: 'Model service is temporarily unavailable.',
    }
  }

  if (status === 400 || status === 422) {
    return {
      kind: FailureKind.InvalidInput,
      code: FailureCode.InvalidInput,
      message: 'Model request is invalid.',
    }
  }

  if (isExplicitNetworkError(error)) {
    return {
      kind: FailureKind.Transient,
      code: FailureCode.NetworkError,
      message: 'Model service connection failed.',
    }
  }

  return {
    kind: FailureKind.Internal,
    code: FailureCode.InternalError,
    message: 'Model request failed.',
  }
}

// 这里是做什么的
export function toModelTurn(
  response: Pick<
    OpenAIResponse,
    'output' | 'output_text'
  >,
): ModelTurn {
  // 为什么要做这一步
  const continuationItems = toResponseInputItems(response.output)

  const functionCalls = response.output.flatMap((item) => {
    if (item.type !== 'function_call') {
      return []
    }

    return [{
      callId: item.call_id,
      name: item.name,
      arguments: item.arguments,
    }]
  })

  return {
    continuationItems,
    functionCalls,
    finalText: response.output_text.trim(),
  }
}

export function removeKnownGatewayMetadata(items: OpenAIResponseInputItem[]) {
  return items.map((rawItem) => {
    // @ts-expect-error 去除index
    const { index: _index, ...item } = rawItem

    return item
  })
}

export class OpenAIResponsesModel implements ReActModel {
  private readonly client: OpenAI
  private readonly model: string

  constructor(client: OpenAI, model: string) {
    this.client = client
    this.model = model
  }

  async runTurn(input: {
    instructions: string
    history: OpenAIResponseInputItem[]
    tools: OpenAIResponseFunctionTool[]
    signal: AbortSignal
    toolChoice?: ToolChoicePolicy
  }): Promise<ModelTurn> {
    const response = await executeWithPolicy({
      policy: {
        timeoutMs: 60_000,
        maxAttempts: 2,
        initialDelayMs: 250,
        maxDelayMs: 1_000,
        shouldRetry: failure => failure.kind === FailureKind.Transient,
      },
      parentSignal: input.signal,
      execute: async (signal) => {
        return await this.client.responses.create({
          model: this.model,
          instructions: input.instructions,
          input: input.history,
          tools: input.tools,
          tool_choice: input.toolChoice ?? 'auto',
          parallel_tool_calls: true,
          // Some OpenAI-compatible gateways only return a JSON Response when
          // stream=false is present in the request body, not just transport options.
          stream: false,
          store: false,
        }, {
          maxRetries: 0,
          signal,
        })
      },
      classify: classifyModelError,
      sleep(ms: number, signal: AbortSignal) {
        return new Promise((resolve, reject) => {
          let timer: NodeJS.Timeout
          function signalFn() {
            timer && clearTimeout(timer)
            reject(createAbortedError())
          }
          timer = setTimeout(() => {
            signal.removeEventListener('abort', signalFn)
            resolve()
          }, ms)
          signal.addEventListener('abort', signalFn)
        })
      },
    })

    return toModelTurn(response)
  }
}

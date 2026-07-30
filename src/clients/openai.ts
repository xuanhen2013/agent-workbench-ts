import type { AgentFailure, CallPolicy } from '@/runtime'
import process from 'node:process'
import OpenAI, { APIConnectionError } from 'openai'
import { createAbortedError, executeWithPolicy, FailureCode, FailureKind } from '@/runtime'
import { requiredEnv } from '../config'

export type OpenAIModelClient = Readonly<{
  client: OpenAI
  model: string
}>

export type OpenAIResponseInputItem = OpenAI.Responses.ResponseInputItem

export type OpenAIResponseFunctionTool = OpenAI.Responses.FunctionTool

export type OpenAIResponse = OpenAI.Responses.Response

export function createOpenAIModelClient(
  env: NodeJS.ProcessEnv = process.env,
): OpenAIModelClient {
  const baseURL = requiredEnv(env, 'OPENAI_BASE_URL')
  const apiKey = requiredEnv(env, 'OPENAI_API_KEY')
  const model = requiredEnv(env, 'OPENAI_DEFAULT_MODAL')

  const client = new OpenAI({
    baseURL,
    apiKey,
    timeout: 60_000,
  })

  return {
    client,
    model,
  }
}

// openai metadata
export function removeKnownGatewayMetadata(items: OpenAIResponseInputItem[]) {
  return items.map((rawItem) => {
    // @ts-expect-error 去除index
    const { index: _index, ...item } = rawItem

    return item
  })
}

// executor
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

export class OpenAIResponsesExecutor {
  private readonly client: OpenAI
  private readonly policy: CallPolicy = {
    timeoutMs: 60_000,
    maxAttempts: 2,
    initialDelayMs: 250,
    maxDelayMs: 1_000,
    shouldRetry: failure => failure.kind === FailureKind.Transient,
  }

  private sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  private classify?: (error: unknown) => AgentFailure

  constructor(
    { client, policy, sleep, classify }: {
      client: OpenAI
      policy?: CallPolicy
      classify?: (error: unknown) => AgentFailure
      sleep?: (ms: number, signal: AbortSignal) => Promise<void>
    },
  ) {
    this.client = client
    policy && (this.policy = policy)
    sleep && (this.sleep = sleep)
    classify && (this.classify = classify)
  }

  _sleep(ms: number, signal: AbortSignal): Promise<void> {
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
  }

  runNoStream(
    params: OpenAI.Responses.ResponseCreateParamsNonStreaming,
    options: { signal: AbortSignal },
  ) {
    return executeWithPolicy({
      policy: this.policy,
      parentSignal: options.signal,
      execute: async (signal) => {
        return await this.client.responses.create({
          ...params,
          // Some OpenAI-compatible gateways only return a JSON Response when
          // stream=false is present in the request body, not just transport options.
          stream: false,
          store: false,
        }, {
          maxRetries: 0,
          signal,
        })
      },
      classify: this.classify ?? classifyModelError,
      sleep: this.sleep ?? this._sleep,
    })
  }
}

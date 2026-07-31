import type { AgentFailure, CallPolicy } from '@/runtime'
import process from 'node:process'
import OpenAI from 'openai'
import { createAbortedError, executeWithPolicy, FailureKind } from '@/runtime'
import { requiredEnv } from '../config'
import { classifyOpenAIError } from './openai-errors'

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
      classify: this.classify ?? classifyOpenAIError,
      sleep: this.sleep ?? this._sleep,
    })
  }
}

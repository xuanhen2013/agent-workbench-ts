import type { AgentFailure, CallPolicy } from '@/runtime'
import process from 'node:process'
import OpenAI from 'openai'
import { z } from 'zod/v4'
import { createAbortedError, executeWithPolicy, FailureKind } from '@/runtime'
import { requiredEnv } from '../config'
import { classifyOpenAIError } from './openai-errors'

export type OpenAIReasoningEffort = Exclude<OpenAI.ReasoningEffort, null>

export type OpenAIResponseDefaults = Readonly<{
  /** Provider 默认模型；Workflow 无需逐层传递。 */
  model: string
  /** 默认不在 OpenAI 服务端保存 Response。 */
  store: boolean
  /** Workflow 可以在单次请求中覆盖其中任意字段。 */
  reasoning?: NonNullable<
    OpenAI.Responses.ResponseCreateParamsNonStreaming['reasoning']
  >
}>

export type OpenAIResponseCreateParams = Omit<
  OpenAI.Responses.ResponseCreateParamsNonStreaming,
  'model' | 'stream'
> & {
  /** 只有确实需要切换模型的单次请求才传；默认使用 Provider 配置。 */
  model?: string
}

const OpenAIReasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

/** 可选外部配置只在进入应用时校验一次；留空表示使用模型默认值。 */
export function parseOpenAIReasoningEffort(
  value: string | undefined,
): OpenAIReasoningEffort | undefined {
  const candidate = value?.trim()
  if (!candidate)
    return undefined

  const parsed = OpenAIReasoningEffortSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new Error(
      'Invalid OPENAI_DEFAULT_REASONING_EFFORT. Expected one of: none, minimal, low, medium, high, xhigh, max.',
    )
  }
  return parsed.data
}

export type OpenAIResponseInputItem = OpenAI.Responses.ResponseInputItem

export type OpenAIResponseFunctionTool = OpenAI.Responses.FunctionTool

export type OpenAIResponse = OpenAI.Responses.Response

function readDefaultOpenAIModel(env: NodeJS.ProcessEnv): string {
  const model = env.OPENAI_DEFAULT_MODEL?.trim()
    || env.OPENAI_DEFAULT_MODAL?.trim()

  if (!model) {
    throw new Error(
      'Missing required model environment variable: OPENAI_DEFAULT_MODEL',
    )
  }

  return model
}

/**
 * 应用组合根只调用一次：在 Provider 边界完成环境校验并组装默认参数。
 * OPENAI_DEFAULT_MODAL 是早期拼写错误，暂时仅作为兼容别名保留。
 */
export function createOpenAIResponsesExecutor(
  env: NodeJS.ProcessEnv = process.env,
): OpenAIResponsesExecutor {
  const baseURL = requiredEnv(env, 'OPENAI_BASE_URL')
  const apiKey = requiredEnv(env, 'OPENAI_API_KEY')
  const model = readDefaultOpenAIModel(env)
  const reasoningEffort = parseOpenAIReasoningEffort(
    env.OPENAI_DEFAULT_REASONING_EFFORT,
  )

  const client = new OpenAI({
    baseURL,
    apiKey,
    timeout: 60_000,
  })

  return new OpenAIResponsesExecutor({
    client,
    defaults: {
      model,
      store: false,
      ...(reasoningEffort
        ? { reasoning: { effort: reasoningEffort } }
        : {}),
    },
  })
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
  private readonly defaults: OpenAIResponseDefaults
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
    { client, defaults, policy, sleep, classify }: {
      client: OpenAI
      defaults: OpenAIResponseDefaults
      policy?: CallPolicy
      classify?: (error: unknown) => AgentFailure
      sleep?: (ms: number, signal: AbortSignal) => Promise<void>
    },
  ) {
    this.client = client
    this.defaults = defaults
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
    params: OpenAIResponseCreateParams,
    options: { signal: AbortSignal },
  ) {
    return executeWithPolicy({
      policy: this.policy,
      parentSignal: options.signal,
      execute: async (signal) => {
        const reasoning = params.reasoning === null
          ? null
          : params.reasoning === undefined
            ? this.defaults.reasoning
            : {
                ...this.defaults.reasoning,
                ...params.reasoning,
              }

        return await this.client.responses.create({
          ...params,
          model: params.model ?? this.defaults.model,
          store: params.store ?? this.defaults.store,
          ...(reasoning !== undefined ? { reasoning } : {}),
          // Some OpenAI-compatible gateways only return a JSON Response when
          // stream=false is present in the request body, not just transport options.
          stream: false,
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

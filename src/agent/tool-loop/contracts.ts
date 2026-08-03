import type { Result } from 'neverthrow'
import type {
  OpenAIResponseFunctionTool,
  OpenAIResponseInputItem,
} from '@/clients/openai'
import type { ToolExecutor } from '@/tools/_core'

export type ToolLoopChoice = 'auto' | 'none' | 'required'

export interface ToolLoopUsage {
  inputTokens: number
  cachedTokens: number
  cacheWriteTokens: number
}

export interface ToolLoopError {
  code: string
  message: string
}

export interface ToolLoopCall {
  callId: string
  name: string
  arguments: string
}

export interface ToolLoopModelTurn {
  continuationItems: OpenAIResponseInputItem[]
  functionCalls: ToolLoopCall[]
  finalText?: string
  usage?: ToolLoopUsage
}

export interface ToolLoopToolFailure {
  code: string
  message: string
  runId: string
}

export type ToolLoopToolResult = {
  callId: string
  name: string
} & (
  | { ok: true, output: unknown }
  | { ok: false, error: ToolLoopToolFailure }
)

export interface ToolLoopToolSet {
  definitions: OpenAIResponseFunctionTool[]
  executor: Pick<ToolExecutor, 'execute'>
}

export interface ToolLoopModel {
  runTurn: (input: {
    instructions: string
    history: OpenAIResponseInputItem[]
    tools: OpenAIResponseFunctionTool[]
    signal: AbortSignal
    toolChoice?: ToolLoopChoice
  }) => Promise<ToolLoopModelTurn>
}

export interface ToolLoopPolicy<TDomainState, TFinal> {
  instructions: string

  createInitialHistory: (input: {
    domainState: TDomainState
  }) => OpenAIResponseInputItem[]

  createToolSet: (input: {
    domainState: TDomainState
  }) => ToolLoopToolSet

  beforeToolExecution: (input: {
    domainState: TDomainState
    calls: ToolLoopCall[]
    toolRound: number
  }) => Result<{
    domainState: TDomainState
  }, ToolLoopError>

  reduceToolResults: (input: {
    domainState: TDomainState
    calls: ToolLoopCall[]
    results: ToolLoopToolResult[]
    continuationItems: OpenAIResponseInputItem[]
  }) => Result<{
    domainState: TDomainState
    outputItems: OpenAIResponseInputItem[]
  }, ToolLoopError>

  finalize: (input: {
    domainState: TDomainState
    finalText: string | undefined
    continuationItems: OpenAIResponseInputItem[]
  }) => Result<{
    domainState: TDomainState
    value: TFinal
  }, ToolLoopError>
}

export interface ToolLoopInput<TDomainState> {
  domainState: TDomainState
  maxToolRounds: number
  maxFailures: number
}

export interface ToolLoopOutput<TDomainState, TFinal> {
  domainState: TDomainState
  value: TFinal | null
  continuationItems: OpenAIResponseInputItem[]
  usage: ToolLoopUsage | null
  toolRound: number
  failureCount: number
  error: ToolLoopError | null
}

export interface ToolLoopInvokeOptions {
  runId: string
  signal?: AbortSignal
  recursionLimit?: number
}

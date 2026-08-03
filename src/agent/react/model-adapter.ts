import type {
  ToolLoopModelTurn,
  ToolLoopUsage,
} from '@/agent/tool-loop/contracts'
import type {
  OpenAIResponse,
  OpenAIResponseFunctionTool,
  OpenAIResponseInputItem,
  OpenAIResponsesExecutor,
} from '@/clients/openai'
import {
  toResponseInputItems,
} from 'openai/lib/responses/ResponseInputItems'
import {
  removeKnownGatewayMetadata,
} from '@/clients/openai'

export type ModelTurn = ToolLoopModelTurn

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

// 这里是做什么的
export function toModelTurn(
  response: Pick<
    OpenAIResponse,
    'output' | 'output_text'
  >,
): ModelTurn {
  // 为什么要做这一步
  const continuationItems = removeKnownGatewayMetadata(
    toResponseInputItems(response.output),
  )

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

export function toToolLoopUsage(
  usage: OpenAIResponse['usage'],
): ToolLoopUsage | undefined {
  if (!usage)
    return undefined

  return {
    inputTokens: usage.input_tokens,
    cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: usage.input_tokens_details?.cache_write_tokens ?? 0,
  }
}

export class OpenAIResponsesModel implements ReActModel {
  private readonly executor: OpenAIResponsesExecutor

  constructor(executor: OpenAIResponsesExecutor) {
    this.executor = executor
  }

  async runTurn(input: {
    instructions: string
    history: OpenAIResponseInputItem[]
    tools: OpenAIResponseFunctionTool[]
    signal: AbortSignal
    toolChoice?: ToolChoicePolicy
  }): Promise<ModelTurn> {
    const response = await this.executor.runNoStream({
      instructions: input.instructions,
      input: input.history,
      tools: input.tools,
      tool_choice: input.toolChoice ?? 'auto',
      parallel_tool_calls: true,
    }, {
      signal: input.signal,
    })

    return {
      ...toModelTurn(response),
      usage: toToolLoopUsage(response.usage),
    }
  }
}

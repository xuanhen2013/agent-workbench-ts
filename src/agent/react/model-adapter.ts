import type OpenAI from 'openai'
import type { OpenAIResponse, OpenAIResponseFunctionTool, OpenAIResponseInputItem } from '@/clients/openai'
import {
  toResponseInputItems,
} from 'openai/lib/responses/ResponseInputItems'

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
    // @ts-ignore-error 去除index
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
    const response = await this.client.responses.create({
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
      signal: input.signal,
    })

    return toModelTurn(response)
  }
}

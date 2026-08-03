import type {
  ToolLoopError,
  ToolLoopModel,
  ToolLoopOutput,
  ToolLoopPolicy,
  ToolLoopUsage,
} from './contracts'
import type { ToolLoopState } from './state'
import {
  END,
  START,
  StateGraph,
} from '@langchain/langgraph'
import { z } from 'zod/v4'
import { ToolLoopStateSchema } from './state'

export interface CreateToolLoopGraphOptions<TDomainState, TFinal> {
  model: ToolLoopModel
  policy: ToolLoopPolicy<TDomainState, TFinal>
  initialToolChoice?: 'auto' | 'none' | 'required'
}

function mergeUsage(
  current: ToolLoopUsage | null,
  incoming: ToolLoopUsage | undefined,
): ToolLoopUsage | null {
  if (!incoming)
    return current

  return {
    inputTokens: (current?.inputTokens ?? 0) + incoming.inputTokens,
    cachedTokens: (current?.cachedTokens ?? 0) + incoming.cachedTokens,
    cacheWriteTokens: (current?.cacheWriteTokens ?? 0)
      + incoming.cacheWriteTokens,
  }
}

function genericError(code: string, message: string): ToolLoopError {
  return { code, message }
}

export function asToolLoopOutput<TDomainState, TFinal>(
  state: ToolLoopState,
): ToolLoopOutput<TDomainState, TFinal> {
  return {
    domainState: state.domainState as TDomainState,
    value: state.output as TFinal | null,
    continuationItems: state.lastContinuationItems,
    usage: state.usage,
    toolRound: state.toolRound,
    failureCount: state.failureCount,
    error: state.error,
  }
}

export function createToolLoopGraph<TDomainState, TFinal>(
  options: CreateToolLoopGraphOptions<TDomainState, TFinal>,
) {
  const graph = new StateGraph(ToolLoopStateSchema, {
    context: z.object({ runId: z.string().min(1) }),
  })
    .addNode('initialize', (state, { context }) => {
      const domainState = state.domainState as TDomainState
      const runId = context?.runId
      if (!runId)
        throw new Error('ToolLoop runId is required.')
      return {
        runId,
        conversation: options.policy.createInitialHistory({ domainState }),
        pendingToolCalls: [],
        pendingToolResults: [],
        lastContinuationItems: [],
        finalText: null,
        toolRound: 0,
        failureCount: 0,
        usage: null,
        output: null,
        error: null,
      }
    })
    .addNode('call_model', async (state, { signal }) => {
      try {
        const domainState = state.domainState as TDomainState
        const toolSet = options.policy.createToolSet({ domainState })
        const turn = await options.model.runTurn({
          instructions: options.policy.instructions,
          history: state.conversation,
          tools: toolSet.definitions,
          signal,
          toolChoice: state.toolRound === 0
            ? options.initialToolChoice
            : undefined,
        })

        return {
          pendingToolCalls: turn.functionCalls,
          lastContinuationItems: turn.continuationItems,
          finalText: turn.finalText?.trim() || null,
          usage: mergeUsage(state.usage, turn.usage),
        }
      }
      catch {
        return {
          error: genericError('model_call_failed', 'Model call failed.'),
        }
      }
    })
    .addNode('check_round_budget', (state) => {
      if (state.toolRound >= state.maxToolRounds) {
        return {
          error: genericError(
            'max_tool_rounds',
            'Maximum Tool round budget reached.',
          ),
        }
      }

      if (state.failureCount >= state.maxFailures) {
        return {
          error: genericError(
            'max_failures',
            'Maximum Tool failure budget reached.',
          ),
        }
      }

      const result = options.policy.beforeToolExecution({
        domainState: state.domainState as TDomainState,
        calls: state.pendingToolCalls,
        toolRound: state.toolRound,
      })

      return result.isOk()
        ? { domainState: result.value.domainState }
        : { error: result.error }
    })
    .addNode('execute_tools', async (state, { signal }) => {
      try {
        const toolSet = options.policy.createToolSet({
          domainState: state.domainState as TDomainState,
        })
        const results = await Promise.all(
          state.pendingToolCalls.map(call => toolSet.executor.execute(call, {
            runId: state.runId,
            signal,
          })),
        )

        return {
          pendingToolResults: results,
          toolRound: state.toolRound + 1,
          failureCount: state.failureCount
            + results.filter(result => !result.ok).length,
        }
      }
      catch {
        return {
          error: genericError(
            'tool_execution_failed',
            'Tool execution failed.',
          ),
        }
      }
    })
    .addNode('append_tool_outputs', (state) => {
      const result = options.policy.reduceToolResults({
        domainState: state.domainState as TDomainState,
        calls: state.pendingToolCalls,
        results: state.pendingToolResults,
        continuationItems: state.lastContinuationItems,
      })

      if (result.isErr())
        return { error: result.error }

      return {
        domainState: result.value.domainState,
        conversation: [
          ...state.conversation,
          ...state.lastContinuationItems,
          ...result.value.outputItems,
        ],
        pendingToolCalls: [],
        pendingToolResults: [],
        ...(state.failureCount >= state.maxFailures
          ? {
              error: genericError(
                'max_failures',
                'Maximum Tool failure budget reached.',
              ),
            }
          : {}),
      }
    })
    .addNode('finish', (state) => {
      const result = options.policy.finalize({
        domainState: state.domainState as TDomainState,
        finalText: state.finalText ?? undefined,
        continuationItems: state.lastContinuationItems,
      })

      if (result.isErr())
        return { error: result.error }

      return {
        domainState: result.value.domainState,
        output: result.value.value,
      }
    })
    .addNode('failed', state => ({
      error: state.error ?? genericError(
        'tool_loop_failed',
        'Tool Loop failed.',
      ),
    }))
    .addEdge(START, 'initialize')
    .addEdge('initialize', 'call_model')
    .addConditionalEdges('call_model', (state) => {
      if (state.error)
        return 'failed'
      return state.pendingToolCalls.length > 0
        ? 'check_round_budget'
        : 'finish'
    })
    .addConditionalEdges('check_round_budget', state => (
      state.error ? 'failed' : 'execute_tools'
    ))
    .addConditionalEdges('execute_tools', state => (
      state.error ? 'failed' : 'append_tool_outputs'
    ))
    .addConditionalEdges('append_tool_outputs', (state) => {
      if (state.error)
        return 'failed'
      // 失败 observation 已经回传给模型一次后，如果本轮已经耗尽
      // failure budget，就不再额外调用模型，只做稳定失败收口。
      if (state.failureCount >= state.maxFailures)
        return 'failed'
      return 'call_model'
    })
    .addConditionalEdges('finish', state => (
      state.error ? 'failed' : END
    ))
    .addEdge('failed', END)

  return graph.compile()
}

export type ToolLoopGraph = ReturnType<typeof createToolLoopGraph>

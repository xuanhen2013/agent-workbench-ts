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
import { logger, toSafeErrorLog } from '@/logger'
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

const ToolLoopContextSchema = z.object({ runId: z.string().min(1) })

type ToolLoopContext = z.infer<typeof ToolLoopContextSchema>

function toolLoopLogContext(
  state: ToolLoopState,
  _context: ToolLoopContext | undefined,
) {
  const parts = state.runId.split(':')
  const roundIndex = parts.indexOf('round')
  const categoryIndex = parts.indexOf('category')
  const round = Number(parts[roundIndex + 1])
  const threadId = /^[\da-f-]{36}$/i.test(parts[0] ?? '')
    ? parts[0]
    : undefined
  const categoryId = categoryIndex >= 0
    ? parts[categoryIndex + 1]
    : undefined

  return {
    component: 'tool_loop',
    runId: state.runId,
    ...(threadId ? { threadId } : {}),
    ...(roundIndex >= 0 && Number.isInteger(round) && round > 0
      ? { round }
      : {}),
    ...(categoryId ? { categoryId } : {}),
    toolRound: state.toolRound,
    failureCount: state.failureCount,
  }
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
    context: ToolLoopContextSchema,
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
    .addNode('call_model', async (state, { signal, context }) => {
      const startedAt = performance.now()
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
      catch (error) {
        logger.warn({
          ...toolLoopLogContext(state, context),
          event: 'model_call_failed',
          modelTurn: state.toolRound + 1,
          elapsedMs: Math.round(performance.now() - startedAt),
          ...toSafeErrorLog(error),
        }, 'Tool Loop model call failed')
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
    .addNode('execute_tools', async (state, { signal, context }) => {
      const startedAt = performance.now()
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
      catch (error) {
        logger.warn({
          ...toolLoopLogContext(state, context),
          event: 'tool_execution_failed',
          toolNames: state.pendingToolCalls.map(call => call.name),
          toolCallCount: state.pendingToolCalls.length,
          elapsedMs: Math.round(performance.now() - startedAt),
          ...toSafeErrorLog(error),
        }, 'Tool Loop execution failed')
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
    .addNode('failed', (state, { context }) => {
      const error = state.error ?? genericError(
        'tool_loop_failed',
        'Tool Loop failed.',
      )
      logger.warn({
        ...toolLoopLogContext(state, context),
        event: 'tool_loop_failed',
        toolLoopErrorCode: error.code,
      }, 'Tool Loop failed')
      return { error }
    })
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

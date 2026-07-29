import type { BaseCheckpointSaver } from '@langchain/langgraph'
import type { ReActModel, ToolChoicePolicy } from './model-adapter'
import type { OpenAIResponseFunctionTool, OpenAIResponseInputItem } from '@/clients/openai'
import type { ToolExecutor } from '@/tools/_core'
import { Command, END, ReducedValue, START, StateGraph, StateSchema } from '@langchain/langgraph'
import { z } from 'zod'
import { removeKnownGatewayMetadata } from './model-adapter'
import { ReActStatus } from './state'

export interface CreateReActGraphOptions {
  checkpointer?: BaseCheckpointSaver
}

export interface CreateReActGraphDeps {
  model: ReActModel
  executor: ToolExecutor
  tools: OpenAIResponseFunctionTool[]
  instructions: string
  /** Optional policy applied only to the first model turn. */
  initialToolChoice?: ToolChoicePolicy
}

export function createReActGraph(
  deps: CreateReActGraphDeps,
  options: CreateReActGraphOptions = {},
) {
  // 返回编译后的 StateGraph

  // state
  const reActState = new StateSchema({
    goal: z.string(),
    history: new ReducedValue(
      z.array(z.custom<OpenAIResponseInputItem>()).default(() => []),
      {
        reducer(
          left: OpenAIResponseInputItem[],
          right: OpenAIResponseInputItem[],
        ) {
          return left.concat(removeKnownGatewayMetadata(right))
        },
      },
    ),
    pendingToolCalls: z.array(z.object({
      callId: z.string(),
      name: z.string(),
      arguments: z.string(),
    })),
    candidateAnswer: z.string().optional(),
    toolRounds: z.number().default(0),
    maxToolRounds: z.number().default(5),
    failureCount: z.number().default(0),
    maxFailures: z.number().default(2),
    status: z.enum(ReActStatus).default(ReActStatus.Pending),
    answer: z.string().optional(),
    error: z.object({
      code: z.string(),
      message: z.string(),
    }).optional(),
  })

  function getRunId(runtime: { context?: { runId?: string } }): string {
    if (runtime?.context?.runId) {
      return runtime.context.runId
    }
    throw new Error('runId not found')
  }

  return new StateGraph(reActState, {
    context: z.object({ runId: z.string().min(1) }),
  })
    .addNode('initialize', (state) => {
      return {
        history: [{ role: 'user', content: state.goal }],
        toolRounds: 0,
        status: ReActStatus.Running,
      }
    })
    .addNode('execute_tools', async (state, { signal, context }) => {
      const runId = getRunId({ context })

      const fnCalls = await Promise.all(state.pendingToolCalls.map(async (call) => {
        return await deps.executor.execute({
          name: call.name,
          arguments: call.arguments,
          callId: call.callId,
        }, {
          signal,
          runId,
        })
      }))

      return {
        history: fnCalls.map((call) => {
          return {
            type: 'function_call_output',
            call_id: call.callId,
            output: JSON.stringify(call.ok
              ? {
                  ok: true,
                  data: call.output,
                }
              : {
                  ok: false,
                  error: call.error,
                }),
          }
        }),
        failureCount: state.failureCount + fnCalls.filter(call => !call.ok).length,
        pendingToolCalls: [],
        toolRounds: state.toolRounds + 1,
      }
    }, {
      input: reActState,
      errorHandler: (_, nodeError) => {
        return new Command({
          update: {
            status: ReActStatus.Failed,
            error: {
              code: 'execute_tools_node_error',
              message: `Node ${nodeError.node} failed`,
            },
          },
          goto: 'failed',
        })
      },
      ends: ['failed'],
    })
    .addNode('call_model', async (state, { signal }) => {
      const modelTurn = await deps.model.runTurn({
        instructions: deps.instructions,
        history: state.history,
        tools: deps.tools,
        signal,
        toolChoice: state.toolRounds === 0
          ? deps.initialToolChoice
          : undefined,
      })
      return {
        history: modelTurn.continuationItems,
        pendingToolCalls: modelTurn.functionCalls,
        candidateAnswer: modelTurn.finalText,
      }
    }, {
      input: reActState,
      errorHandler: (_, nodeError) => {
        return new Command({
          update: {
            status: ReActStatus.Failed,
            error: {
              code: 'call_model_node_error',
              message: `Node ${nodeError.node} failed`,
            },
          },
          goto: 'failed',
        })
      },
      ends: ['failed'],
    })
    .addNode('final', async (state) => {
      return { answer: state.candidateAnswer?.trim(), status: ReActStatus.Completed }
    })
    .addNode('failed', async (state, { context }) => {
      const runId = getRunId({ context })
      const _state = {
        status: ReActStatus.Failed,
        error: {
          code: 'unknown error',
          message: `[${runId}] unknown error`,
        },
      }

      if (state.error) {
        return {
          ..._state,
          error: state.error,
        }
      }

      if (state.failureCount >= state.maxFailures) {
        return {
          ..._state,
          error: {
            code: 'max_failures',
            message: `[${runId}] max failures reached`,
          },
        }
      }

      if (state.maxToolRounds <= state.toolRounds) {
        return {
          ..._state,
          error: {
            code: 'max_tool_rounds',
            message: `[${runId}] max tool rounds reached`,
          },
        }
      }

      if (!state.candidateAnswer || !state.candidateAnswer.trim()) {
        return {
          ..._state,
          error: {
            code: 'no_candidate_answer',
            message: `[${runId}] no candidate answer`,
          },
        }
      }

      return _state
    })
    .addEdge(START, 'initialize')
    .addEdge('initialize', 'call_model')
    .addEdge('final', END)
    .addConditionalEdges('execute_tools', async (state) => {
      if (state.failureCount >= state.maxFailures) {
        return 'failed'
      }
      return 'call_model'
    })
    .addConditionalEdges('call_model', async (state) => {
      if (state.pendingToolCalls.length) {
        if (
          state.maxToolRounds <= state.toolRounds
          || state.failureCount >= state.maxFailures
        ) {
          return 'failed'
        }
        return 'execute_tools'
      }

      if (state.candidateAnswer?.trim()) {
        return 'final'
      }

      return 'failed'
    })
    .compile({
      checkpointer: options.checkpointer,
    })
}

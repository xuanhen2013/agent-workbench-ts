import type { BaseCheckpointSaver } from '@langchain/langgraph'
import type { ReActModel, ToolChoicePolicy } from './model-adapter'
import type {
  ToolLoopToolResult,
} from '@/agent/tool-loop/contracts'
import type { OpenAIResponseFunctionTool, OpenAIResponseInputItem } from '@/clients/openai'
import type { ToolExecutor } from '@/tools/_core'
import { END, START, StateGraph, StateSchema } from '@langchain/langgraph'
import { err, ok } from 'neverthrow'
import { z } from 'zod/v4'
import { createToolLoopGraph } from '@/agent/tool-loop/graph'
import { removeKnownGatewayMetadata } from '@/clients/openai'
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

interface ReActDomainState {
  goal: string
  history: OpenAIResponseInputItem[]
}

function toObservation(result: ToolLoopToolResult) {
  return {
    type: 'function_call_output' as const,
    call_id: result.callId,
    output: JSON.stringify(result.ok
      ? { ok: true, data: result.output }
      : { ok: false, error: result.error }),
  }
}

function getRunId(runtime: { context?: { runId?: string } }): string {
  const runId = runtime.context?.runId
  if (runId)
    return runId
  throw new Error('runId not found')
}

function mapLoopError(error: { code: string, message: string }) {
  if (error.code === 'model_call_failed') {
    return {
      code: 'call_model_node_error',
      message: 'Model call failed.',
    }
  }

  return {
    code: error.code,
    message: error.message,
  }
}

export function createReActGraph(
  deps: CreateReActGraphDeps,
  options: CreateReActGraphOptions = {},
) {
  const toolLoop = createToolLoopGraph<ReActDomainState, { answer: string }>({
    model: deps.model,
    policy: {
      instructions: deps.instructions,

      createInitialHistory({ domainState }) {
        return domainState.history
      },

      createToolSet() {
        return {
          definitions: deps.tools,
          executor: deps.executor,
        }
      },

      beforeToolExecution: ({ domainState }) => ok({ domainState }),

      reduceToolResults({
        domainState,
        results,
        continuationItems,
      }) {
        const outputItems = results.map(toObservation)
        return ok({
          domainState: {
            ...domainState,
            history: [
              ...domainState.history,
              ...removeKnownGatewayMetadata(continuationItems),
              ...outputItems,
            ],
          },
          outputItems,
        })
      },

      finalize({ domainState, finalText, continuationItems }) {
        const answer = finalText?.trim()
        if (!answer) {
          return err({
            code: 'no_candidate_answer',
            message: 'The model did not provide a candidate answer.',
          })
        }

        return ok({
          domainState: {
            ...domainState,
            history: [
              ...domainState.history,
              ...removeKnownGatewayMetadata(continuationItems),
            ],
          },
          value: { answer },
        })
      },
    },
    initialToolChoice: deps.initialToolChoice,
  })

  const reActState = new StateSchema({
    goal: z.string(),
    // ToolLoop 会返回完整 history，所以这里不能再用自动 concat 的 Reducer。
    history: z.array(z.custom<OpenAIResponseInputItem>()).default(() => []),
    pendingToolCalls: z.array(z.object({
      callId: z.string(),
      name: z.string(),
      arguments: z.string(),
    })).default(() => []),
    candidateAnswer: z.string().optional(),
    toolRounds: z.number().int().nonnegative().default(0),
    maxToolRounds: z.number().int().positive().default(5),
    failureCount: z.number().int().nonnegative().default(0),
    maxFailures: z.number().int().positive().default(2),
    status: z.enum(ReActStatus).default(ReActStatus.Pending),
    answer: z.string().optional(),
    error: z.object({
      code: z.string(),
      message: z.string(),
    }).optional(),
  })

  return new StateGraph(reActState, {
    context: z.object({ runId: z.string().min(1) }),
  })
    .addNode('initialize', state => ({
      history: [{ role: 'user', content: state.goal }],
      pendingToolCalls: [],
      candidateAnswer: undefined,
      toolRounds: 0,
      failureCount: 0,
      status: ReActStatus.Running,
      answer: undefined,
      error: undefined,
    }))
    .addNode('tool_loop', async (state, runtime) => {
      try {
        const runId = getRunId(runtime)
        const loopState = await toolLoop.invoke({
          domainState: {
            goal: state.goal,
            history: state.history,
          },
          maxToolRounds: state.maxToolRounds,
          maxFailures: state.maxFailures,
        }, {
          context: { runId },
          signal: runtime.signal,
          recursionLimit: 100,
        })

        const domainState = loopState.domainState as ReActDomainState
        const error = loopState.error
          ? mapLoopError(loopState.error)
          : undefined
        const answer = loopState.output as { answer: string } | null

        return {
          history: domainState.history,
          pendingToolCalls: [],
          candidateAnswer: loopState.finalText ?? undefined,
          toolRounds: loopState.toolRound,
          failureCount: loopState.failureCount,
          ...(error
            ? { status: ReActStatus.Failed, error }
            : {
                status: ReActStatus.Completed,
                answer: answer?.answer,
              }),
        }
      }
      catch {
        return {
          status: ReActStatus.Failed,
          error: {
            code: 'call_model_node_error',
            message: 'Tool loop failed.',
          },
        }
      }
    })
    .addEdge(START, 'initialize')
    .addEdge('initialize', 'tool_loop')
    .addEdge('tool_loop', END)
    .compile({ checkpointer: options.checkpointer })
}

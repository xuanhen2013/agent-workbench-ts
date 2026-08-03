import type {
  ToolLoopModelTurn,
  ToolLoopPolicy,
} from '@/agent/tool-loop/contracts'
import type { OpenAIResponseInputItem } from '@/clients/openai'
import { describe, expect, test } from 'bun:test'
import { err, ok } from 'neverthrow'
import { asToolLoopOutput, createToolLoopGraph } from '@/agent/tool-loop/graph'
import { ToolExecutionErrorType } from '@/tools/_core'

interface DomainState {
  history: OpenAIResponseInputItem[]
  reducedOutputs: unknown[]
}

function createPolicy(): ToolLoopPolicy<DomainState, string> {
  return {
    instructions: 'test',
    createInitialHistory: ({ domainState }) => domainState.history,
    createToolSet: () => ({
      definitions: [],
      executor: {
        async execute(call) {
          return {
            ok: true as const,
            callId: call.callId,
            name: call.name,
            output: { callId: call.callId, value: call.name },
          }
        },
      },
    }),
    beforeToolExecution: ({ domainState }) => ok({ domainState }),
    reduceToolResults: ({
      domainState,
      results,
      continuationItems,
    }) => ok({
      domainState: {
        history: [
          ...domainState.history,
          ...continuationItems,
          ...results.map(result => ({
            type: 'function_call_output' as const,
            call_id: result.callId,
            output: JSON.stringify(result.ok ? result.output : result.error),
          })),
        ],
        reducedOutputs: [
          ...domainState.reducedOutputs,
          ...results.map(result => result.ok ? result.output : result.error),
        ],
      },
      outputItems: results.map(result => ({
        type: 'function_call_output' as const,
        call_id: result.callId,
        output: JSON.stringify(result.ok ? result.output : result.error),
      })),
    }),
    finalize: ({ domainState, finalText, continuationItems }) => {
      const text = finalText?.trim()
      if (!text) {
        return err({
          code: 'empty_final_text',
          message: 'empty final text',
        })
      }

      return ok({
        domainState: {
          ...domainState,
          history: [...domainState.history, ...continuationItems],
        },
        value: text,
      })
    },
  }
}

function turn(input: Partial<ToolLoopModelTurn>): ToolLoopModelTurn {
  return {
    continuationItems: input.continuationItems ?? [],
    functionCalls: input.functionCalls ?? [],
    ...(input.finalText !== undefined ? { finalText: input.finalText } : {}),
  }
}

function invokeInput() {
  return {
    domainState: {
      history: [{ role: 'user', content: 'hello' } satisfies OpenAIResponseInputItem],
      reducedOutputs: [],
    },
    maxToolRounds: 3,
    maxFailures: 2,
  }
}

describe('ToolLoopGraph', () => {
  test('无 Tool Call 时直接 finalize，并保留领域最终消息', async () => {
    const model = {
      async runTurn() {
        return turn({
          continuationItems: [{ role: 'assistant', content: 'done' }],
          finalText: 'done',
        })
      },
    }
    const graph = createToolLoopGraph({
      model,
      policy: createPolicy(),
    })

    const state = await graph.invoke(invokeInput(), {
      context: { runId: 'tool-loop-direct' },
    })
    const output = asToolLoopOutput<DomainState, string>(state)

    expect(output.value).toBe('done')
    expect(output.toolRound).toBe(0)
    expect(output.domainState.history).toContainEqual({
      role: 'assistant',
      content: 'done',
    })
  })

  test('Tool round 保留原始 function_call，并按 call_id 回填 output', async () => {
    const histories: OpenAIResponseInputItem[][] = []
    const model = {
      async runTurn(input: { history: OpenAIResponseInputItem[] }) {
        histories.push(input.history)
        if (histories.length === 1) {
          return turn({
            continuationItems: [{
              type: 'function_call',
              call_id: 'call-a',
              name: 'lookup',
              arguments: '{}',
            }],
            functionCalls: [{
              callId: 'call-a',
              name: 'lookup',
              arguments: '{}',
            }],
          })
        }
        return turn({ finalText: 'tool result used' })
      },
    }
    const graph = createToolLoopGraph({
      model,
      policy: createPolicy(),
    })

    const state = await graph.invoke(invokeInput(), {
      context: { runId: 'tool-loop-roundtrip' },
    })
    const output = asToolLoopOutput<DomainState, string>(state)
    const secondHistory = histories[1] ?? []

    expect(output.value).toBe('tool result used')
    expect(output.toolRound).toBe(1)
    expect(secondHistory).toContainEqual({
      type: 'function_call',
      call_id: 'call-a',
      name: 'lookup',
      arguments: '{}',
    })
    expect(secondHistory).toContainEqual(expect.objectContaining({
      type: 'function_call_output',
      call_id: 'call-a',
    }))
  })

  test('达到 failure budget 后不再调用模型，并返回稳定错误', async () => {
    let modelCalls = 0
    const model = {
      async runTurn() {
        modelCalls += 1
        return turn({
          continuationItems: [{
            type: 'function_call',
            call_id: `failed-${modelCalls}`,
            name: 'missing',
            arguments: '{}',
          }],
          functionCalls: [{
            callId: `failed-${modelCalls}`,
            name: 'missing',
            arguments: '{}',
          }],
        })
      },
    }
    const policy = createPolicy()
    policy.createToolSet = () => ({
      definitions: [],
      executor: {
        async execute(call) {
          return {
            ok: false,
            callId: call.callId,
            name: call.name,
            error: {
              code: ToolExecutionErrorType.UNKNOWN_TOOL,
              message: 'unknown tool',
              runId: 'tool-loop-failure',
            },
          }
        },
      },
    })
    const graph = createToolLoopGraph({ model, policy })

    const state = await graph.invoke({
      ...invokeInput(),
      maxFailures: 1,
    }, {
      context: { runId: 'tool-loop-failure' },
    })
    const output = asToolLoopOutput<DomainState, string>(state)

    expect(modelCalls).toBe(1)
    expect(output.failureCount).toBe(1)
    expect(output.error?.code).toBe('max_failures')
  })

  test('不同 invoke 不共享上一次的 ToolLoop State', async () => {
    let counter = 0
    const graph = createToolLoopGraph({
      model: {
        async runTurn() {
          counter += 1
          return turn({ finalText: `run-${counter}` })
        },
      },
      policy: createPolicy(),
    })

    const first = await graph.invoke(invokeInput(), {
      context: { runId: 'isolated-a' },
    })
    const second = await graph.invoke(invokeInput(), {
      context: { runId: 'isolated-b' },
    })

    expect(asToolLoopOutput(first).toolRound).toBe(0)
    expect(asToolLoopOutput(second).toolRound).toBe(0)
    expect(asToolLoopOutput(first).failureCount).toBe(0)
    expect(asToolLoopOutput(second).failureCount).toBe(0)
  })
})

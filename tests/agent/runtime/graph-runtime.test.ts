import type { StateSnapshot } from '@langchain/langgraph'
import type { ManagedGraphPort } from '@/runs/graph-runtime'
import { describe, expect, test } from 'bun:test'
import { GraphRuntime } from '@/runs/graph-runtime'
import { RunIndex, RunStatus } from '@/runs/run-index'

interface SimpleInput { goal: string }
interface SimpleOutput { status: 'completed' | 'failed', answer?: string, error?: { code: string, message: string } }

function snapshot(values: SimpleOutput): StateSnapshot {
  return {
    values,
    next: [],
    tasks: [],
    config: { configurable: { thread_id: 'thread' } },
    metadata: {},
    createdAt: '2026-07-29T00:00:00.000Z',
    parentConfig: undefined,
  } as unknown as StateSnapshot
}

describe('GraphRuntime generic start', () => {
  test('terminal Graph 投影为 completed', async () => {
    const graph: ManagedGraphPort<SimpleInput, SimpleOutput> = {
      async invoke() {
        return { status: 'completed', answer: 'done' }
      },
      async getState() {
        return snapshot({ status: 'completed', answer: 'done' })
      },
    }
    const runtime = new GraphRuntime({ graph, runs: new RunIndex() })

    const result = await runtime.start({ goal: 'finish' }, {
      runId: 'run-complete',
      threadId: 'thread-complete',
    })

    expect(result).toMatchObject({
      ok: true,
      run: { status: RunStatus.Completed },
      output: { answer: 'done' },
    })
  })

  test('Graph 异常只返回稳定错误', async () => {
    const graph: ManagedGraphPort<SimpleInput, SimpleOutput> = {
      async invoke() {
        throw new Error('sensitive')
      },
      async getState() {
        throw new Error('not reached')
      },
    }
    const runtime = new GraphRuntime({ graph, runs: new RunIndex() })

    expect(await runtime.start({ goal: 'fail' }, {
      runId: 'run-fail',
      threadId: 'thread-fail',
    })).toEqual({
      ok: false,
      error: {
        code: 'graph_runtime_error',
        message: 'The graph execution failed unexpectedly.',
      },
    })
  })
})

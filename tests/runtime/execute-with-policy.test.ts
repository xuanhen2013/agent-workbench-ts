import type { AgentFailure, CallPolicy } from '@/runtime/reliability/execute-with-policy'
import { describe, expect, test, vi } from 'bun:test'
import {
  AgentCallError,
  executeWithPolicy,
  FailureCode,
  FailureKind,
} from '@/runtime/reliability/execute-with-policy'

function transientFailure(message = 'The upstream service is unavailable.'): AgentFailure {
  return {
    kind: FailureKind.Transient,
    code: FailureCode.ServiceUnavailable,
    message,
  }
}

function createPolicy(overrides: Partial<CallPolicy> = {}): CallPolicy {
  return {
    timeoutMs: 1_000,
    maxAttempts: 3,
    initialDelayMs: 100,
    maxDelayMs: 500,
    shouldRetry: () => true,
    ...overrides,
  }
}

function expectAgentCallError(
  error: unknown,
  expectedFailure: AgentFailure,
): asserts error is AgentCallError {
  expect(error).toBeInstanceOf(AgentCallError)
  expect((error as AgentCallError).failure).toEqual(expectedFailure)
}

describe('executeWithPolicy', () => {
  test('首次 transient 失败后以第一次退避延迟重试，并在第二次成功时返回结果', async () => {
    let attempts = 0
    const sleepCalls: number[] = []
    const firstFailure = transientFailure('fake 503')
    const expectedWeather = { city: '深圳', condition: 'Sunny' }

    const result = await executeWithPolicy({
      policy: createPolicy(),
      parentSignal: new AbortController().signal,
      async execute() {
        attempts += 1
        if (attempts === 1) {
          throw new Error('fake 503')
        }

        return expectedWeather
      },
      classify: () => firstFailure,
      async sleep(ms) {
        sleepCalls.push(ms)
      },
    })

    expect(result).toEqual(expectedWeather)
    expect(attempts).toBe(2)
    expect(sleepCalls).toEqual([100])
  })

  test('首次成功时不 sleep', async () => {
    let executeCalls = 0
    const sleepCalls: number[] = []

    const result = await executeWithPolicy({
      policy: createPolicy(),
      parentSignal: new AbortController().signal,
      async execute() {
        executeCalls += 1
        return 'ready'
      },
      classify: () => transientFailure(),
      async sleep(ms) {
        sleepCalls.push(ms)
      },
    })

    expect(result).toBe('ready')
    expect(executeCalls).toBe(1)
    expect(sleepCalls).toEqual([])
  })

  test('invalid_input 不重试、不 sleep，并保留分类后的 failure', async () => {
    let executeCalls = 0
    const sleepCalls: number[] = []
    const invalidInput: AgentFailure = {
      kind: FailureKind.InvalidInput,
      code: FailureCode.InvalidInput,
      message: 'city is required',
    }

    try {
      await executeWithPolicy({
        policy: createPolicy(),
        parentSignal: new AbortController().signal,
        async execute() {
          executeCalls += 1
          throw new Error('invalid city')
        },
        classify: () => invalidInput,
        async sleep(ms) {
          sleepCalls.push(ms)
        },
      })
      throw new Error('Expected executeWithPolicy to reject')
    }
    catch (error) {
      expectAgentCallError(error, invalidInput)
    }

    expect(executeCalls).toBe(1)
    expect(sleepCalls).toEqual([])
  })

  test('transient 一直失败到 maxAttempts 时保留最后 failure，且最后一次后不 sleep', async () => {
    let executeCalls = 0
    const sleepCalls: number[] = []

    try {
      await executeWithPolicy({
        policy: createPolicy({ maxAttempts: 3 }),
        parentSignal: new AbortController().signal,
        async execute() {
          executeCalls += 1
          throw new Error(`transient failure ${executeCalls}`)
        },
        classify(error) {
          return transientFailure(
            error instanceof Error ? error.message : 'unexpected failure',
          )
        },
        async sleep(ms) {
          sleepCalls.push(ms)
        },
      })
      throw new Error('Expected executeWithPolicy to reject')
    }
    catch (error) {
      expectAgentCallError(error, transientFailure('transient failure 3'))
    }

    expect(executeCalls).toBe(3)
    expect(sleepCalls).toEqual([100, 200])
  })

  test('uncertain_side_effect 即使 shouldRetry 返回 true 也不重试', async () => {
    let executeCalls = 0
    let shouldRetryCalls = 0
    const sleepCalls: number[] = []
    const uncertainSideEffect: AgentFailure = {
      kind: FailureKind.UncertainSideEffect,
      code: FailureCode.UncertainSideEffect,
      message: 'The write may already have succeeded.',
    }

    try {
      await executeWithPolicy({
        policy: createPolicy({
          shouldRetry() {
            shouldRetryCalls += 1
            return true
          },
        }),
        parentSignal: new AbortController().signal,
        async execute() {
          executeCalls += 1
          throw new Error('write outcome unknown')
        },
        classify: () => uncertainSideEffect,
        async sleep(ms) {
          sleepCalls.push(ms)
        },
      })
      throw new Error('Expected executeWithPolicy to reject')
    }
    catch (error) {
      expectAgentCallError(error, uncertainSideEffect)
    }

    expect(executeCalls).toBe(1)
    expect(shouldRetryCalls).toBe(0)
    expect(sleepCalls).toEqual([])
  })

  test('timeout 会 abort attempt signal 并抛出 AttemptTimeout', async () => {
    vi.useFakeTimers()
    let receivedSignal: AbortSignal | undefined
    let executeCalls = 0
    const sleepCalls: number[] = []

    try {
      const operation = executeWithPolicy({
        policy: createPolicy({ timeoutMs: 100, maxAttempts: 1 }),
        parentSignal: new AbortController().signal,
        async execute(signal) {
          executeCalls += 1
          receivedSignal = signal
          return await new Promise<never>(() => {})
        },
        classify: () => transientFailure(),
        async sleep(ms) {
          sleepCalls.push(ms)
        },
      })

      expect(receivedSignal?.aborted).toBe(false)
      vi.advanceTimersByTime(100)

      try {
        await operation
        throw new Error('Expected executeWithPolicy to reject')
      }
      catch (error) {
        expectAgentCallError(error, {
          kind: FailureKind.Timeout,
          code: FailureCode.AttemptTimeout,
          message: 'The attempt timed out after 100 ms.',
        })
      }

      expect(executeCalls).toBe(1)
      expect(receivedSignal?.aborted).toBe(true)
      expect((receivedSignal?.reason as AgentCallError).failure).toEqual({
        kind: FailureKind.Timeout,
        code: FailureCode.AttemptTimeout,
        message: 'The attempt timed out after 100 ms.',
      })
      expect(sleepCalls).toEqual([])
    }
    finally {
      vi.useRealTimers()
    }
  }, 1_000)

  test('parentSignal 在调用前已 aborted 时不执行 execute，并抛出 OperationAborted', async () => {
    const parentController = new AbortController()
    parentController.abort()
    let executeCalls = 0
    const sleepCalls: number[] = []

    try {
      await executeWithPolicy({
        policy: createPolicy(),
        parentSignal: parentController.signal,
        async execute() {
          executeCalls += 1
          return 'not reached'
        },
        classify: () => transientFailure(),
        async sleep(ms) {
          sleepCalls.push(ms)
        },
      })
      throw new Error('Expected executeWithPolicy to reject')
    }
    catch (error) {
      expectAgentCallError(error, {
        kind: FailureKind.Aborted,
        code: FailureCode.OperationAborted,
        message: 'The operation was cancelled.',
      })
    }

    expect(executeCalls).toBe(0)
    expect(sleepCalls).toEqual([])
  })

  test('执行期间 parent abort 会终止 attempt signal，不再进入下一次 attempt', async () => {
    const parentController = new AbortController()
    let executeCalls = 0
    let receivedSignal: AbortSignal | undefined
    const sleepCalls: number[] = []

    const operation = executeWithPolicy({
      policy: createPolicy(),
      parentSignal: parentController.signal,
      async execute(signal) {
        executeCalls += 1
        receivedSignal = signal
        return await new Promise<never>(() => {})
      },
      classify: () => transientFailure(),
      async sleep(ms) {
        sleepCalls.push(ms)
      },
    })

    expect(executeCalls).toBe(1)
    expect(receivedSignal?.aborted).toBe(false)
    parentController.abort()

    try {
      await operation
      throw new Error('Expected executeWithPolicy to reject')
    }
    catch (error) {
      expectAgentCallError(error, {
        kind: FailureKind.Aborted,
        code: FailureCode.OperationAborted,
        message: 'The operation was cancelled.',
      })
    }

    expect(receivedSignal?.aborted).toBe(true)
    expect((receivedSignal?.reason as AgentCallError).failure).toEqual({
      kind: FailureKind.Aborted,
      code: FailureCode.OperationAborted,
      message: 'The operation was cancelled.',
    })
    expect(executeCalls).toBe(1)
    expect(sleepCalls).toEqual([])
  })

  test('maxAttempts 为 0 时抛出 RangeError，且不执行 attempt', async () => {
    let executeCalls = 0

    await expect(
      executeWithPolicy({
        policy: createPolicy({ maxAttempts: 0 }),
        parentSignal: new AbortController().signal,
        async execute() {
          executeCalls += 1
          return 'not reached'
        },
        classify: () => transientFailure(),
        async sleep() {},
      }),
    ).rejects.toThrow(RangeError)

    expect(executeCalls).toBe(0)
  })
})

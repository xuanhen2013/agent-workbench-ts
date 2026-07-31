import type OpenAI from 'openai'
import type {
  OpenAIResponse,
  OpenAIResponseFunctionTool,
  OpenAIResponseInputItem,
} from '@/clients/openai'
import { describe, expect, test, vi } from 'bun:test'
import {
  OpenAIResponsesModel,
  toModelTurn,
} from '@/agent/react/model-adapter'
import {
  OpenAIResponsesExecutor,
  parseOpenAIReasoningEffort,
} from '@/clients/openai'
import { AgentCallError, FailureCode, FailureKind } from '@/runtime'

function response(outputText = 'Model completed the turn'): OpenAIResponse {
  return {
    output: [],
    output_text: outputText,
  } as unknown as OpenAIResponse
}

function statusError(status: number, message = 'sensitive gateway error') {
  return Object.assign(new Error(message), { status })
}

function fakeClient(create: (request: unknown, options: unknown) => Promise<OpenAIResponse>): OpenAI {
  return {
    responses: { create },
  } as unknown as OpenAI
}

function createModel(
  client: OpenAI,
  reasoning?: OpenAIResponseCreateReasoning,
) {
  return new OpenAIResponsesModel(new OpenAIResponsesExecutor({
    client,
    defaults: {
      model: 'fake-model',
      store: false,
      ...(reasoning ? { reasoning } : {}),
    },
  }))
}

type OpenAIResponseCreateReasoning = NonNullable<
  OpenAI.Responses.ResponseCreateParamsNonStreaming['reasoning']
>

function modelInput(signal: AbortSignal, toolChoice: 'auto' | 'none' | 'required' = 'auto') {
  return {
    instructions: 'Reply safely.',
    history: [] as OpenAIResponseInputItem[],
    tools: [] as OpenAIResponseFunctionTool[],
    signal,
    toolChoice,
  }
}

function expectFailure(
  error: unknown,
  kind: FailureKind,
  code: FailureCode,
): asserts error is AgentCallError {
  expect(error).toBeInstanceOf(AgentCallError)
  expect((error as AgentCallError).failure).toMatchObject({ kind, code })
}

async function advanceRetryDelay(ms: number) {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
  }

  vi.advanceTimersByTime(ms)
}

describe('OpenAIResponsesModel reliability', () => {
  test('Provider 默认 model、store 和 reasoning 进入 Responses 请求', async () => {
    expect(parseOpenAIReasoningEffort(undefined)).toBeUndefined()
    expect(parseOpenAIReasoningEffort(' high ')).toBe('high')
    expect(() => parseOpenAIReasoningEffort('extreme')).toThrow(
      'Invalid OPENAI_DEFAULT_REASONING_EFFORT',
    )

    let receivedRequest: Record<string, unknown> | undefined
    const model = createModel(fakeClient(async (request) => {
      receivedRequest = request as Record<string, unknown>
      return response()
    }), { effort: 'high' })

    await model.runTurn(modelInput(new AbortController().signal))

    expect(receivedRequest?.model).toBe('fake-model')
    expect(receivedRequest?.store).toBe(false)
    expect(receivedRequest?.reasoning).toEqual({ effort: 'high' })
  })

  test('单次请求可以覆盖 Provider 默认值，并合并 reasoning 字段', async () => {
    let receivedRequest: Record<string, unknown> | undefined
    const executor = new OpenAIResponsesExecutor({
      client: fakeClient(async (request) => {
        receivedRequest = request as Record<string, unknown>
        return response()
      }),
      defaults: {
        model: 'default-model',
        store: false,
        reasoning: { effort: 'medium', summary: 'auto' },
      },
    })

    await executor.runNoStream({
      model: 'override-model',
      store: true,
      reasoning: { effort: 'high' },
      input: 'test',
    }, { signal: new AbortController().signal })

    expect(receivedRequest).toMatchObject({
      model: 'override-model',
      store: true,
      reasoning: { effort: 'high', summary: 'auto' },
      stream: false,
    })
  })

  test('toModelTurn 去除兼容网关附加的 index 后再续传', () => {
    const turn = toModelTurn({
      output: [{
        type: 'function_call',
        id: 'function-call-id',
        call_id: 'call-id',
        name: 'load_skill',
        arguments: '{}',
        status: 'completed',
        index: 0,
      }],
      output_text: '',
    } as unknown as OpenAIResponse)

    expect(turn.functionCalls).toEqual([{
      callId: 'call-id',
      name: 'load_skill',
      arguments: '{}',
    }])
    expect(turn.continuationItems).toHaveLength(1)
    expect(turn.continuationItems[0]).not.toHaveProperty('index')
  })

  test('503 第一次失败、第二次成功时仅重试 SDK create，并保留请求参数', async () => {
    vi.useFakeTimers()
    let createCalls = 0
    const requests: Array<Record<string, unknown>> = []
    const requestOptions: Array<Record<string, unknown>> = []
    const model = createModel(fakeClient(async (request, options) => {
      createCalls += 1
      requests.push(request as Record<string, unknown>)
      requestOptions.push(options as Record<string, unknown>)
      if (createCalls === 1) {
        throw statusError(503)
      }

      return response()
    }))

    try {
      const operation = model.runTurn(modelInput(new AbortController().signal, 'required'))

      await advanceRetryDelay(250)

      await expect(operation).resolves.toEqual({
        continuationItems: [],
        functionCalls: [],
        finalText: 'Model completed the turn',
      })
      expect(createCalls).toBe(2)
      expect(requests[0]).toMatchObject({
        tool_choice: 'required',
        parallel_tool_calls: true,
        stream: false,
        store: false,
      })
      expect(requestOptions).toHaveLength(2)
      expect(requestOptions.every(options => options.maxRetries === 0)).toBe(true)
    }
    finally {
      vi.useRealTimers()
    }
  })

  test('429 可重试，并在第二次 SDK create 成功时完成 turn', async () => {
    vi.useFakeTimers()
    let createCalls = 0
    const model = createModel(fakeClient(async () => {
      createCalls += 1
      if (createCalls === 1) {
        throw statusError(429)
      }

      return response()
    }))

    try {
      const operation = model.runTurn(modelInput(new AbortController().signal))

      await advanceRetryDelay(250)

      await expect(operation).resolves.toMatchObject({
        finalText: 'Model completed the turn',
      })
      expect(createCalls).toBe(2)
    }
    finally {
      vi.useRealTimers()
    }
  })

  test('400 归类为 InvalidInput，且不会重试', async () => {
    let createCalls = 0
    const model = createModel(fakeClient(async () => {
      createCalls += 1
      throw statusError(400)
    }))

    try {
      await model.runTurn(modelInput(new AbortController().signal))
      throw new Error('Expected the model to reject')
    }
    catch (error) {
      expectFailure(error, FailureKind.InvalidInput, FailureCode.InvalidInput)
    }

    expect(createCalls).toBe(1)
  })

  test('401 与未知错误归类为 Internal，且不会重试', async () => {
    for (const error of [statusError(401), new Error('sensitive unknown error')]) {
      let createCalls = 0
      const model = createModel(fakeClient(async () => {
        createCalls += 1
        throw error
      }))

      try {
        await model.runTurn(modelInput(new AbortController().signal))
        throw new Error('Expected the model to reject')
      }
      catch (thrown) {
        expectFailure(thrown, FailureKind.Internal, FailureCode.InternalError)
        expect((thrown as AgentCallError).failure.message).not.toContain('sensitive')
      }

      expect(createCalls).toBe(1)
    }
  })

  test('SDK 收到 attempt signal，parent abort 会取消调用且不开始下一次 attempt', async () => {
    const parentController = new AbortController()
    let createCalls = 0
    let receivedSignal: AbortSignal | undefined
    const model = createModel(fakeClient(async (_request, options) => {
      createCalls += 1
      receivedSignal = (options as { signal: AbortSignal }).signal
      return await new Promise<never>(() => {})
    }))

    const operation = model.runTurn(modelInput(parentController.signal))

    expect(receivedSignal).toBeDefined()
    expect(receivedSignal).not.toBe(parentController.signal)
    parentController.abort()

    try {
      await operation
      throw new Error('Expected the model to reject')
    }
    catch (error) {
      expectFailure(error, FailureKind.Aborted, FailureCode.OperationAborted)
    }

    expect(receivedSignal?.aborted).toBe(true)
    expect(createCalls).toBe(1)
  })

  test('toModelTurn 本地转换失败时，不会再次调用 responses.create', async () => {
    let createCalls = 0
    const malformedResponse = {
      output: {},
      output_text: 'This response is malformed.',
    } as unknown as OpenAIResponse
    const model = createModel(fakeClient(async () => {
      createCalls += 1
      return malformedResponse
    }))

    await expect(model.runTurn(modelInput(new AbortController().signal))).rejects.toThrow()

    expect(createCalls).toBe(1)
  })
})

import { expect, mock, test } from 'bun:test'
import { z } from 'zod'
import { defineTool } from '@/tools/_core'

test('defineTool', async () => {
  let receivedValue: string | undefined
  let receivedSignal: AbortSignal | undefined

  const tool = defineTool({
    name: 'test1',
    description: 'test1',
    schema: z.object({
      value: z.string().trim().min(1),
    }),
    handler: async (input, runtime) => {
      receivedValue = input.value
      receivedSignal = runtime.signal

      return {
        success: true,
        data: `input: ${input.value}, runId: ${runtime.runId}, toolCallId: ${runtime.toolCallId}`,
      }
    },
  })

  const signal = new AbortController().signal

  expect(await tool.invoke(
    { value: ' hello ' },
    { runId: 'test1', toolCallId: 'call_test1', signal },
  ))
    .toEqual({ success: true, data: `input: hello, runId: test1, toolCallId: call_test1` })

  expect(receivedValue).toBe('hello')
  expect(receivedSignal).toBe(signal)
})

test('空 name 会构造失败', () => {
  expect(() => defineTool({
    name: '   ',
    description: 'a valid description',
    schema: z.object({}),
    handler: () => undefined,
  })).toThrow('name and description are required')
})

test('空 description 会构造失败', () => {
  expect(() => defineTool({
    name: 'valid_name',
    description: '   ',
    schema: z.object({}),
    handler: () => undefined,
  })).toThrow('name and description are required')
})

test('参数不符合 Schema 时，不执行 handler', async () => {
  const handler = mock(() => 'should not run')

  const tool = defineTool({
    name: 'trim_value',
    description: 'test schema validation',
    schema: z.object({
      value: z.string().trim().min(1),
    }),
    handler,
  })

  await expect(
    tool.invoke(
      { value: '   ' },
      { runId: 'test1', toolCallId: 'call_test1', signal: new AbortController().signal },
    ),
  ).rejects.toBeInstanceOf(z.ZodError)

  expect(handler).toHaveBeenCalledTimes(0)
})

test('signal 已取消时，不执行 handler', async () => {
  const handler = mock(() => 'should not run')
  const controller = new AbortController()
  const cancelled = new Error('cancelled by user')

  controller.abort(cancelled)

  const tool = defineTool({
    name: 'cancel_test',
    description: 'test abort',
    schema: z.object({ value: z.string() }),
    handler,
  })

  await expect(
    tool.invoke(
      { value: 'hello' },
      {
        runId: 'run-1',
        toolCallId: 'call-1',
        signal: controller.signal,
      },
    ),
  ).rejects.toBe(cancelled)

  expect(handler).toHaveBeenCalledTimes(0)
})

test('handler 异常会原样向外抛出', async () => {
  const providerError = new Error('weather provider unavailable')

  const tool = defineTool({
    name: 'provider_failure',
    description: 'test handler error',
    schema: z.object({ city: z.string() }),
    handler: () => {
      throw providerError
    },
  })

  await expect(
    tool.invoke(
      { city: 'Shenzhen' },
      { runId: 'test1', toolCallId: 'call_test1', signal: new AbortController().signal },
    ),
  ).rejects.toBe(providerError)
})

import {
  Command,
  END,
  interrupt,
  START,
  StateGraph,
  StateSchema,
} from '@langchain/langgraph'
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { z } from 'zod'
import {
  CloudflareD1CheckpointSaver,
} from '@/runtime/checkpoint/cloudflare-d1-checkpoint-saver'

function createFakeD1Fetch() {
  const database = new Database(':memory:')

  const fetch = async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as {
      sql: string
      params?: unknown[]
    }
    try {
      const statement = database.query(body.sql)
      const trimmed = body.sql.trim().toUpperCase()
      const params = body.params ?? []
      const results = trimmed.startsWith('SELECT')
        ? statement.all(...(params as never[])) as Array<Record<string, unknown>>
        : (statement.run(...(params as never[])), [])
      return Response.json({
        success: true,
        result: [{ success: true, results }],
      })
    }
    catch {
      return Response.json({ success: false }, { status: 400 })
    }
  }

  return { database, fetch }
}

const ApprovalState = new StateSchema({
  question: z.string().default(''),
  answer: z.string().nullable().default(null),
})

function createApprovalGraph(
  checkpointer: CloudflareD1CheckpointSaver,
) {
  return new StateGraph(ApprovalState)
    .addNode('ask', () => {
      const answer = interrupt({ kind: 'approval', question: '继续吗？' })
      return { answer: String(answer) }
    })
    .addEdge(START, 'ask')
    .addEdge('ask', END)
    .compile({ checkpointer })
}

test('Cloudflare D1 Checkpointer 可以跨 Graph 实例恢复 interrupt', async () => {
  const fake = createFakeD1Fetch()
  const firstSaver = new CloudflareD1CheckpointSaver({
    queryUrl: 'https://d1.test/query',
    apiToken: 'test-token',
    fetch: fake.fetch,
  })
  await firstSaver.initialize()
  const firstGraph = createApprovalGraph(firstSaver)
  const config = {
    configurable: { thread_id: 'd1-checkpoint-thread' },
    durability: 'sync' as const,
  }

  await firstGraph.invoke({ question: '继续吗？' }, config)
  const firstSnapshot = await firstGraph.getState(config)
  expect(firstSnapshot.tasks.some(task => task.interrupts.length > 0)).toBe(true)

  const secondSaver = new CloudflareD1CheckpointSaver({
    queryUrl: 'https://d1.test/query',
    apiToken: 'test-token',
    fetch: fake.fetch,
  })
  const secondGraph = createApprovalGraph(secondSaver)
  const restored = await secondGraph.getState(config)
  expect(restored.tasks.some(task => task.interrupts.length > 0)).toBe(true)

  await secondGraph.invoke(new Command({ resume: 'accepted' }), config)
  const completed = await secondGraph.getState(config)
  expect(completed.values).toMatchObject({
    question: '继续吗？',
    answer: 'accepted',
  })
  expect(completed.next).toEqual([])

  const history = []
  for await (const snapshot of secondGraph.getStateHistory(config))
    history.push(snapshot)
  expect(history.length).toBeGreaterThan(1)

  await secondSaver.deleteThread('d1-checkpoint-thread')
  await expect(secondGraph.getState(config)).resolves.toMatchObject({
    values: {},
    next: [],
  })
})

test('Cloudflare D1 Checkpointer 错误不泄漏响应正文', async () => {
  const saver = new CloudflareD1CheckpointSaver({
    queryUrl: 'https://d1.test/query',
    apiToken: 'test-token',
    fetch: async () => new Response('private SQL and token', { status: 500 }),
  })

  await expect(saver.getTuple({
    configurable: { thread_id: 'error-thread' },
  })).rejects.toMatchObject({
    code: 'cloudflare_d1_checkpoint_request_failed',
  })
  await expect(saver.getTuple({
    configurable: { thread_id: 'error-thread' },
  })).rejects.not.toThrow('private SQL')
})

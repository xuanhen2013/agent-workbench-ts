import process from 'node:process'
import {
  Command,
  END,
  interrupt,
  START,
  StateGraph,
  StateSchema,
} from '@langchain/langgraph'
import { expect, test } from 'bun:test'
import { z } from 'zod'
import {
  createCloudflareD1CheckpointSaverFromEnv,
} from '@/runtime/checkpoint/cloudflare-d1-checkpoint-saver'

const requiredEnvironment = [
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_D1_DATABASE_ID',
] as const

function requireSaver() {
  const missing = requiredEnvironment.filter(name => !process.env[name]?.trim())
  if (missing.length > 0) {
    throw new Error(
      `D1 Checkpoint smoke test requires: ${missing.join(', ')}`,
    )
  }
  const saver = createCloudflareD1CheckpointSaverFromEnv(process.env)
  if (!saver)
    throw new Error('Expected configured D1 Checkpointer.')
  return saver
}

const SmokeState = new StateSchema({
  answer: z.string().nullable().default(null),
})

test('真实 D1 Checkpointer 可以跨 Graph 实例恢复 interrupt', async () => {
  const saver = requireSaver()
  await saver.initialize()
  const threadId = `d1-checkpoint-smoke-${crypto.randomUUID()}`
  const graph = new StateGraph(SmokeState)
    .addNode('ask', () => ({
      answer: String(interrupt({ kind: 'smoke-approval' })),
    }))
    .addEdge(START, 'ask')
    .addEdge('ask', END)
    .compile({ checkpointer: saver })

  try {
    const config = {
      configurable: { thread_id: threadId },
      durability: 'sync' as const,
    }
    await graph.invoke({}, config)
    const restored = await graph.getState(config)
    expect(restored.tasks.some(task => task.interrupts.length > 0)).toBe(true)

    const newGraph = new StateGraph(SmokeState)
      .addNode('ask', () => ({
        answer: String(interrupt({ kind: 'smoke-approval' })),
      }))
      .addEdge(START, 'ask')
      .addEdge('ask', END)
      .compile({ checkpointer: saver })
    await newGraph.invoke(new Command({ resume: 'accepted' }), config)
    const completed = await newGraph.getState(config)
    expect(completed.values.answer).toBe('accepted')
    expect(completed.next).toEqual([])
  }
  finally {
    await saver.deleteThread(threadId)
  }
}, 60_000)

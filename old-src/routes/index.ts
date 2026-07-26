import type { Context } from 'hono'
import type { AppEnv } from '@/http'
import { Hono } from 'hono'
import { z } from 'zod/v4'
import { planExecutor, planGraph } from '@/graphs/plan'
import { workflow as reActWorkflow } from '@/graphs/reAct'

const agentRequestSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
  threadId: z.string().trim().min(1).max(128).optional(),
}).strict()

const planRequestSchema = z.object({
  goal: z.string().trim().min(1).max(4_000),
  threadId: z.string().trim().min(1).max(128).optional(),
}).strict()

async function readJson(c: Context<AppEnv>) {
  try {
    return await c.req.json()
  }
  catch {
    return undefined
  }
}

function invalidRequest(c: Context<AppEnv>, details: unknown) {
  return c.json({
    requestId: c.get('requestId'),
    status: 'failed',
    error: {
      code: 'INVALID_REQUEST',
      message: '请求体必须是符合接口定义的 JSON',
      details,
    },
  }, 400)
}

export const agentRoutes = new Hono<AppEnv>()

agentRoutes.post('/react', async (c) => {
  const parsed = agentRequestSchema.safeParse(await readJson(c))
  if (!parsed.success) {
    return invalidRequest(c, parsed.error.issues)
  }

  const runId = c.get('requestId')
  const threadId = parsed.data.threadId ?? runId
  const requestLogger = c.get('requestLogger').child({ runId, threadId, agent: 'react' })

  requestLogger.info({ messageLength: parsed.data.message.length }, 'Agent 运行开始')
  const result = await reActWorkflow.invoke({
    history: [{ role: 'user', content: parsed.data.message }],
  })
  requestLogger.info({ answerLength: result.answer.length }, 'Agent 运行完成')

  return c.json({
    requestId: runId,
    runId,
    threadId,
    status: 'completed',
    data: result,
  })
})

agentRoutes.post('/plan', async (c) => {
  const parsed = planRequestSchema.safeParse(await readJson(c))
  if (!parsed.success) {
    return invalidRequest(c, parsed.error.issues)
  }

  const runId = c.get('requestId')
  const threadId = parsed.data.threadId ?? runId
  const requestLogger = c.get('requestLogger').child({ runId, threadId, agent: 'plan' })
  const config = { configurable: { thread_id: threadId } }

  requestLogger.info({ goalLength: parsed.data.goal.length }, 'Plan 运行开始')
  const plan = await planGraph.invoke({ goal: parsed.data.goal }, config)
  const result = await planExecutor.invoke({ plan: plan.answer }, config)
  requestLogger.info({
    answerLength: result.answer.length,
    planStepCount: plan.answer.steps.length,
  }, 'Plan 运行完成')

  return c.json({
    requestId: runId,
    runId,
    threadId,
    status: 'completed',
    data: {
      plan: plan.answer,
      answer: result.answer,
    },
  })
})

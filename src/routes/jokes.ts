import type { StateSnapshot } from '@langchain/langgraph'
import type { Context, Hono } from 'hono'
import type { createInterruptGraph } from '@/agent/interrupt/interrupt-graph'
import type { AppEnv } from '@/http'
import type { HttpStatusCode } from '@/http/errors'
import { Command } from '@langchain/langgraph'
import { z } from 'zod/v4'
import {
  DecisionRequestSchema,
  DecisionSchema,
} from '@/agent/interrupt/interrupt-graph'
import { InterruptReason, InterruptState } from '@/agent/interrupt/state'
import {
  createHttpError,
  HttpErrorCode,
  HttpStatus,
} from '@/http/errors'

export type JokeGraph = ReturnType<typeof createInterruptGraph>

export type JokeReviewRequest = z.infer<typeof DecisionRequestSchema>

export interface JokeView {
  threadId: string
  status: 'needs_input' | 'completed' | 'failed'
  round: number
  joke?: string
  waiting?: JokeReviewRequest
  result?: { outcome: InterruptReason.Accepted, rounds: number }
  error?: { code: string, message: string }
}

type Projection
  = | { ok: true, view: JokeView }
    | {
      ok: false
      status: HttpStatusCode
      error: { code: string, message: string }
    }

const JokeSnapshotSchema = z.object({
  threadId: z.string().min(1),
  joke: z.string(),
  status: z.enum(InterruptState),
  round: z.number().int().nonnegative(),
  decision: DecisionSchema.optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
})

function getJokeReviewRequest(snapshot: StateSnapshot) {
  for (const task of snapshot.tasks) {
    for (const item of task.interrupts) {
      const request = DecisionRequestSchema.safeParse(item.value)
      if (request.success)
        return request.data
    }
  }
  return undefined
}

function graphConfig(threadId: string, signal?: AbortSignal) {
  return {
    configurable: { thread_id: threadId },
    durability: 'sync' as const,
    ...(signal ? { signal } : {}),
  }
}

function errorResponse(
  c: Context<AppEnv>,
  status: HttpStatusCode,
  error: { code: string, message: string },
) {
  return c.json({
    requestId: c.get('requestId'),
    status: 'failed' as const,
    error,
  }, status)
}

async function readJson(c: Context<AppEnv>) {
  try {
    return { ok: true as const, value: await c.req.json<unknown>() }
  }
  catch {
    return {
      ok: false as const,
      error: createHttpError(HttpErrorCode.InvalidJson),
    }
  }
}

async function projectJoke(
  graph: JokeGraph,
  threadId: string,
): Promise<Projection> {
  const snapshot = await graph.getState({
    configurable: { thread_id: threadId },
  })
  const state = JokeSnapshotSchema.safeParse(snapshot.values)

  if (!state.success) {
    return {
      ok: false,
      status: HttpStatus.NotFound,
      error: createHttpError(HttpErrorCode.ThreadNotFound),
    }
  }

  const waiting = getJokeReviewRequest(snapshot)
  if (waiting) {
    return {
      ok: true,
      view: {
        threadId,
        status: 'needs_input',
        round: state.data.round,
        joke: state.data.joke,
        waiting,
      },
    }
  }

  if (state.data.status === InterruptState.Completed) {
    return {
      ok: true,
      view: {
        threadId,
        status: 'completed',
        round: state.data.round,
        joke: state.data.joke,
        result: {
          outcome: InterruptReason.Accepted,
          rounds: state.data.round,
        },
      },
    }
  }

  if (state.data.status === InterruptState.Failed) {
    return {
      ok: true,
      view: {
        threadId,
        status: 'failed',
        round: state.data.round,
        ...(state.data.joke ? { joke: state.data.joke } : {}),
        error: state.data.error
          ?? createHttpError(HttpErrorCode.JokeGraphFailed),
      },
    }
  }

  return {
    ok: false,
    status: HttpStatus.InternalServerError,
    error: createHttpError(HttpErrorCode.JokeSnapshotInconsistent),
  }
}

/**
 * 直接把 Joke Endpoint 注册到应用使用的同一个 Hono 实例。
 * 这里保留独立文件，是为了隔离 Joke 的 HTTP 适配和 Snapshot 投影，
 * 不再为每个模块额外创建一层 Hono Router。
 */
export function registerJokeRoutes(app: Hono<AppEnv>, graph: JokeGraph) {
  app.post('/api/jokes', async (c) => {
    const threadId = crypto.randomUUID()
    await graph.invoke(
      { threadId },
      graphConfig(threadId, c.req.raw.signal),
    )

    const projected = await projectJoke(graph, threadId)
    return projected.ok
      ? c.json(projected.view, 201)
      : errorResponse(c, projected.status, projected.error)
  })

  app.get('/api/jokes/:threadId', async (c) => {
    const projected = await projectJoke(
      graph,
      c.req.param('threadId'),
    )
    return projected.ok
      ? c.json(projected.view, 200)
      : errorResponse(c, projected.status, projected.error)
  })

  app.post('/api/jokes/:threadId/resume', async (c) => {
    const json = await readJson(c)
    if (!json.ok)
      return errorResponse(c, HttpStatus.BadRequest, json.error)

    const decision = DecisionSchema.safeParse(json.value)
    if (!decision.success) {
      return errorResponse(
        c,
        HttpStatus.BadRequest,
        createHttpError(HttpErrorCode.InvalidRequestBody),
      )
    }

    const threadId = c.req.param('threadId')
    const before = await projectJoke(graph, threadId)
    if (!before.ok)
      return errorResponse(c, before.status, before.error)

    if (!before.view.waiting) {
      return errorResponse(
        c,
        HttpStatus.Conflict,
        createHttpError(HttpErrorCode.ThreadNotWaiting),
      )
    }

    if (before.view.waiting.reviewId !== decision.data.reviewId) {
      return errorResponse(
        c,
        HttpStatus.Conflict,
        createHttpError(HttpErrorCode.ReviewIdMismatch),
      )
    }

    await graph.invoke(
      new Command({ resume: decision.data }),
      graphConfig(threadId, c.req.raw.signal),
    )

    const projected = await projectJoke(graph, threadId)
    return projected.ok
      ? c.json(projected.view, 200)
      : errorResponse(c, projected.status, projected.error)
  })
}

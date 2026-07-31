import type { StateSnapshot } from '@langchain/langgraph'
import type { Context, Hono } from 'hono'
import type {
  PublicQuizRoundResultSchema,
} from '@/agent/interview-quiz/execution'
import type { createInterviewQuizGraph } from '@/agent/interview-quiz/interview-quiz-graph'
import type { InterviewQuizState } from '@/agent/interview-quiz/state'
import type { AppEnv } from '@/http'
import type { HttpStatusCode } from '@/http/errors'
import { Command } from '@langchain/langgraph'
import {
  InterviewQuizStatus,
  QuizConfigSchema,
  QuizRoundSubmissionSchema,
} from '@/agent/interview-quiz/contracts'
import {
  projectPublicRoundResult,
  QuizInterruptKind,
  QuizNextRoundAction,
  QuizNextRoundDecisionSchema,
  QuizRoundRequestSchema,
  QuizRoundResultRequestSchema,
} from '@/agent/interview-quiz/execution'
import {
  createHttpError,
  HttpErrorCode,
  HttpStatus,
} from '@/http/errors'

export type InterviewQuizGraph = ReturnType<typeof createInterviewQuizGraph>

export interface InterviewQuizView {
  threadId: string
  status: 'needs_answers' | 'round_result' | 'completed' | 'failed'
  config: InterviewQuizState['config']
  waitingQuestions?: ReturnType<typeof QuizRoundRequestSchema.parse>
  waitingResult?: ReturnType<typeof QuizRoundResultRequestSchema.parse>
  results: Array<ReturnType<typeof PublicQuizRoundResultSchema.parse>>
  error?: { code: string, message: string }
}

type Projection
  = | { ok: true, view: InterviewQuizView }
    | {
      ok: false
      status: HttpStatusCode
      error: { code: string, message: string }
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

function getWaitingRequest(snapshot: StateSnapshot) {
  for (const task of snapshot.tasks) {
    for (const item of task.interrupts) {
      const questions = QuizRoundRequestSchema.safeParse(item.value)
      if (questions.success)
        return questions.data

      const result = QuizRoundResultRequestSchema.safeParse(item.value)
      if (result.success)
        return result.data
    }
  }
  return undefined
}

async function projectInterviewQuiz(
  graph: InterviewQuizGraph,
  threadId: string,
): Promise<Projection> {
  const snapshot = await graph.getState({
    configurable: { thread_id: threadId },
  })
  const state = snapshot.values as Partial<InterviewQuizState>

  if (state.threadId !== threadId || !state.config) {
    return {
      ok: false,
      status: HttpStatus.NotFound,
      error: createHttpError(HttpErrorCode.ThreadNotFound),
    }
  }

  const results = (state.rounds ?? []).map(projectPublicRoundResult)
  const waiting = getWaitingRequest(snapshot)

  if (waiting?.kind === QuizInterruptKind.Round) {
    return {
      ok: true,
      view: {
        threadId,
        status: 'needs_answers',
        config: state.config,
        waitingQuestions: waiting,
        results,
      },
    }
  }

  if (waiting?.kind === QuizInterruptKind.RoundResult) {
    return {
      ok: true,
      view: {
        threadId,
        status: 'round_result',
        config: state.config,
        waitingResult: waiting,
        results,
      },
    }
  }

  if (state.status === InterviewQuizStatus.Completed) {
    return {
      ok: true,
      view: {
        threadId,
        status: 'completed',
        config: state.config,
        results,
      },
    }
  }

  if (state.status === InterviewQuizStatus.Failed) {
    return {
      ok: true,
      view: {
        threadId,
        status: 'failed',
        config: state.config,
        results,
        error: state.error
          ?? createHttpError(HttpErrorCode.InterviewQuizFailed),
      },
    }
  }

  return {
    ok: false,
    status: HttpStatus.InternalServerError,
    error: createHttpError(HttpErrorCode.InterviewQuizSnapshotInconsistent),
  }
}

export function registerInterviewQuizRoutes(
  app: Hono<AppEnv>,
  graph: InterviewQuizGraph,
) {
  app.post('/api/interview-quiz', async (c) => {
    const json = await readJson(c)
    if (!json.ok)
      return errorResponse(c, HttpStatus.BadRequest, json.error)

    const config = QuizConfigSchema.safeParse(json.value)
    if (!config.success) {
      return errorResponse(
        c,
        HttpStatus.BadRequest,
        createHttpError(HttpErrorCode.InvalidQuizConfig),
      )
    }

    const threadId = crypto.randomUUID()
    await graph.invoke(
      { threadId, config: config.data },
      graphConfig(threadId, c.req.raw.signal),
    )

    const projected = await projectInterviewQuiz(graph, threadId)
    return projected.ok
      ? c.json(projected.view, 201)
      : errorResponse(c, projected.status, projected.error)
  })

  app.get('/api/interview-quiz/:threadId', async (c) => {
    const projected = await projectInterviewQuiz(
      graph,
      c.req.param('threadId'),
    )
    return projected.ok
      ? c.json(projected.view, 200)
      : errorResponse(c, projected.status, projected.error)
  })

  app.post('/api/interview-quiz/:threadId/answers', async (c) => {
    const json = await readJson(c)
    if (!json.ok)
      return errorResponse(c, HttpStatus.BadRequest, json.error)

    const submission = QuizRoundSubmissionSchema.safeParse(json.value)
    if (!submission.success) {
      return errorResponse(
        c,
        HttpStatus.BadRequest,
        createHttpError(HttpErrorCode.InvalidQuizSubmission),
      )
    }

    const threadId = c.req.param('threadId')
    const before = await projectInterviewQuiz(graph, threadId)
    if (!before.ok)
      return errorResponse(c, before.status, before.error)

    if (!before.view.waitingQuestions) {
      return errorResponse(
        c,
        HttpStatus.Conflict,
        createHttpError(HttpErrorCode.ThreadNotWaitingForAnswers),
      )
    }

    if (before.view.waitingQuestions.reviewId !== submission.data.reviewId) {
      return errorResponse(
        c,
        HttpStatus.Conflict,
        createHttpError(HttpErrorCode.ReviewIdMismatch),
      )
    }

    await graph.invoke(
      new Command({ resume: submission.data }),
      graphConfig(threadId, c.req.raw.signal),
    )

    const projected = await projectInterviewQuiz(graph, threadId)
    return projected.ok
      ? c.json(projected.view, 200)
      : errorResponse(c, projected.status, projected.error)
  })

  app.post('/api/interview-quiz/:threadId/next', async (c) => {
    const json = await readJson(c)
    if (!json.ok)
      return errorResponse(c, HttpStatus.BadRequest, json.error)

    const decision = QuizNextRoundDecisionSchema.safeParse(json.value)
    if (!decision.success) {
      return errorResponse(
        c,
        HttpStatus.BadRequest,
        createHttpError(HttpErrorCode.InvalidNextRoundDecision),
      )
    }

    const threadId = c.req.param('threadId')
    const before = await projectInterviewQuiz(graph, threadId)
    if (!before.ok)
      return errorResponse(c, before.status, before.error)

    if (!before.view.waitingResult) {
      return errorResponse(
        c,
        HttpStatus.Conflict,
        createHttpError(HttpErrorCode.ThreadNotWaitingForNextRound),
      )
    }

    if (before.view.waitingResult.reviewId !== decision.data.reviewId) {
      return errorResponse(
        c,
        HttpStatus.Conflict,
        createHttpError(HttpErrorCode.ReviewIdMismatch),
      )
    }

    await graph.invoke(
      new Command({
        resume: {
          reviewId: decision.data.reviewId,
          action: QuizNextRoundAction.NextRound,
        },
      }),
      graphConfig(threadId, c.req.raw.signal),
    )

    const projected = await projectInterviewQuiz(graph, threadId)
    return projected.ok
      ? c.json(projected.view, 200)
      : errorResponse(c, projected.status, projected.error)
  })
}

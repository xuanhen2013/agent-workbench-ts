import type { StateSnapshot } from '@langchain/langgraph'
import type { Context, Hono } from 'hono'
import type {
  PublicQuizRoundResultSchema,
} from '@/agent/interview-quiz/execution'
import type { createInterviewQuizGraph } from '@/agent/interview-quiz/interview-quiz-graph'
import type { ImportJdDocument, MarketJdCatalog } from '@/agent/interview-quiz/jd/contracts'
import type { InterviewQuizState } from '@/agent/interview-quiz/state'
import type { AppEnv } from '@/http'
import type { HttpStatusCode } from '@/http/errors'
import { Command } from '@langchain/langgraph'
import { streamSSE } from 'hono/streaming'
import {
  CreateInterviewQuizBodySchema,
  InterviewQuizStatus,
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
  ImportJdBodySchema,
  SearchMarketJdsQuerySchema,
} from '@/agent/interview-quiz/jd/contracts'
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

interface StreamTaskPayload {
  name?: unknown
  input?: unknown
  result?: unknown
}

interface QuizProgressEvent {
  phase: string
  label: string
  categoryIndex?: number
  categoryCount?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function mapTaskProgress(payload: StreamTaskPayload): QuizProgressEvent | undefined {
  if (typeof payload.name !== 'string' || payload.result !== undefined)
    return undefined

  if (payload.name === 'planning' && isRecord(payload.input)) {
    const cursor = payload.input.categoryCursor
    const categories = payload.input.activeCategories
    if (typeof cursor === 'number' && Array.isArray(categories)) {
      return {
        phase: 'generating_category',
        label: `正在生成第 ${cursor + 1} / ${categories.length} 个分类的题目`,
        categoryIndex: cursor + 1,
        categoryCount: categories.length,
      }
    }
  }

  const progress: Record<string, QuizProgressEvent> = {
    initialize: { phase: 'initializing', label: '正在初始化训练会话' },
    load_memory: { phase: 'loading_memory', label: '正在加载历史薄弱点' },
    load_jd_context: { phase: 'loading_jd', label: '正在加载 JD 重点' },
    select_categories: { phase: 'selecting_categories', label: '正在确定题目分类' },
    collect_section: { phase: 'collecting_questions', label: '正在整理分类题目' },
    persist_questions: { phase: 'saving_questions', label: '正在保存题目' },
    answer_questions: { phase: 'waiting_for_answers', label: '题目已准备好，等待答题' },
    verify: { phase: 'grading', label: '正在确定性判分' },
    persist_memory: { phase: 'saving_memory', label: '正在保存本轮学习记录' },
    replan: { phase: 'replanning', label: '正在根据错题重新规划' },
    wait_next_round: { phase: 'waiting_for_next_round', label: '等待开始下一轮' },
    finish: { phase: 'completed', label: '训练已完成' },
  }
  return progress[payload.name]
}

async function streamInterviewQuizRun(
  c: Context<AppEnv>,
  graph: InterviewQuizGraph,
  threadId: string,
  input: Parameters<InterviewQuizGraph['stream']>[0],
) {
  return streamSSE(c, async (stream) => {
    let eventId = 0
    const send = async (event: string, data: unknown) => {
      await stream.writeSSE({
        id: String(++eventId),
        event,
        data: JSON.stringify(data),
      })
    }

    await send('progress', {
      phase: 'initializing',
      label: '正在启动 Agent',
    } satisfies QuizProgressEvent)

    try {
      const graphStream = await graph.stream(input, {
        ...graphConfig(threadId, c.req.raw.signal),
        streamMode: ['tasks', 'updates'],
      })
      for await (const rawEvent of graphStream) {
        if (!Array.isArray(rawEvent) || rawEvent.length !== 2)
          continue
        const [mode, payload] = rawEvent as [unknown, unknown]
        if (mode !== 'tasks' || !isRecord(payload))
          continue
        const progress = mapTaskProgress(payload as StreamTaskPayload)
        if (progress)
          await send('progress', progress)
      }

      const projected = await projectInterviewQuiz(graph, threadId)
      if (!projected.ok) {
        await send('error', projected.error)
        return
      }
      await send('done', projected.view)
    }
    catch {
      await send('error', createHttpError(HttpErrorCode.InterviewQuizFailed))
    }
  })
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
  importJd: ImportJdDocument,
  marketJdCatalog?: Pick<MarketJdCatalog, 'search'>,
) {
  app.post('/api/interview-quiz/jds', async (c) => {
    const json = await readJson(c)
    if (!json.ok)
      return errorResponse(c, HttpStatus.BadRequest, json.error)

    const body = ImportJdBodySchema.safeParse(json.value)
    if (!body.success) {
      return errorResponse(
        c,
        HttpStatus.BadRequest,
        createHttpError(HttpErrorCode.InvalidJdInput),
      )
    }

    try {
      const imported = await importJd(body.data, {
        signal: c.req.raw.signal,
      })
      return c.json(imported, 201)
    }
    catch {
      return errorResponse(
        c,
        HttpStatus.InternalServerError,
        createHttpError(HttpErrorCode.JdImportFailed),
      )
    }
  })

  app.get('/api/interview-quiz/market-jds', async (c) => {
    const query = SearchMarketJdsQuerySchema.safeParse({
      query: c.req.query('query'),
    })
    if (!query.success) {
      return errorResponse(
        c,
        HttpStatus.BadRequest,
        createHttpError(HttpErrorCode.InvalidMarketJdQuery),
      )
    }

    if (!marketJdCatalog) {
      return errorResponse(
        c,
        HttpStatus.ServiceUnavailable,
        createHttpError(HttpErrorCode.MarketJdSearchUnavailable),
      )
    }

    try {
      const results = await marketJdCatalog.search({
        query: query.data.query,
        limit: 5,
        signal: c.req.raw.signal,
      })
      return c.json({
        items: results.map(result => ({
          itemKey: result.itemKey,
          title: result.title,
          company: result.company,
          location: result.location,
          salary: result.salary,
          highlights: result.highlights,
        })),
      })
    }
    catch {
      return errorResponse(
        c,
        HttpStatus.InternalServerError,
        createHttpError(HttpErrorCode.MarketJdSearchFailed),
      )
    }
  })

  /** 创建训练会话的 SSE 版本；JSON 版本保留给非流式调用方。 */
  app.post('/api/interview-quiz/stream', async (c) => {
    const json = await readJson(c)
    if (!json.ok)
      return errorResponse(c, HttpStatus.BadRequest, json.error)

    const body = CreateInterviewQuizBodySchema.safeParse(json.value)
    if (!body.success) {
      return errorResponse(
        c,
        HttpStatus.BadRequest,
        createHttpError(HttpErrorCode.InvalidQuizConfig),
      )
    }

    const { learnerId, ...config } = body.data
    const threadId = crypto.randomUUID()
    return streamInterviewQuizRun(
      c,
      graph,
      threadId,
      { threadId, learnerId, config },
    )
  })

  app.post('/api/interview-quiz', async (c) => {
    const json = await readJson(c)
    if (!json.ok)
      return errorResponse(c, HttpStatus.BadRequest, json.error)

    const body = CreateInterviewQuizBodySchema.safeParse(json.value)
    if (!body.success) {
      return errorResponse(
        c,
        HttpStatus.BadRequest,
        createHttpError(HttpErrorCode.InvalidQuizConfig),
      )
    }

    const { learnerId, ...config } = body.data
    const threadId = crypto.randomUUID()
    await graph.invoke(
      { threadId, learnerId, config },
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

  /** 下一轮的 SSE 版本；判分仍使用上面的 JSON 接口。 */
  app.post('/api/interview-quiz/:threadId/next/stream', async (c) => {
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
      return errorResponse(c, HttpStatus.Conflict, createHttpError(HttpErrorCode.ReviewIdMismatch))
    }

    return streamInterviewQuizRun(
      c,
      graph,
      threadId,
      new Command({
        resume: {
          reviewId: decision.data.reviewId,
          action: QuizNextRoundAction.NextRound,
        },
      }),
    )
  })
}

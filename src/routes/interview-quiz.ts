import type { StateSnapshot } from '@langchain/langgraph'
import type { Context, Hono } from 'hono'
import type { InterviewQuizFeature } from '@/agent/interview-quiz/composition'
import type {
  PublicQuizRoundResultSchema,
} from '@/agent/interview-quiz/execution'
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
import { toSafeErrorLog } from '@/logger'
import {
  createTimeoutSignal,
  waitForSignal,
} from '@/runtime/reliability/request-timeout'

export type InterviewQuizGraph = InterviewQuizFeature['graph']

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
  id?: unknown
  name?: unknown
  input?: unknown
  result?: unknown
}

interface TaskStartObservation {
  progress?: QuizProgressEvent
  toolNames: string[]
  startedAt: number
}

interface QuizProgressEvent {
  phase: string
  label: string
  categoryIndex?: number
  categoryCount?: number
  round?: number
  toolRound?: number
  toolCallCount?: number
  elapsedSeconds?: number
}

export type QuizActivityLevel = 'info' | 'warn' | 'error'
export type QuizActivityScope = 'parent' | 'planning' | 'tool_loop' | 'tool'

/**
 * 发给 Web Terminal 的安全运行事件。
 * 这里只允许节点、Tool 名称和稳定错误码，不携带 Prompt、参数、State 或检索正文。
 */
export interface QuizActivityEvent {
  id: string
  timestamp: string
  level: QuizActivityLevel
  scope: QuizActivityScope
  event: 'node_started' | 'node_finished' | 'tool_started' | 'tool_finished' | 'stream_failed' | 'stream_completed'
  label: string
  node?: string
  toolName?: string
  round?: number
  toolRound?: number
  durationMs?: number
  errorCode?: string
}

export interface InterviewQuizStreamOptions {
  /** 生产默认每 10 秒发一条；测试可缩短，但不能关闭。 */
  heartbeatMs?: number
  /** 包含模型调用、Tool、Checkpoint 和最终投影的整次 SSE 生成预算。 */
  generationTimeoutMs?: number
}

/** HTTP 层需要的 InterviewQuiz 功能入口；内部题库和 Memory 不暴露给 Route。 */
export interface InterviewQuizRouteDeps extends InterviewQuizFeature {
  streamOptions?: InterviewQuizStreamOptions
}

const DEFAULT_HEARTBEAT_MS = 10_000
const DEFAULT_GENERATION_TIMEOUT_MS = 10 * 60 * 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function positiveDuration(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

function pendingToolNames(input: unknown) {
  if (!isRecord(input) || !Array.isArray(input.pendingToolCalls))
    return []

  return input.pendingToolCalls.flatMap((call) => {
    return isRecord(call) && typeof call.name === 'string' ? [call.name] : []
  })
}

function activityScope(namespace: readonly string[]): QuizActivityScope {
  if (namespace.length === 0)
    return 'parent'
  if (namespace.length === 1)
    return 'planning'
  return 'tool_loop'
}

function createActivity(
  input: Omit<QuizActivityEvent, 'id' | 'timestamp'>,
): QuizActivityEvent {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...input,
  }
}

function taskEventKey(
  payload: StreamTaskPayload,
  namespace: readonly string[],
) {
  return typeof payload.id === 'string'
    ? JSON.stringify([namespace, payload.id])
    : undefined
}

/**
 * LangGraph task 的开始事件有 input，完成事件只有 id/name/result。
 * 开始时只提取日志需要的安全字段，避免为了配对完成事件而暂存完整 State。
 */
function observeTaskStart(
  payload: StreamTaskPayload,
  namespace: readonly string[],
): TaskStartObservation {
  return {
    progress: mapTaskProgress(payload, namespace),
    toolNames: pendingToolNames(payload.input),
    startedAt: performance.now(),
  }
}

function mapTaskActivities(
  payload: StreamTaskPayload,
  namespace: readonly string[],
  observation?: TaskStartObservation,
): QuizActivityEvent[] {
  if (typeof payload.name !== 'string')
    return []

  const finished = payload.result !== undefined
  const progress = observation?.progress
    ?? (!finished
      ? mapTaskProgress(payload, namespace)
      : undefined)
  const nodeLabel = progress?.label
    ?? `${finished ? '完成' : '开始'} ${payload.name}`
  const activity: QuizActivityEvent = createActivity({
    level: payload.name === 'failed' ? 'error' : 'info',
    scope: activityScope(namespace),
    event: finished ? 'node_finished' : 'node_started',
    label: finished ? `${nodeLabel}（完成）` : nodeLabel,
    node: payload.name,
    ...(progress?.round ? { round: progress.round } : {}),
    ...(progress?.toolRound !== undefined
      ? { toolRound: progress.toolRound }
      : {}),
    ...(finished && observation
      ? {
          durationMs: Math.max(
            0,
            Math.round(performance.now() - observation.startedAt),
          ),
        }
      : {}),
  })

  const activities = [activity]
  const names = observation?.toolNames
    ?? (!finished ? pendingToolNames(payload.input) : [])
  if (payload.name === 'execute_tools' && names.length > 0) {
    activities.push(...names.map(toolName => createActivity({
      level: 'info',
      scope: 'tool',
      event: finished ? 'tool_finished' : 'tool_started',
      label: `${finished ? '完成' : '开始'}执行 ${toolName}`,
      node: 'execute_tools',
      toolName,
      ...(progress?.round ? { round: progress.round } : {}),
      ...(progress?.toolRound !== undefined
        ? { toolRound: progress.toolRound }
        : {}),
    })))
  }

  return activities
}

function toolRound(input: unknown) {
  return isRecord(input) && typeof input.toolRound === 'number'
    ? input.toolRound
    : 0
}

function mapTaskProgress(
  payload: StreamTaskPayload,
  namespace: readonly string[],
): QuizProgressEvent | undefined {
  if (typeof payload.name !== 'string' || payload.result !== undefined)
    return undefined

  if (namespace.length === 0 && payload.name === 'planning' && isRecord(payload.input)) {
    const cursor = payload.input.categoryCursor
    const categories = payload.input.activeCategories
    const roundContext = payload.input.roundContext
    const round = isRecord(roundContext) && typeof roundContext.round === 'number'
      ? roundContext.round
      : undefined
    if (typeof cursor === 'number' && Array.isArray(categories)) {
      return {
        phase: 'generating_category',
        label: `正在生成第 ${cursor + 1} / ${categories.length} 个分类的题目`,
        categoryIndex: cursor + 1,
        categoryCount: categories.length,
        ...(round ? { round } : {}),
      }
    }
  }

  if (namespace.length === 1) {
    const planningProgress: Record<string, QuizProgressEvent> = {
      load_question_history: {
        phase: 'loading_question_history',
        label: '正在读取历史题干排除列表',
      },
      retrieve_question_signals: {
        phase: 'retrieving_question_signals',
        label: '正在检索当前分类的出题方向资料',
      },
      plan_round: {
        phase: 'starting_planner',
        label: '正在启动 Planner Tool Loop',
      },
    }
    return planningProgress[payload.name]
  }

  if (namespace.length >= 2) {
    const round = toolRound(payload.input)
    const names = pendingToolNames(payload.input)
    const toolCallCount = names.length
    if (payload.name === 'call_model') {
      return {
        phase: 'calling_model',
        label: `模型正在进行第 ${round + 1} 次决策或生成题目`,
        toolRound: round,
      }
    }
    if (payload.name === 'check_round_budget') {
      return {
        phase: 'checking_tool_budget',
        label: `正在检查第 ${round + 1} 轮 Tool 调用预算`,
        toolRound: round + 1,
        toolCallCount,
      }
    }
    if (payload.name === 'execute_tools') {
      const isRetrieval = names.some(name => name.startsWith('search_'))
      const isLoadingSkill = names.includes('load_skill')
      const task = isRetrieval
        ? '资料检索'
        : isLoadingSkill
          ? 'Skill 加载'
          : 'Tool'
      return {
        phase: 'executing_tools',
        label: `正在执行第 ${round + 1} 轮${task}（${toolCallCount} 个 Tool）`,
        toolRound: round + 1,
        toolCallCount,
      }
    }
    if (payload.name === 'append_tool_outputs') {
      return {
        phase: 'processing_tool_results',
        label: `正在整理第 ${round} 轮 Tool 结果`,
        toolRound: round,
        toolCallCount,
      }
    }
    if (payload.name === 'finish') {
      return {
        phase: 'validating_model_output',
        label: '正在验证模型生成的题目',
        toolRound: round,
      }
    }
    if (payload.name === 'failed') {
      return {
        phase: 'planner_failed',
        label: 'Planner 执行失败',
        toolRound: round,
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
  return namespace.length === 0 ? progress[payload.name] : undefined
}

function normalizeTaskEvent(rawEvent: unknown): {
  namespace: string[]
  payload: StreamTaskPayload
} | undefined {
  if (!Array.isArray(rawEvent))
    return undefined

  if (rawEvent.length === 2) {
    const [mode, payload] = rawEvent as [unknown, unknown]
    return mode === 'tasks' && isRecord(payload)
      ? { namespace: [], payload: payload as StreamTaskPayload }
      : undefined
  }

  if (rawEvent.length === 3) {
    const [namespace, mode, payload] = rawEvent as [unknown, unknown, unknown]
    return Array.isArray(namespace)
      && namespace.every(item => typeof item === 'string')
      && mode === 'tasks'
      && isRecord(payload)
      ? { namespace, payload: payload as StreamTaskPayload }
      : undefined
  }

  return undefined
}

async function streamInterviewQuizRun(
  c: Context<AppEnv>,
  graph: InterviewQuizGraph,
  threadId: string,
  input: Parameters<InterviewQuizGraph['stream']>[0],
  options: InterviewQuizStreamOptions,
) {
  return streamSSE(c, async (stream) => {
    const startedAt = Date.now()
    const requestSignal = c.req.raw.signal
    const timeout = createTimeoutSignal(
      requestSignal,
      positiveDuration(
        options.generationTimeoutMs,
        DEFAULT_GENERATION_TIMEOUT_MS,
      ),
    )
    let eventId = 0
    let streamClosed = false
    let writeQueue = Promise.resolve()
    let currentProgress: QuizProgressEvent = {
      phase: 'initializing',
      label: '正在启动 Agent',
    }
    const taskStarts = new Map<string, TaskStartObservation>()

    const send = async (event: string, data: unknown) => {
      if (streamClosed || requestSignal.aborted)
        return

      const id = String(++eventId)
      const queuedWrite = writeQueue.then(async () => {
        if (streamClosed || requestSignal.aborted)
          return
        await stream.writeSSE({
          id,
          event,
          data: JSON.stringify(data),
        })
      })
      writeQueue = queuedWrite.then(
        () => undefined,
        () => {
          streamClosed = true
        },
      )
      await queuedWrite
    }

    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.max(
        1,
        Math.floor((Date.now() - startedAt) / 1000),
      )
      void send('heartbeat', {
        ...currentProgress,
        label: `${currentProgress.label}（已等待 ${elapsedSeconds} 秒）`,
        elapsedSeconds,
      } satisfies QuizProgressEvent).catch(() => undefined)
    }, positiveDuration(options.heartbeatMs, DEFAULT_HEARTBEAT_MS))

    try {
      await send('progress', currentProgress)
      await send('activity', createActivity({
        level: 'info',
        scope: 'parent',
        event: 'node_started',
        label: 'SSE 已连接，开始执行 Graph',
        node: 'stream',
      }))

      const graphStream = await waitForSignal(graph.stream(input, {
        ...graphConfig(threadId, timeout.signal),
        streamMode: ['tasks', 'updates'],
        subgraphs: true,
      }), timeout.signal)
      const iterator = graphStream[Symbol.asyncIterator]()
      while (true) {
        const step = await waitForSignal(iterator.next(), timeout.signal)
        if (step.done)
          break

        const taskEvent = normalizeTaskEvent(step.value)
        if (!taskEvent)
          continue
        const key = taskEventKey(taskEvent.payload, taskEvent.namespace)
        const finished = taskEvent.payload.result !== undefined
        let observation: TaskStartObservation | undefined
        if (finished) {
          observation = key ? taskStarts.get(key) : undefined
          if (key)
            taskStarts.delete(key)
        }
        else {
          observation = observeTaskStart(
            taskEvent.payload,
            taskEvent.namespace,
          )
          if (key)
            taskStarts.set(key, observation)
        }
        for (const activity of mapTaskActivities(
          taskEvent.payload,
          taskEvent.namespace,
          observation,
        )) {
          await send('activity', activity)
        }
        const progress = mapTaskProgress(
          taskEvent.payload,
          taskEvent.namespace,
        )
        if (progress) {
          currentProgress = {
            ...(currentProgress.round
              ? { round: currentProgress.round }
              : {}),
            ...(currentProgress.categoryIndex
              ? { categoryIndex: currentProgress.categoryIndex }
              : {}),
            ...(currentProgress.categoryCount
              ? { categoryCount: currentProgress.categoryCount }
              : {}),
            ...progress,
          }
          await send('progress', currentProgress)
        }
      }

      const projected = await waitForSignal(
        projectInterviewQuiz(graph, threadId, timeout.signal),
        timeout.signal,
      )
      if (!projected.ok) {
        c.get('requestLogger').warn({
          component: 'interview_quiz',
          event: 'stream_projection_failed',
          threadId,
          phase: currentProgress.phase,
          round: currentProgress.round,
          categoryIndex: currentProgress.categoryIndex,
          categoryCount: currentProgress.categoryCount,
          toolRound: currentProgress.toolRound,
          toolCallCount: currentProgress.toolCallCount,
          errorCode: projected.error.code,
          elapsedMs: Date.now() - startedAt,
        }, 'Interview Quiz stream projection failed')
        await send('error', projected.error)
        return
      }
      if (projected.view.status === 'failed') {
        c.get('requestLogger').warn({
          component: 'interview_quiz',
          event: 'stream_generation_failed',
          threadId,
          phase: currentProgress.phase,
          round: currentProgress.round,
          categoryIndex: currentProgress.categoryIndex,
          categoryCount: currentProgress.categoryCount,
          toolRound: currentProgress.toolRound,
          toolCallCount: currentProgress.toolCallCount,
          errorCode: projected.view.error?.code
            ?? HttpErrorCode.InterviewQuizFailed,
          elapsedMs: Date.now() - startedAt,
        }, 'Interview Quiz generation failed')
        await send('activity', createActivity({
          level: 'error',
          scope: 'parent',
          event: 'stream_failed',
          label: 'Graph 已进入失败终态',
          node: 'failed',
          errorCode: projected.view.error?.code
            ?? HttpErrorCode.InterviewQuizFailed,
        }))
      }
      else {
        await send('activity', createActivity({
          level: 'info',
          scope: 'parent',
          event: 'stream_completed',
          label: 'Graph 执行完成',
          node: 'done',
        }))
      }
      await send('done', projected.view)
    }
    catch (error) {
      if (requestSignal.aborted) {
        c.get('requestLogger').info({
          component: 'interview_quiz',
          event: 'stream_cancelled',
          threadId,
          phase: currentProgress.phase,
          round: currentProgress.round,
          categoryIndex: currentProgress.categoryIndex,
          categoryCount: currentProgress.categoryCount,
          toolRound: currentProgress.toolRound,
          toolCallCount: currentProgress.toolCallCount,
          elapsedMs: Date.now() - startedAt,
        }, 'Interview Quiz stream cancelled')
        return
      }
      const errorCode = timeout.timedOut()
        ? HttpErrorCode.InterviewQuizGenerationTimeout
        : HttpErrorCode.InterviewQuizFailed
      c.get('requestLogger').warn({
        component: 'interview_quiz',
        event: 'stream_failed',
        threadId,
        phase: currentProgress.phase,
        round: currentProgress.round,
        categoryIndex: currentProgress.categoryIndex,
        categoryCount: currentProgress.categoryCount,
        toolRound: currentProgress.toolRound,
        toolCallCount: currentProgress.toolCallCount,
        errorCode,
        elapsedMs: Date.now() - startedAt,
        ...toSafeErrorLog(error),
      }, 'Interview Quiz stream failed')
      await send('activity', createActivity({
        level: 'error',
        scope: 'parent',
        event: 'stream_failed',
        label: 'SSE 执行失败',
        node: 'failed',
        errorCode,
      }))
      await send('error', createHttpError(errorCode))
    }
    finally {
      clearInterval(heartbeat)
      timeout.dispose()
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
  signal?: AbortSignal,
): Promise<Projection> {
  const snapshot = await graph.getState({
    configurable: { thread_id: threadId },
    ...(signal ? { signal } : {}),
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
  deps: InterviewQuizRouteDeps,
) {
  const {
    graph,
    importJdDocument: importJd,
    marketJdCatalog,
    streamOptions = {},
  } = deps

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
      streamOptions,
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

  /**
   * 答题提交的 SSE 版本。
   * Graph 的 verify、persist_memory 和后续 Interrupt 都通过真实 task
   * 事件交给 Web，右侧流程图不需要猜测 Node 进度。
   */
  app.post('/api/interview-quiz/:threadId/answers/stream', async (c) => {
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

    return streamInterviewQuizRun(
      c,
      graph,
      threadId,
      new Command({ resume: submission.data }),
      streamOptions,
    )
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

  /** 下一轮的 SSE 版本。 */
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
      streamOptions,
    )
  })
}

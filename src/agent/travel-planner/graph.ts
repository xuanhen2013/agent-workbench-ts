import type { Send } from '@langchain/langgraph'
import type {
  TravelAssignment,
  TravelPlan,
  TravelPlannerError,
  TravelRequest,
  TravelWorkerRegistry,
  TravelWorkerResult,
} from './contracts'
import type {
  TravelPlannerState,
  TravelPlannerUpdate,
} from './state'
import {
  END,
  Send as LangGraphSend,
  START,
  StateGraph,
} from '@langchain/langgraph'
import {
  TravelPlanStatus,
  TravelRequestSchema,
  TravelWorkerId,
  TravelWorkerStatus,
} from './contracts'
import { TravelPlannerStateSchema } from './state'
import { createDefaultTravelWorkerRegistry } from './workers'

export interface CreateTravelPlannerGraphOptions {
  /**
   * Worker 依赖由外部注入；默认使用确定性的 Fake Registry。
   * 这样测试和学习不需要真实天气、地图或支付服务。
   */
  workerRegistry?: TravelWorkerRegistry
}

const ASSIGNMENT_DEFINITIONS: ReadonlyArray<{
  workerId: TravelWorkerId
  goal: string
}> = [
  {
    workerId: TravelWorkerId.Weather,
    goal: '查询目的地天气，并给出户外活动的时间建议。',
  },
  {
    workerId: TravelWorkerId.Route,
    goal: '规划适合旅行者需求的景点顺序和出行节奏。',
  },
  {
    workerId: TravelWorkerId.Budget,
    goal: '估算基础花费，并判断是否超过用户预算。',
  },
]

/** Supervisor 的输入只是一份可信旅行需求。 */
export function createAssignments(request: TravelRequest): TravelAssignment[] {
  return ASSIGNMENT_DEFINITIONS.map(definition => ({
    assignmentId: `${definition.workerId}-plan`,
    workerId: definition.workerId,
    goal: definition.goal,
    request,
  }))
}

/**
 * Conditional Edge 的返回值。
 *
 * `Send` 是 LangGraph 原生动态派发 API：三个 Assignment 都进入同一个
 * `run_worker` Node，但每个任务携带自己的 assignment。这里没有写三个
 * 静态 Node，因为 Worker 的执行协议是相同的。
 */
export function dispatchAssignments(
  state: TravelPlannerState,
): Array<Send<'run_worker', { assignment: TravelAssignment }>> {
  return state.assignments.map(assignment => new LangGraphSend(
    'run_worker',
    { assignment },
  ))
}

function createWorkerFailure(
  assignment: TravelAssignment,
  error: TravelPlannerError,
): TravelWorkerResult {
  return {
    assignmentId: assignment.assignmentId,
    workerId: assignment.workerId,
    status: TravelWorkerStatus.Failed,
    summary: '这个 Worker 没有产出可用的旅行建议。',
    evidenceRefs: [],
    error,
  }
}

function createWorkerCancellation(
  assignment: TravelAssignment,
): TravelWorkerResult {
  return {
    assignmentId: assignment.assignmentId,
    workerId: assignment.workerId,
    status: TravelWorkerStatus.Cancelled,
    summary: '这个 Worker 在完成前被取消。',
    evidenceRefs: [],
    error: {
      code: 'worker_aborted',
      message: '旅行规划被取消。',
    },
  }
}

/**
 * `run_worker` 是所有 Worker 的统一入口。
 *
 * 它只做三件事：查 Registry、执行一个 Worker、把异常归一化。真正的
 * Worker 专业逻辑不应该写进 Supervisor，也不应该由模型决定 workerId。
 */
function createRunWorkerNode(registry: TravelWorkerRegistry) {
  return async (
    state: TravelPlannerState & { assignment?: TravelAssignment },
    runtime: { signal: AbortSignal },
  ): Promise<TravelPlannerUpdate> => {
    const assignment = state.assignment
    if (!assignment) {
      return {
        status: TravelPlanStatus.Failed,
        error: {
          code: 'assignment_missing',
          message: 'Worker assignment is missing.',
        },
      }
    }

    if (runtime.signal.aborted) {
      return {
        workerResults: [createWorkerCancellation(assignment)],
      }
    }

    const worker = registry.get(assignment.workerId)
    if (!worker) {
      return {
        workerResults: [createWorkerFailure(assignment, {
          code: 'unknown_worker',
          message: 'The requested Worker is not registered.',
        })],
      }
    }

    try {
      return {
        workerResults: [await worker.run(assignment, runtime.signal)],
      }
    }
    catch {
      return {
        workerResults: [runtime.signal.aborted
          ? createWorkerCancellation(assignment)
          : createWorkerFailure(assignment, {
              code: 'worker_failed',
              message: 'The Worker failed while producing its travel advice.',
            })],
      }
    }
  }
}

function aggregateWorkerResults(
  state: TravelPlannerState,
): TravelPlannerUpdate {
  const workerResults = [...state.workerResults].sort((left, right) => (
    left.assignmentId.localeCompare(right.assignmentId)
  ))

  if (workerResults.length === 0) {
    return {
      status: TravelPlanStatus.Failed,
      error: {
        code: 'worker_results_missing',
        message: 'No Worker result was produced.',
      },
    }
  }

  const successCount = workerResults.filter(result => (
    result.status === TravelWorkerStatus.Completed
  )).length
  const status = successCount === workerResults.length
    ? TravelPlanStatus.Completed
    : successCount > 0
      ? TravelPlanStatus.Partial
      : TravelPlanStatus.Failed

  const plan: TravelPlan = {
    status,
    request: state.request,
    workerResults,
    summary: workerResults
      .map(result => `[${result.workerId}] ${result.summary}`)
      .join('\n'),
  }

  return {
    status,
    plan,
    error: status === TravelPlanStatus.Failed
      ? {
          code: 'all_workers_failed',
          message: 'All travel Workers failed to produce advice.',
        }
      : null,
  }
}

/**
 * 创建最小旅行 Multi-Agent Graph。
 *
 * Graph 的结构刻意保持为四个控制点：
 *
 * ```text
 * initialize → supervisor → Send(run_worker × 3) → aggregate → END
 * ```
 *
 * 这里的“Multi-Agent”来自三个拥有独立职责的 Worker，而不是来自三个
 * 模型调用。以后每个 Worker 内部可以接入 ToolLoopGraph，但本 Graph 的
 * Assignment、Send、Reducer 和聚合边界不需要改变。
 */
export function createTravelPlannerGraph(
  options: CreateTravelPlannerGraphOptions = {},
) {
  const registry = options.workerRegistry ?? createDefaultTravelWorkerRegistry()

  const initialize = async (state: TravelPlannerState): Promise<TravelPlannerUpdate> => {
    const parsed = TravelRequestSchema.safeParse(state.request)
    if (!parsed.success) {
      return {
        status: TravelPlanStatus.Failed,
        error: {
          code: 'invalid_travel_request',
          message: 'Travel request is invalid.',
        },
      }
    }

    return {
      request: parsed.data,
      status: TravelPlanStatus.Running,
      assignments: [],
      workerResults: [],
      plan: null,
      error: null,
    }
  }

  const supervisor = (state: TravelPlannerState): TravelPlannerUpdate => ({
    assignments: createAssignments(state.request),
    status: TravelPlanStatus.Running,
    error: null,
  })

  return new StateGraph(TravelPlannerStateSchema)
    .addNode('initialize', initialize)
    .addNode('supervisor', supervisor)
    .addNode('run_worker', createRunWorkerNode(registry))
    .addNode('aggregate', aggregateWorkerResults)
    .addEdge(START, 'initialize')
    .addConditionalEdges('initialize', state => (
      state.error ? END : 'supervisor'
    ))
    .addConditionalEdges('supervisor', dispatchAssignments)
    .addEdge('run_worker', 'aggregate')
    .addEdge('aggregate', END)
    .compile()
}

import { z } from 'zod/v4'

/**
 * 用户提交的旅行需求。
 *
 * 这是整个 Demo 的业务输入。第一版只保留足够演示并行 Worker 的字段，
 * 不引入用户账号、订单、支付或真实地图数据。
 */
export interface TravelRequest {
  destination: string
  days: number
  budgetCents: number
  travelerNeeds: string[]
}

/**
 * Demo 的外部输入边界。
 *
 * 真实 HTTP 路由应该在路由层校验；这里再保留一次最小 Schema，方便单独
 * invoke Graph 的学习测试明确看到“输入在哪里变成可信数据”。
 */
export const TravelRequestSchema = z.object({
  destination: z.string().trim().min(1),
  days: z.number().int().min(1).max(14),
  budgetCents: z.number().int().nonnegative(),
  travelerNeeds: z.array(z.string().trim().min(1)).max(8),
})

/**
 * Supervisor 分派给一个 Worker 的最小任务。
 *
 * Assignment 是“做什么”的事实，不是一个模型消息，也不包含 Tool 实例。
 * Tool 和 Worker 由 Graph 创建时注入，避免把函数闭包写入 State/Checkpoint。
 */
export interface TravelAssignment {
  assignmentId: string
  workerId: TravelWorkerId
  goal: string
  request: TravelRequest
}

/** 第一版固定三种 Worker，先不允许模型动态创建角色。 */
export enum TravelWorkerId {
  Weather = 'weather',
  Route = 'route',
  Budget = 'budget',
}

export enum TravelWorkerStatus {
  Completed = 'completed',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export enum TravelPlanStatus {
  Running = 'running',
  Completed = 'completed',
  Partial = 'partial',
  Failed = 'failed',
}

export interface TravelWorkerError {
  code: string
  message: string
}

/** Worker 返回给 Aggregator 的统一结果。 */
export type TravelWorkerResult = {
  assignmentId: string
  workerId: TravelWorkerId
} & (
  | { status: TravelWorkerStatus.Completed, summary: string, evidenceRefs: string[] }
  | {
    status: TravelWorkerStatus.Failed | TravelWorkerStatus.Cancelled
    summary: string
    evidenceRefs: string[]
    error: TravelWorkerError
  }
)

/**
 * Worker 是一个独立职责的执行单元。
 *
 * 第一版使用 Fake Worker，不调用 LLM；以后可以把 run 的内部实现替换成
 * ToolLoopGraph，而不用改变 Supervisor、Assignment 或 Aggregator 的协议。
 */
export interface TravelWorker {
  readonly id: TravelWorkerId
  run: (
    assignment: TravelAssignment,
    signal: AbortSignal,
  ) => Promise<TravelWorkerResult>
}

export interface TravelWorkerRegistry {
  get: (workerId: TravelWorkerId) => TravelWorker | undefined
}

export interface TravelPlan {
  status: TravelPlanStatus
  request: TravelRequest
  workerResults: TravelWorkerResult[]
  summary: string
}

export interface TravelPlannerError {
  code: string
  message: string
}

/** 方便测试和未来接入动态 Worker 时复用的注册表实现。 */
export class MapTravelWorkerRegistry implements TravelWorkerRegistry {
  private readonly workers: ReadonlyMap<TravelWorkerId, TravelWorker>

  constructor(workers: Iterable<TravelWorker>) {
    this.workers = new Map(
      Array.from(workers, worker => [worker.id, worker] as const),
    )
  }

  get(workerId: TravelWorkerId) {
    return this.workers.get(workerId)
  }
}

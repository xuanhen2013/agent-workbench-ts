import type {
  TravelAssignment,
  TravelWorker,
  TravelWorkerRegistry,
  TravelWorkerResult,
} from './contracts'
import { MapTravelWorkerRegistry, TravelWorkerId, TravelWorkerStatus } from './contracts'

/**
 * Fake Worker 的取消结果。
 *
 * 真实 Worker 也必须遵守同一个约定：取消属于受控业务结果，不能把
 * AbortError 或 SDK 原始异常直接暴露给 Aggregator/Web。
 */
function cancelled(assignment: TravelAssignment): TravelWorkerResult {
  return {
    assignmentId: assignment.assignmentId,
    workerId: assignment.workerId,
    status: TravelWorkerStatus.Cancelled,
    summary: 'Worker 在执行前收到取消信号。',
    evidenceRefs: [],
    error: {
      code: 'worker_aborted',
      message: '旅行规划被取消。',
    },
  }
}

function createWeatherWorker(): TravelWorker {
  return {
    id: TravelWorkerId.Weather,
    async run(assignment, signal) {
      if (signal.aborted)
        return cancelled(assignment)

      return {
        assignmentId: assignment.assignmentId,
        workerId: assignment.workerId,
        status: TravelWorkerStatus.Completed,
        summary: `${assignment.request.destination} 前两天适合安排户外活动，建议每天预留一段室内备选行程。`,
        evidenceRefs: ['fake-weather-provider'],
      }
    },
  }
}

function createRouteWorker(): TravelWorker {
  return {
    id: TravelWorkerId.Route,
    async run(assignment, signal) {
      if (signal.aborted)
        return cancelled(assignment)

      const pace = assignment.request.travelerNeeds.includes('老人')
        ? '每天安排一个主要景点，减少长距离换乘'
        : '每天安排两个相邻景点，减少往返'

      return {
        assignmentId: assignment.assignmentId,
        workerId: assignment.workerId,
        status: TravelWorkerStatus.Completed,
        summary: `${assignment.request.destination} ${assignment.request.days} 天路线：${pace}。`,
        evidenceRefs: ['fake-route-provider'],
      }
    },
  }
}

function createBudgetWorker(): TravelWorker {
  return {
    id: TravelWorkerId.Budget,
    async run(assignment, signal) {
      if (signal.aborted)
        return cancelled(assignment)

      // 这里用确定性估算，不调用模型。真实版本可以把它换成 Calculator Tool。
      const estimatedCents = assignment.request.days * 30_000
      const fitsBudget = estimatedCents <= assignment.request.budgetCents
      const budgetMessage = fitsBudget
        ? `预计基础花费 ${estimatedCents / 100} 元，在预算内。`
        : `预计基础花费 ${estimatedCents / 100} 元，超过预算，需要减少景点或住宿成本。`

      return {
        assignmentId: assignment.assignmentId,
        workerId: assignment.workerId,
        status: TravelWorkerStatus.Completed,
        summary: budgetMessage,
        evidenceRefs: ['fake-budget-calculator'],
      }
    },
  }
}

/**
 * 默认 Fake Worker Registry。
 *
 * 这是学习 Send/聚合的数据源，不代表生产级旅行服务。它故意不访问
 * 网络，让默认测试稳定；后续可以只替换 Registry，不改 Graph 协议。
 */
export function createDefaultTravelWorkerRegistry(): TravelWorkerRegistry {
  return new MapTravelWorkerRegistry([
    createWeatherWorker(),
    createRouteWorker(),
    createBudgetWorker(),
  ])
}

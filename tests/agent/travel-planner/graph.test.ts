import type {
  TravelWorker,
  TravelWorkerResult,
} from '@/agent/travel-planner/contracts'
import { describe, expect, test } from 'bun:test'
import {
  MapTravelWorkerRegistry,
  TravelPlanStatus,
  TravelWorkerId,
  TravelWorkerStatus,
} from '@/agent/travel-planner/contracts'
import {
  createTravelPlannerGraph,
  dispatchAssignments,
} from '@/agent/travel-planner/graph'

const request = {
  destination: '深圳',
  days: 2,
  budgetCents: 150_000,
  travelerNeeds: ['老人', '轻松'],
}

function successResult(
  assignment: Parameters<TravelWorker['run']>[0],
  summary: string,
): TravelWorkerResult {
  return {
    assignmentId: assignment.assignmentId,
    workerId: assignment.workerId,
    status: TravelWorkerStatus.Completed,
    summary,
    evidenceRefs: [`fake:${assignment.workerId}`],
  }
}

describe('Travel Planner Multi-Agent Demo', () => {
  test('Supervisor 通过 Send 派发三个固定 Worker，并聚合成完整计划', async () => {
    const graph = createTravelPlannerGraph()
    const state = await graph.invoke({ request }, {
      context: { runId: 'travel-complete' },
    })

    expect(state.status).toBe(TravelPlanStatus.Completed)
    expect(state.assignments).toHaveLength(3)
    expect(state.workerResults).toHaveLength(3)
    expect(state.plan?.workerResults.map(result => result.assignmentId)).toEqual([
      'budget-plan',
      'route-plan',
      'weather-plan',
    ])
    expect(state.plan?.summary).toContain('[weather]')
    expect(state.plan?.summary).toContain('[route]')
    expect(state.plan?.summary).toContain('[budget]')
  })

  test('Send 的每个任务都进入同一个 run_worker Node，但携带不同 Assignment', () => {
    const graphState = {
      request,
      assignments: [
        {
          assignmentId: 'weather-plan',
          workerId: TravelWorkerId.Weather,
          goal: 'weather',
          request,
        },
        {
          assignmentId: 'route-plan',
          workerId: TravelWorkerId.Route,
          goal: 'route',
          request,
        },
      ],
      workerResults: [],
      plan: null,
      status: TravelPlanStatus.Running,
      error: null,
    }

    const packets = dispatchAssignments(graphState)

    expect(packets).toHaveLength(2)
    expect(packets.map(packet => packet.node)).toEqual([
      'run_worker',
      'run_worker',
    ])
    expect(packets.map(packet => packet.args.assignment.assignmentId)).toEqual([
      'weather-plan',
      'route-plan',
    ])
  })

  test('一个 Worker 失败时保留其他结果，并把最终计划标记为 partial', async () => {
    const failingRouteWorker: TravelWorker = {
      id: TravelWorkerId.Route,
      async run(assignment) {
        return {
          assignmentId: assignment.assignmentId,
          workerId: assignment.workerId,
          status: TravelWorkerStatus.Failed,
          summary: '路线查询失败。',
          evidenceRefs: [],
          error: {
            code: 'route_unavailable',
            message: '路线服务暂时不可用。',
          },
        }
      },
    }
    const registry = new MapTravelWorkerRegistry([
      {
        id: TravelWorkerId.Weather,
        async run(assignment) {
          return successResult(assignment, '天气结果')
        },
      },
      failingRouteWorker,
      {
        id: TravelWorkerId.Budget,
        async run(assignment) {
          return successResult(assignment, '预算结果')
        },
      },
    ])

    const graph = createTravelPlannerGraph({ workerRegistry: registry })
    const state = await graph.invoke({ request }, {
      context: { runId: 'travel-partial' },
    })

    expect(state.status).toBe(TravelPlanStatus.Partial)
    expect(state.error).toBeNull()
    expect(state.workerResults).toHaveLength(3)
    expect(state.workerResults.find(result => result.workerId === TravelWorkerId.Route)?.status)
      .toBe(TravelWorkerStatus.Failed)
    expect(state.plan?.summary).toContain('路线查询失败')
  })

  test('非法旅行需求在 Supervisor 派发前被拒绝', async () => {
    const graph = createTravelPlannerGraph()
    const state = await graph.invoke({
      request: {
        ...request,
        days: 0,
      },
    }, {
      context: { runId: 'travel-invalid' },
    })

    expect(state.status).toBe(TravelPlanStatus.Failed)
    expect(state.error?.code).toBe('invalid_travel_request')
    expect(state.assignments).toHaveLength(0)
    expect(state.workerResults).toHaveLength(0)
  })
})

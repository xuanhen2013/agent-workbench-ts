import type {
  TravelAssignment,
  TravelPlan,
  TravelPlannerError,
  TravelRequest,
  TravelWorkerResult,
} from './contracts'
import { ReducedValue, StateSchema } from '@langchain/langgraph'
import { z } from 'zod/v4'
import { TravelPlanStatus } from './contracts'

/**
 * 旅行 Multi-Agent Demo 的 Graph State。
 *
 * 注意：State 只保存可序列化的业务数据，不保存 Worker Registry、函数、
 * Tool 实例或模型客户端。这些运行时依赖由 createTravelPlannerGraph 注入。
 */
export const TravelPlannerStateSchema = new StateSchema({
  /** 用户提交的旅行需求，所有 Worker 读取同一份只读输入。 */
  request: z.custom<TravelRequest>(),

  /** Supervisor 创建的固定 Assignment 列表。 */
  assignments: z.array(z.custom<TravelAssignment>()).default(() => []),

  /**
   * Fan-out 后每个 Worker 返回一条结果。
   * Reducer 负责把并行任务的局部更新合并成一个数组。
   */
  workerResults: new ReducedValue(
    z.array(z.custom<TravelWorkerResult>()).default(() => []),
    {
      reducer(
        left: TravelWorkerResult[],
        right: TravelWorkerResult[],
      ) {
        return left.concat(right)
      },
    },
  ),

  /** Aggregator 生成的最终旅行计划。 */
  plan: z.custom<TravelPlan>().nullable().default(null),

  /** 当前 Graph 的公开终态。 */
  status: z.enum(TravelPlanStatus).default(TravelPlanStatus.Running),

  /** 只保存稳定错误，不保存 Worker 或 Provider 原始异常。 */
  error: z.custom<TravelPlannerError>().nullable().default(null),
})

export type TravelPlannerState = typeof TravelPlannerStateSchema.State
export type TravelPlannerUpdate = typeof TravelPlannerStateSchema.Update

import type { z } from 'zod/v4'

/**
 * 使用方式
 *
 * tool(handler, config)
 */

export type ToolRuntime = Readonly<{
  /**
   * 来源：Harness 创建运行时生成
   * 作用：关联本次执行和日志
   */
  runId: string
  /**
   * 来源：Harness 调用项或测试生成
   * 作用：调用和结果一一对应
   */
  toolCallId: string
  /**
   * 取消执行并向 Provider 传播
   */
  signal: AbortSignal
}>

export type ToolHandler<TSchema extends z.ZodType, TResult> = (
  input: z.output<TSchema>,
  runtime: ToolRuntime,
) => TResult | Promise<TResult>

export interface MiniTool<TSchema extends z.ZodType = z.ZodType, TResult = unknown> {
  // Registry 和模型用稳定名称识别 Tool
  readonly name: string
  // 模型判断什么时候使用
  readonly description: string
  // 类型推导、运行时校验和后续 Provider 转换的事实源
  readonly schema: TSchema
  // 所有调用方必须经过的执行入口
  invoke: (rawInput: unknown, runtime: ToolRuntime) => Promise<TResult>
  /**
   * 暂未实现
   * 1. execute
   * 2. parameters: JSON Schema
   * 3. Provider 专属字段
   */
}

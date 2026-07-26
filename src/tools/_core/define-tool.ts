import type * as z from 'zod'
import type { MiniStructuredToolConfig } from './structured-tool'
import { MiniStructuredTool } from './structured-tool'

export function defineTool<
  TSchema extends z.ZodType,
  TResult,
>(config: MiniStructuredToolConfig<TSchema, TResult>) {
  // 返回 MiniStructuredTool 实例
  return new MiniStructuredTool(config)
}

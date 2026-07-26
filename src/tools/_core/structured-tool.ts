import type { z } from 'zod/v4'
import type { MiniTool, ToolHandler, ToolRuntime } from './types'

export interface MiniStructuredToolConfig<
  TSchema extends z.ZodType,
  TResult,
> {
  name: string
  description: string
  schema: TSchema
  handler: ToolHandler<TSchema, TResult>
}

export class MiniStructuredTool<
  TSchema extends z.ZodType,
  TResult,
> implements MiniTool<TSchema, TResult> {
  readonly name: string
  readonly description: string
  readonly schema: TSchema
  private readonly handler: ToolHandler<TSchema, TResult>

  constructor(config: MiniStructuredToolConfig<TSchema, TResult>) {
    const _name = config.name.trim()
    const _description = config.description.trim()

    if (!_name || !_description) {
      throw new Error('name and description are required')
    }

    this.name = _name
    this.description = _description
    this.schema = config.schema
    this.handler = config.handler
  }

  async invoke(rawInput: unknown, runtime: ToolRuntime): Promise<TResult> {
    // 1. 如果 signal 已取消，立即失败
    // 2. await schema.parseAsync(rawInput)
    // 3. 把 parsedInput 和 runtime 交给 handler
    // 4. 返回 handler 结果，不吞错、不重试

    runtime.signal.throwIfAborted()

    const parsedInput = await this.schema.parseAsync(rawInput)

    runtime.signal.throwIfAborted()

    return this.handler(parsedInput, runtime)
  }
}

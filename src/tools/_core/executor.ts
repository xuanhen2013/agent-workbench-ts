import type { ToolExecutionResult } from './errors'
import type { ToolRegistry } from './registry'
import { z } from 'zod/v4'
import {
  ToolExecutionErrorMessages,
  ToolExecutionErrorType,
} from './errors'

export {
  ToolExecutionErrorMessages,
  ToolExecutionErrorType,
} from './errors'
export type { ToolExecutionError, ToolExecutionResult } from './errors'

export interface RequestedToolCall {
  callId: string
  name: string
  arguments: string
}

export interface ExecuteToolOptions {
  runId: string
  signal: AbortSignal
}

class ClassifiedToolError extends Error {
  constructor(
    readonly code: ToolExecutionErrorType,
    readonly original: unknown,
  ) {
    super(original instanceof Error ? original.message : String(original))
  }
}

export class ToolExecutor {
  private readonly registry: ToolRegistry
  constructor(registry: ToolRegistry) {
    this.registry = registry
  }

  async execute(
    call: RequestedToolCall,
    options: ExecuteToolOptions,
  ): Promise<ToolExecutionResult> {
    // 1. 从 registry 查 Tool
    // 2. JSON.parse(call.arguments)
    // 3. 创建 ToolRuntime
    // 4. await tool.invoke(parsedArguments, runtime)
    // 5. 将成功或异常归一化成 ToolExecutionResult
    //
    //
    // 统一错误返回
    function failure(errorType: ToolExecutionErrorType, message: string): ToolExecutionResult {
      return {
        ok: false,
        callId: call.callId,
        name: call.name,
        error: {
          code: errorType,
          message,
          runId: options.runId,
        },
      }
    }

    const tool = this.registry.get(call.name)

    if (!tool) {
      return failure(
        ToolExecutionErrorType.UNKNOWN_TOOL,
        `Tool "${call.name}" is not registered`,
      )
    }

    if (options.signal.aborted) {
      return failure(
        ToolExecutionErrorType.ABORTED,
        ToolExecutionErrorMessages[ToolExecutionErrorType.ABORTED],
      )
    }

    let signalAbortFn: () => void

    return Promise.race([
      new Promise((_, reject) => {
        signalAbortFn = () => reject(new DOMException('Execution aborted', 'AbortError'))
        options.signal.addEventListener(
          'abort',
          signalAbortFn,
          { once: true },
        )
      }),
      Promise.resolve()
        .then(() => JSON.parse(call.arguments))
        .catch(() => {
          throw new ClassifiedToolError(
            ToolExecutionErrorType.INVALID_JSON,
            ToolExecutionErrorMessages[ToolExecutionErrorType.INVALID_JSON],
          )
        })
        .then(arguments_ => tool.invoke(
          arguments_,
          { runId: options.runId, toolCallId: call.callId, signal: options.signal },
        )),
    ]).then((result): ToolExecutionResult => {
      return {
        ok: true,
        callId: call.callId,
        name: call.name,
        output: result,
      }
    }).catch((error) => {
      if (error instanceof ClassifiedToolError) {
        return failure(error.code, error.message)
      }
      if (options.signal.aborted) {
        return failure(
          ToolExecutionErrorType.ABORTED,
          ToolExecutionErrorMessages[ToolExecutionErrorType.ABORTED],
        )
      }

      if (error instanceof z.ZodError) {
        return failure(ToolExecutionErrorType.INVALID_ARGUMENTS, error.message)
      }

      return failure(
        ToolExecutionErrorType.EXECUTION_FAILED,
        error instanceof Error
          ? error.message
          : ToolExecutionErrorMessages[ToolExecutionErrorType.EXECUTION_FAILED],
      )
    }).finally(() => {
      if (signalAbortFn) {
        options.signal.removeEventListener('abort', signalAbortFn)
      }
    })
  }
}

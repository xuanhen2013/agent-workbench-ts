/** 通用 Tool System 的调用错误边界。 */
export enum ToolExecutionErrorType {
  UNKNOWN_TOOL = 'unknown_tool',
  INVALID_JSON = 'invalid_json',
  INVALID_ARGUMENTS = 'invalid_arguments',
  ABORTED = 'aborted',
  EXECUTION_FAILED = 'execution_failed',
}

export const ToolExecutionErrorMessages = {
  [ToolExecutionErrorType.UNKNOWN_TOOL]: 'Tool is not registered.',
  [ToolExecutionErrorType.INVALID_JSON]: 'Invalid arguments JSON.',
  [ToolExecutionErrorType.INVALID_ARGUMENTS]: 'Tool arguments are invalid.',
  [ToolExecutionErrorType.ABORTED]: 'Execution aborted',
  [ToolExecutionErrorType.EXECUTION_FAILED]: 'Tool execution failed.',
} satisfies Record<ToolExecutionErrorType, string>

export interface ToolExecutionError {
  code: ToolExecutionErrorType
  message: string
  runId: string
}

export type ToolExecutionResult
  = | {
    ok: true
    callId: string
    name: string
    output: unknown
  }
  | {
    ok: false
    callId: string
    name: string
    error: ToolExecutionError
  }

export function toolExecutionErrorMessage(
  code: ToolExecutionErrorType,
): string {
  return ToolExecutionErrorMessages[code]
}

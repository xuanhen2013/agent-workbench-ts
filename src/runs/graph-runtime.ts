import type { StateSnapshot } from '@langchain/langgraph'
import type { RunError, RunIndex, RunRecord } from './run-index'
import { Command } from '@langchain/langgraph'
import { z } from 'zod/v4'
import { RunStatus } from './run-index'

/**
 * 未接入当前 Joke Demo 的 Runtime 参考实现。
 * 先保留 start/resume/生命周期结构，后续产品化时再按真实 Contract 重构。
 */
const ApprovalRequestSchema = z.object({
  approvalId: z.string().min(1),
}).passthrough()

const ApprovalDecisionSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.string().min(1),
}).passthrough()

type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>

export interface GraphInvokeConfig {
  context: { runId: string }
  configurable: { thread_id: string }
  durability: 'sync'
  signal: AbortSignal
}

export type ApprovalResumeCommand = Command<ApprovalDecision, never, never>

export interface ManagedGraphPort<TStartInput, TOutput> {
  invoke: (
    input: TStartInput | ApprovalResumeCommand,
    config: GraphInvokeConfig,
  ) => Promise<TOutput>
  getState: (config: {
    configurable: { thread_id: string }
  }) => Promise<StateSnapshot>
}

export type RunControlResult<TOutput>
  = | { ok: true, run: RunRecord, output: TOutput, snapshot: StateSnapshot }
    | { ok: false, error: RunError }

const TerminalStateSchema = z.object({
  status: z.enum(['completed', 'failed']),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})

export function getApprovalRequest(snapshot: StateSnapshot) {
  for (const task of snapshot.tasks) {
    for (const item of task.interrupts) {
      const request = ApprovalRequestSchema.safeParse(item.value)
      if (request.success)
        return request.data
    }
  }
  return undefined
}

/**
 * 在产品 Run 与 LangGraph Thread 之间做翻译：
 * 调用方使用 runId，Runtime 从 RunIndex 取得 threadId 后推进唯一 compiled Graph。
 */
export class GraphRuntime<TStartInput, TOutput> {
  constructor(private readonly deps: {
    graph: ManagedGraphPort<TStartInput, TOutput>
    runs: RunIndex
  }) {}

  async start(
    input: TStartInput,
    ids: { runId: string, threadId: string },
  ): Promise<RunControlResult<TOutput>> {
    // 先登记 runId/threadId，后续 GET/Resume 才有可信的状态链身份。
    if (!this.deps.runs.create(ids)) {
      return this.failure('run_already_exists', 'The run already exists.')
    }

    return this.invokeAndSettle(input, ids.runId, ids.threadId)
  }

  async resume(
    runId: string,
    rawDecision: unknown,
  ): Promise<RunControlResult<TOutput>> {
    // 外部不能指定 threadId；只能通过 runId 找回服务端保存的映射。
    const run = this.deps.runs.get(runId)
    if (!run)
      return this.failure('run_not_found', 'The run was not found.')

    if (run.status !== RunStatus.NeedsInput) {
      return this.failure('run_not_waiting', 'The run is not waiting for input.')
    }

    const snapshot = await this.getSnapshot(run.threadId)
    const request = getApprovalRequest(snapshot)
    if (!request) {
      return this.failure(
        'approval_request_missing',
        'The pending approval request could not be found.',
      )
    }

    const decision = ApprovalDecisionSchema.safeParse(rawDecision)
    if (!decision.success) {
      return this.failure(
        'invalid_approval_decision',
        'The approval decision is invalid.',
      )
    }

    if (decision.data.approvalId !== request.approvalId) {
      return this.failure(
        'approval_id_mismatch',
        'The approval decision does not match the pending request.',
      )
    }

    if (!this.deps.runs.transition(runId, RunStatus.NeedsInput, {
      status: RunStatus.Running,
    })) {
      return this.failure('resume_conflict', 'The run was already resumed.')
    }

    return this.invokeAndSettle(
      new Command<ApprovalDecision, never, never>({ resume: decision.data }),
      run.runId,
      run.threadId,
    )
  }

  getRun(runId: string) {
    return this.deps.runs.get(runId)
  }

  getSnapshot(threadId: string) {
    return this.deps.graph.getState({
      configurable: { thread_id: threadId },
    })
  }

  private async invokeAndSettle(
    input: TStartInput | ApprovalResumeCommand,
    runId: string,
    threadId: string,
  ): Promise<RunControlResult<TOutput>> {
    try {
      const output = await this.deps.graph.invoke(input, {
        context: { runId },
        configurable: { thread_id: threadId },
        durability: 'sync',
        signal: new AbortController().signal,
      })
      // invoke 的 output 不足以判断“暂停还是终态”，产品状态以最新 Snapshot 为准。
      const snapshot = await this.getSnapshot(threadId)

      if (snapshot.tasks.some(task => task.interrupts.length > 0)) {
        this.deps.runs.transition(runId, RunStatus.Running, {
          status: RunStatus.NeedsInput,
        })
        return this.success(runId, output, snapshot)
      }

      const terminal = TerminalStateSchema.safeParse(snapshot.values)
      if (!terminal.success) {
        return this.failRun(
          runId,
          'graph_non_terminal_state',
          'The graph stopped without an interrupt or terminal state.',
        )
      }

      if (terminal.data.status === 'failed') {
        const error = terminal.data.error ?? {
          code: 'graph_failed',
          message: 'The graph finished with a failed state.',
        }
        return this.failRun(runId, error.code, error.message)
      }

      this.deps.runs.transition(runId, RunStatus.Running, {
        status: RunStatus.Completed,
      })
      return this.success(runId, output, snapshot)
    }
    catch {
      return this.failRun(
        runId,
        'graph_runtime_error',
        'The graph execution failed unexpectedly.',
      )
    }
  }

  private success(
    runId: string,
    output: TOutput,
    snapshot: StateSnapshot,
  ): RunControlResult<TOutput> {
    const run = this.deps.runs.get(runId)
    return run
      ? { ok: true, run, output, snapshot }
      : this.failure('run_not_found', 'The run was not found.')
  }

  private failRun(runId: string, code: string, message: string) {
    const current = this.deps.runs.get(runId)
    if (current?.status === RunStatus.Running) {
      this.deps.runs.transition(runId, RunStatus.Running, {
        status: RunStatus.Failed,
        error: { code, message },
      })
    }
    return this.failure(code, message)
  }

  private failure(code: string, message: string) {
    return { ok: false as const, error: { code, message } }
  }
}

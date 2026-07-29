export enum RunStatus {
  Running = 'running',
  NeedsInput = 'needs_input',
  Completed = 'completed',
  Failed = 'failed',
}

export interface RunError {
  code: string
  message: string
}

export interface RunRecord {
  runId: string
  threadId: string
  status: RunStatus
  createdAt: string
  updatedAt: string
  error?: RunError
}

/**
 * 产品 Run 的单进程索引：保存公开 runId 到可信 threadId 的映射和生命周期。
 * 它不保存 Graph State；完整 State 仍由 LangGraph Checkpointer 持有。
 */
export class RunIndex {
  private readonly records = new Map<string, RunRecord>()

  _now = () => new Date().toISOString()

  create(input: Pick<RunRecord, 'runId' | 'threadId'>) {
    if (this.records.has(input.runId))
      return false

    const now = this._now()
    this.records.set(input.runId, {
      ...input,
      status: RunStatus.Running,
      createdAt: now,
      updatedAt: now,
    })
    return true
  }

  get(runId: string) {
    const record = this.records.get(runId)
    return record ? { ...record } : undefined
  }

  transition(
    runId: string,
    expected: RunStatus,
    update: { status: RunStatus, error?: RunError },
  ) {
    // 最小 expected-status 保护，避免已被推进的 Run 被普通重复命令覆盖。
    const record = this.records.get(runId)
    if (!record || record.status !== expected)
      return false

    const next: RunRecord = {
      ...record,
      status: update.status,
      updatedAt: this._now(),
    }

    if (update.error)
      next.error = update.error
    else
      delete next.error

    this.records.set(runId, next)
    return true
  }
}

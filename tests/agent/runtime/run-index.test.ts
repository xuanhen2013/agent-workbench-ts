import { describe, expect, test } from 'bun:test'
import { RunIndex, RunStatus } from '@/runs/run-index'

describe('RunIndex', () => {
  test('create 建立 running Run，重复 runId 不覆盖', () => {
    const runs = new RunIndex()
    expect(runs.create({ runId: 'run-1', threadId: 'thread-1' })).toBe(true)
    expect(runs.create({ runId: 'run-1', threadId: 'other' })).toBe(false)
    expect(runs.get('run-1')).toMatchObject({
      threadId: 'thread-1',
      status: RunStatus.Running,
    })
  })

  test('transition 只接受当前 expected status', () => {
    const runs = new RunIndex()
    runs.create({ runId: 'run-1', threadId: 'thread-1' })

    expect(runs.transition('run-1', RunStatus.NeedsInput, {
      status: RunStatus.Completed,
    })).toBe(false)
    expect(runs.transition('run-1', RunStatus.Running, {
      status: RunStatus.NeedsInput,
    })).toBe(true)
  })

  test('get 返回副本', () => {
    const runs = new RunIndex()
    runs.create({ runId: 'run-1', threadId: 'thread-1' })
    const outside = runs.get('run-1')
    if (!outside)
      throw new Error('Expected run.')
    outside.status = RunStatus.Failed
    expect(runs.get('run-1')?.status).toBe(RunStatus.Running)
  })
})

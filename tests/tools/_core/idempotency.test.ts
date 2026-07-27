import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { defineTool, ToolExecutor, ToolRegistry } from '@/tools/_core'

interface DiagnosisNote {
  id: string
  note: string
  idempotencyKey: string
}

class FakeDiagnosisNoteStore {
  private readonly recordsByIdempotencyKey = new Map<string, DiagnosisNote>()

  writeOnce(idempotencyKey: string, note: string): DiagnosisNote {
    const existing = this.recordsByIdempotencyKey.get(idempotencyKey)
    if (existing) {
      return existing
    }

    const record: DiagnosisNote = {
      id: `diagnosis-note-${this.recordsByIdempotencyKey.size + 1}`,
      note,
      idempotencyKey,
    }
    this.recordsByIdempotencyKey.set(idempotencyKey, record)

    return record
  }

  records(): DiagnosisNote[] {
    return [...this.recordsByIdempotencyKey.values()]
  }
}

function createWriteDiagnosisNoteFixture() {
  const store = new FakeDiagnosisNoteStore()
  const tool = defineTool({
    name: 'write_diagnosis_note',
    description: 'Write one diagnosis note.',
    schema: z.object({ note: z.string().min(1) }),
    handler(input, runtime) {
      // The Model controls note only. Runtime supplies the idempotency boundary.
      const idempotencyKey = `${runtime.runId}:${runtime.toolCallId}`
      return store.writeOnce(idempotencyKey, input.note)
    },
  })
  const registry = new ToolRegistry()
  registry.register(tool)

  return { executor: new ToolExecutor(registry), store, tool }
}

function writeDiagnosisNoteCall(
  callId: string,
  note: string,
  modelSuppliedIdempotencyKey = 'model-must-not-control-this',
) {
  return {
    callId,
    name: 'write_diagnosis_note',
    arguments: JSON.stringify({
      note,
      idempotencyKey: modelSuppliedIdempotencyKey,
    }),
  }
}

function executeOptions(runId: string) {
  return {
    runId,
    signal: new AbortController().signal,
  }
}

describe('test-only Fake write Tool idempotency', () => {
  test('相同 runtime runId + toolCallId 只写一次并返回同一结果，模型参数不能控制 key', async () => {
    const { executor, store } = createWriteDiagnosisNoteFixture()
    const runId = 'run-idempotency-same'
    const call = writeDiagnosisNoteCall(
      'write-diagnosis-1',
      'Check network connectivity.',
      'model-supplied-key-that-is-ignored',
    )

    const firstResult = await executor.execute(call, executeOptions(runId))
    const retryResult = await executor.execute(call, executeOptions(runId))

    const expectedRecord: DiagnosisNote = {
      id: 'diagnosis-note-1',
      note: 'Check network connectivity.',
      idempotencyKey: 'run-idempotency-same:write-diagnosis-1',
    }
    expect(firstResult).toEqual({
      ok: true,
      callId: call.callId,
      name: call.name,
      output: expectedRecord,
    })
    expect(retryResult).toEqual(firstResult)
    expect(store.records()).toEqual([expectedRecord])
    expect(store.records()[0]?.idempotencyKey).not.toBe('model-supplied-key-that-is-ignored')
  })

  test('不同 runtime key 各自写入一次', async () => {
    const { executor, store } = createWriteDiagnosisNoteFixture()

    await executor.execute(
      writeDiagnosisNoteCall('write-diagnosis-1', 'First note.'),
      executeOptions('run-idempotency-first'),
    )
    await executor.execute(
      writeDiagnosisNoteCall('write-diagnosis-2', 'Second note.'),
      executeOptions('run-idempotency-second'),
    )

    expect(store.records()).toEqual([
      {
        id: 'diagnosis-note-1',
        note: 'First note.',
        idempotencyKey: 'run-idempotency-first:write-diagnosis-1',
      },
      {
        id: 'diagnosis-note-2',
        note: 'Second note.',
        idempotencyKey: 'run-idempotency-second:write-diagnosis-2',
      },
    ])
  })
})

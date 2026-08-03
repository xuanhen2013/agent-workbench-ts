import { describe, expect, test } from 'bun:test'
import { progressPhaseToNodeId } from '../../web/src/InterviewQuizGraph'

describe('Interview Quiz Graph progress mapping', () => {
  test('Parent、Planning Subgraph 和 Tool Loop 阶段映射到真实 Node', () => {
    expect(progressPhaseToNodeId('loading_memory')).toBe('load_memory')
    expect(progressPhaseToNodeId('retrieving_question_signals')).toBe(
      'retrieve_question_signals',
    )
    expect(progressPhaseToNodeId('calling_model')).toBe('call_model')
    expect(progressPhaseToNodeId('executing_tools')).toBe('execute_tools')
    expect(progressPhaseToNodeId('grading')).toBe('verify')
    expect(progressPhaseToNodeId('saving_memory')).toBe('persist_memory')
    expect(progressPhaseToNodeId('replanning')).toBe('replan')
  })

  test('未知阶段不会伪造 Graph Node', () => {
    expect(progressPhaseToNodeId('not-a-real-phase')).toBeUndefined()
  })
})

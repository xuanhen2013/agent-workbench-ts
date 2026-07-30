import type OpenAI from 'openai'
import type {
  QuizPlannerInput,
  QuizPlanResult,
} from '@/agent/interview-quiz/planning'
import { describe, expect, test } from 'bun:test'
import {
  QuizDifficulty,
  QuizStrategy,
} from '@/agent/interview-quiz/contracts'
import {
  AGENT_QUIZ_INSTRUCTIONS,
  AGENT_QUIZ_PROMPT_CACHE_KEY,
  QuizPlanner,
} from '@/agent/interview-quiz/planning'
import { createQuizDraft } from '../../helpers/quiz'

function fakeClient(
  outputText: string,
  capture?: (params: Record<string, unknown>) => void,
): OpenAI {
  return {
    responses: {
      create: async (params: Record<string, unknown>) => {
        capture?.(params)
        return {
          output: [],
          output_text: outputText,
        }
      },
    },
  } as unknown as OpenAI
}

function validPlannerInput(): QuizPlannerInput {
  return {
    history: [{
      role: 'user',
      content: '请生成第 2 轮 Agent 工程面试选择题。',
    }],
    round: 2,
    difficulty: QuizDifficulty.Intermediate,
    strategy: QuizStrategy.Advance,
    previousQuestionStems: [],
  }
}

async function createRound(outputText: string): Promise<QuizPlanResult> {
  return await new QuizPlanner(fakeClient(outputText), 'fake-model')
    .createRound(validPlannerInput(), {
      signal: new AbortController().signal,
    })
}

function expectPlannerError(result: QuizPlanResult, code: string) {
  expect(result.ok).toBe(false)
  if (result.ok)
    throw new Error('Expected QuizPlanner to return a validation error.')

  expect(result.error.code).toBe(code)
}

describe('QuizPlanner', () => {
  test('合法五题会保留私有正确答案与解析', async () => {
    const draft = createQuizDraft(2)
    const result = await createRound(JSON.stringify(draft))

    expect(result.ok).toBe(true)
    if (!result.ok)
      throw new Error(`Expected a draft, received ${result.error.code}.`)

    expect(result.draft).toEqual(draft)
    expect(result.draft.questions[0]).toMatchObject({
      correctOptionIds: ['A'],
      explanation: expect.any(String),
    })
  })

  test('请求使用固定 instructions、稳定 cache key 和调用方 history', async () => {
    let request: Record<string, unknown> | undefined
    const draft = createQuizDraft(2)
    const input = validPlannerInput()
    const planner = new QuizPlanner(
      fakeClient(JSON.stringify(draft), params => request = params),
      'fake-model',
    )

    await planner.createRound(input, {
      signal: new AbortController().signal,
    })

    expect(request).toMatchObject({
      instructions: AGENT_QUIZ_INSTRUCTIONS,
      input: input.history,
      prompt_cache_key: AGENT_QUIZ_PROMPT_CACHE_KEY,
      store: false,
    })
    expect(AGENT_QUIZ_PROMPT_CACHE_KEY).not.toContain('thread')
  })

  test('模型返回非法 JSON 时返回 planner_json_invalid', async () => {
    expectPlannerError(await createRound('{not-json'), 'planner_json_invalid')
  })

  test('单选题有两个正确答案时返回 invalid_single_answer_count', async () => {
    const draft = createQuizDraft(2)
    draft.questions[0] = {
      ...draft.questions[0]!,
      correctOptionIds: ['A', 'B'],
    }

    expectPlannerError(
      await createRound(JSON.stringify(draft)),
      'invalid_single_answer_count',
    )
  })

  test('多选题将全部选项设为正确时返回 invalid_multiple_all_options_correct', async () => {
    const draft = createQuizDraft(2)
    draft.questions[2] = {
      ...draft.questions[2]!,
      correctOptionIds: ['A', 'B', 'C'],
    }

    expectPlannerError(
      await createRound(JSON.stringify(draft)),
      'invalid_multiple_all_options_correct',
    )
  })

  test('本轮重复题干返回 duplicate_question_stem', async () => {
    const draft = createQuizDraft(2)
    draft.questions[1] = {
      ...draft.questions[1]!,
      stem: `  ${draft.questions[0]!.stem.toUpperCase()}  `,
    }

    expectPlannerError(
      await createRound(JSON.stringify(draft)),
      'duplicate_question_stem',
    )
  })

  test('历史题干重复返回 repeated_question_stem', () => {
    const planner = new QuizPlanner(fakeClient('unused'), 'fake-model')
    const draft = createQuizDraft(2)
    const result = planner._validateQuizRoundDraft(draft, {
      ...validPlannerInput(),
      previousQuestionStems: [draft.questions[0]!.stem],
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr())
      expect(result.error.code).toBe('repeated_question_stem')
  })

  test('materialize 使用 threadId 与 round 生成确定且唯一的 ID', () => {
    const planner = new QuizPlanner(fakeClient('unused'), 'fake-model')
    const input = {
      threadId: 'thread-123',
      plannerInput: validPlannerInput(),
      draft: createQuizDraft(2),
    }

    const firstPlan = planner.materializeRoundPlan(input)
    const retriedPlan = planner.materializeRoundPlan(input)
    const questionIds = firstPlan.questions.map(question => question.questionId)

    expect(retriedPlan).toEqual(firstPlan)
    expect(firstPlan.reviewId).toBe('thread-123:round:2:review')
    expect(new Set(questionIds).size).toBe(5)
  })
})

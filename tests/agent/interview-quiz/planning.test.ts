import type OpenAI from 'openai'
import type {
  QuizPlannerInput,
  QuizPlanResult,
} from '@/agent/interview-quiz/planning'
import type { OpenAIResponse } from '@/clients/openai'
import type { RetrievedChunk } from '@/knowledge/contracts'
import type { SkillCatalogEntry } from '@/skills/contracts'
import { describe, expect, test } from 'bun:test'
import {
  QuizDifficulty,
  QuizStrategy,
} from '@/agent/interview-quiz/contracts'
import { InterviewQuizErrorCode } from '@/agent/interview-quiz/errors'
import {
  AGENT_QUIZ_INSTRUCTIONS,
  AGENT_QUIZ_PROMPT_CACHE_KEY,
  MAX_SKILL_TOOL_ROUNDS,
  QuizPlanner,
} from '@/agent/interview-quiz/planning'
import {
  KnowledgeEvidenceRole,
  KnowledgeSourceType,
} from '@/knowledge/contracts'
import { SkillName } from '@/skills/contracts'
import { SkillToolName } from '@/tools/skill'
import { createQuizDraft } from '../../helpers/quiz'

const skillCatalog: readonly SkillCatalogEntry[] = [{
  name: SkillName.QuestionAuthoring,
  description: 'Test question authoring instructions.',
  root: new URL(
    '../../skills/fixtures/question-authoring/',
    import.meta.url,
  ),
}]

const knowledgeSkillCatalog: readonly SkillCatalogEntry[] = [
  ...skillCatalog,
  {
    name: SkillName.KnowledgeRetrieval,
    description: 'Test knowledge retrieval instructions.',
    root: new URL(
      '../../../skills/knowledge-retrieval/',
      import.meta.url,
    ),
  },
]

function knowledgeChunk(
  evidenceRole = KnowledgeEvidenceRole.AnswerEvidence,
): RetrievedChunk {
  return {
    chunkId: `chunk:${evidenceRole}`,
    documentId: 'document:knowledge',
    sourceType: KnowledgeSourceType.UserNote,
    evidenceRole,
    title: 'Knowledge',
    sourceUri: 'fixture:knowledge',
    heading: 'Knowledge',
    text: 'LangGraph Node 读取 State 并返回局部状态更新。',
    ordinal: 0,
    score: 1,
  }
}

function usage(inputTokens: number, cachedTokens = 0) {
  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: cachedTokens,
      cache_write_tokens: 0,
    },
  }
}

function functionCallResponse(
  calls: Array<{
    callId: string
    name: string
    arguments: Record<string, unknown>
  }>,
  inputTokens = 100,
): OpenAIResponse {
  return {
    output: calls.map((call, index) => ({
      type: 'function_call',
      id: `function-call-${index}`,
      call_id: call.callId,
      name: call.name,
      arguments: JSON.stringify(call.arguments),
      status: 'completed',
    })),
    output_text: '',
    usage: usage(inputTokens),
  } as unknown as OpenAIResponse
}

function finalResponse(
  outputText: string,
  inputTokens = 300,
  cachedTokens = 200,
): OpenAIResponse {
  return {
    output: [{
      type: 'message',
      id: 'final-message',
      role: 'assistant',
      status: 'completed',
      content: [{
        type: 'output_text',
        text: outputText,
        annotations: [],
      }],
    }],
    output_text: outputText,
    usage: usage(inputTokens, cachedTokens),
  } as unknown as OpenAIResponse
}

function loadSkillResponse() {
  return functionCallResponse([{
    callId: 'load-skill-call',
    name: SkillToolName.LoadSkill,
    arguments: { skillName: SkillName.QuestionAuthoring },
  }])
}

function loadBothSkillsResponse() {
  return functionCallResponse([
    {
      callId: 'load-question-authoring-call',
      name: SkillToolName.LoadSkill,
      arguments: { skillName: SkillName.QuestionAuthoring },
    },
    {
      callId: 'load-knowledge-retrieval-call',
      name: SkillToolName.LoadSkill,
      arguments: { skillName: SkillName.KnowledgeRetrieval },
    },
  ])
}

function readResourcesResponse() {
  return functionCallResponse([
    {
      callId: 'single-choice-call',
      name: SkillToolName.ReadSkillResource,
      arguments: {
        skillName: SkillName.QuestionAuthoring,
        resourcePath: 'references/single-choice.md',
      },
    },
    {
      callId: 'multiple-choice-call',
      name: SkillToolName.ReadSkillResource,
      arguments: {
        skillName: SkillName.QuestionAuthoring,
        resourcePath: 'references/multiple-choice.md',
      },
    },
    {
      callId: 'advancement-call',
      name: SkillToolName.ReadSkillResource,
      arguments: {
        skillName: SkillName.QuestionAuthoring,
        resourcePath: 'references/advancement.md',
      },
    },
  ], 200)
}

function skillTrace(outputText: string): OpenAIResponse[] {
  return [
    loadSkillResponse(),
    readResourcesResponse(),
    finalResponse(outputText),
  ]
}

function fakeClient(
  responses: readonly OpenAIResponse[],
  capture?: (params: Record<string, unknown>) => void,
): OpenAI {
  let index = 0

  return {
    responses: {
      create: async (params: Record<string, unknown>) => {
        capture?.(params)
        const response = responses[index]
        index += 1
        if (!response)
          throw new Error('Fake Responses sequence exhausted.')
        return structuredClone(response)
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
    retrievedChunks: [],
  }
}

function createPlanner(
  responses: readonly OpenAIResponse[],
  catalog: readonly SkillCatalogEntry[] = skillCatalog,
) {
  return new QuizPlanner(fakeClient(responses), 'fake-model', {
    skillCatalog: catalog,
  })
}

async function createRound(outputText: string): Promise<QuizPlanResult> {
  return await createPlanner(skillTrace(outputText))
    .createRound(validPlannerInput(), {
      signal: new AbortController().signal,
    })
}

function expectPlannerError(
  result: QuizPlanResult,
  code: InterviewQuizErrorCode,
) {
  expect(result.ok).toBe(false)
  if (result.ok)
    throw new Error('Expected QuizPlanner to return a validation error.')

  expect(result.error.code).toBe(code)
}

describe('QuizPlanner', () => {
  test('完整 Skill Trace 后生成合法五题并只保留最终 continuation', async () => {
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
    expect(result.continuationItems).toHaveLength(1)
    expect(result.continuationItems[0]).toMatchObject({
      type: 'message',
      id: 'final-message',
    })
    expect(JSON.stringify(result.continuationItems)).not.toContain('load-skill-call')
    expect(result.usage).toEqual({
      inputTokens: 600,
      cachedTokens: 200,
      cacheWriteTokens: 0,
    })
  })

  test('三轮请求复用 toModelTurn continuation，并保持 metadata 前缀与稳定 cache key', async () => {
    const requests: Array<Record<string, unknown>> = []
    const draft = createQuizDraft(2)
    const input = validPlannerInput()
    const planner = new QuizPlanner(
      fakeClient(skillTrace(JSON.stringify(draft)), params => requests.push(params)),
      'fake-model',
      { skillCatalog },
    )

    await planner.createRound(input, {
      signal: new AbortController().signal,
    })

    expect(requests).toHaveLength(3)
    expect(requests[0]).toMatchObject({
      instructions: AGENT_QUIZ_INSTRUCTIONS,
      prompt_cache_key: AGENT_QUIZ_PROMPT_CACHE_KEY,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      store: false,
    })
    expect(AGENT_QUIZ_PROMPT_CACHE_KEY).toBe('agent-interview-quiz:v2')
    expect(AGENT_QUIZ_PROMPT_CACHE_KEY).not.toContain('thread')

    const firstInput = requests[0]!.input as Array<Record<string, unknown>>
    expect(firstInput).toHaveLength(3)
    expect(firstInput[0]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('<available_skills>'),
    })
    expect(String(firstInput[0]!.content)).not.toContain('# Test Question Authoring')
    expect(firstInput[1]).toEqual(
      input.history[0] as unknown as Record<string, unknown>,
    )
    expect(firstInput[2]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('<retrieved_knowledge>'),
    })

    const secondInput = requests[1]!.input as Array<Record<string, unknown>>
    expect(secondInput.filter(item => item.type === 'function_call')).toHaveLength(1)
    expect(secondInput.filter(item => item.type === 'function_call_output')).toHaveLength(1)
    expect(JSON.stringify(secondInput)).toContain('# Test Question Authoring')

    const thirdInput = requests[2]!.input as Array<Record<string, unknown>>
    expect(thirdInput.filter(item => item.type === 'function_call')).toHaveLength(4)
    expect(thirdInput.filter(item => item.type === 'function_call_output')).toHaveLength(4)
    expect(JSON.stringify(thirdInput)).toContain('Exactly one option')
    expect(JSON.stringify(thirdInput)).toContain('At least two options')
  })

  test('RAG 模式按需加载两个 Skill，并把当前轮 Chunk 放进请求而不是 continuation', async () => {
    const requests: Array<Record<string, unknown>> = []
    const evidence = knowledgeChunk()
    const draft = createQuizDraft(2)
    draft.questions = draft.questions.map(question => ({
      ...question,
      sourceChunkIds: [evidence.chunkId],
    }))
    const planner = new QuizPlanner(
      fakeClient([
        loadBothSkillsResponse(),
        readResourcesResponse(),
        finalResponse(JSON.stringify(draft)),
      ], params => requests.push(params)),
      'fake-model',
      { skillCatalog: knowledgeSkillCatalog },
    )

    const result = await planner.createRound({
      ...validPlannerInput(),
      retrievedChunks: [evidence],
    }, { signal: new AbortController().signal })

    expect(result.ok).toBe(true)
    expect(JSON.stringify(requests[0]?.input)).toContain(evidence.chunkId)
    expect(JSON.stringify(requests[1]?.input)).toContain('# Knowledge Retrieval')
    if (result.ok) {
      expect(JSON.stringify(result.continuationItems)).not.toContain(
        '<retrieved_knowledge>',
      )
    }
  })

  test('未加载必需 Skill 就直接输出时失败', async () => {
    const result = await createPlanner([
      finalResponse(JSON.stringify(createQuizDraft(2))),
    ]).createRound(validPlannerInput(), {
      signal: new AbortController().signal,
    })

    expectPlannerError(result, InterviewQuizErrorCode.RequiredSkillMissing)
  })

  test('Skill Tool 失败时返回统一错误且不披露 Loader 细节', async () => {
    const result = await createPlanner([
      loadSkillResponse(),
      functionCallResponse([{
        callId: 'escaped-resource-call',
        name: SkillToolName.ReadSkillResource,
        arguments: {
          skillName: SkillName.QuestionAuthoring,
          resourcePath: '../secret.md',
        },
      }]),
    ]).createRound(validPlannerInput(), {
      signal: new AbortController().signal,
    })

    expectPlannerError(result, InterviewQuizErrorCode.SkillToolFailed)
    if (!result.ok)
      expect(result.error.message).toBe('Skill Tool 执行失败。')
  })

  test('超过 Skill Tool 轮次预算时停止', async () => {
    const repeatedCalls = Array.from(
      { length: MAX_SKILL_TOOL_ROUNDS + 1 },
      () => loadSkillResponse(),
    )
    const result = await createPlanner(repeatedCalls)
      .createRound(validPlannerInput(), {
        signal: new AbortController().signal,
      })

    expectPlannerError(result, InterviewQuizErrorCode.SkillRoundLimit)
  })

  test('加载 Skill 后没有最终文本时返回 final output missing', async () => {
    const result = await createPlanner([
      loadSkillResponse(),
      {
        output: [],
        output_text: '',
      } as unknown as OpenAIResponse,
    ]).createRound(validPlannerInput(), {
      signal: new AbortController().signal,
    })

    expectPlannerError(result, InterviewQuizErrorCode.SkillFinalOutputMissing)
  })

  test('模型返回非法 JSON 时返回 planner_json_invalid', async () => {
    expectPlannerError(
      await createRound('{not-json'),
      InterviewQuizErrorCode.PlannerJsonInvalid,
    )
  })

  test('单选题有两个正确答案时返回 invalid_single_answer_count', async () => {
    const draft = createQuizDraft(2)
    draft.questions[0] = {
      ...draft.questions[0]!,
      correctOptionIds: ['A', 'B'],
    }

    expectPlannerError(
      await createRound(JSON.stringify(draft)),
      InterviewQuizErrorCode.InvalidSingleAnswerCount,
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
      InterviewQuizErrorCode.InvalidMultipleAllOptionsCorrect,
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
      InterviewQuizErrorCode.DuplicateQuestionStem,
    )
  })

  test('历史题干重复返回 repeated_question_stem', () => {
    const planner = createPlanner([])
    const draft = createQuizDraft(2)
    const result = planner._validateQuizRoundDraft(draft, {
      ...validPlannerInput(),
      previousQuestionStems: [draft.questions[0]!.stem],
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr())
      expect(result.error.code).toBe(InterviewQuizErrorCode.RepeatedQuestionStem)
  })

  test('RAG 引用只接受本轮 answer_evidence Chunk', () => {
    const planner = createPlanner([])
    const evidence = knowledgeChunk()
    const signal = knowledgeChunk(KnowledgeEvidenceRole.QuestionSignal)
    const draft = createQuizDraft(2)
    draft.questions = draft.questions.map(question => ({
      ...question,
      sourceChunkIds: [evidence.chunkId],
    }))

    expect(planner._validateQuizRoundDraft(draft, {
      ...validPlannerInput(),
      retrievedChunks: [evidence, signal],
    }).isOk()).toBe(true)

    draft.questions[0] = {
      ...draft.questions[0]!,
      sourceChunkIds: [signal.chunkId],
    }
    const invalid = planner._validateQuizRoundDraft(draft, {
      ...validPlannerInput(),
      retrievedChunks: [evidence, signal],
    })
    expect(invalid.isErr()).toBe(true)
    if (invalid.isErr())
      expect(invalid.error.code).toBe(InterviewQuizErrorCode.UnknownSourceChunkId)
  })

  test('materialize 使用 threadId 与 round 生成确定且唯一的 ID', () => {
    const planner = createPlanner([])
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

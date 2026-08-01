import type OpenAI from 'openai'
import type {
  QuizPlannerInput,
  QuizPlanResult,
} from '@/agent/interview-quiz/planning'
import type { OpenAIResponse } from '@/clients/openai'
import type { KnowledgeRetriever, RetrievedChunk } from '@/knowledge/contracts'
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
  MAX_ANSWER_EVIDENCE_SEARCHES,
  MAX_FORBIDDEN_QUESTION_STEMS,
  MAX_PLANNER_TOOL_ROUNDS,
  MAX_QUESTION_SIGNAL_SEARCHES,
  MAX_SIMILAR_JD_SEARCHES,
  QuizPlanner,
  renderForbiddenQuestionStems,
  renderLearningMemory,
} from '@/agent/interview-quiz/planning'
import { OpenAIResponsesExecutor } from '@/clients/openai'
import { SelectedJdSource } from '@/jd/contracts'
import {
  KnowledgeEvidenceRole,
  KnowledgeSourceType,
} from '@/knowledge/contracts'
import { SkillName } from '@/skills/contracts'
import { JdToolName } from '@/tools/jd'
import { KnowledgeToolName } from '@/tools/knowledge'
import { SkillToolName } from '@/tools/skill'
import { createQuizDraft as createRawQuizDraft } from '../../helpers/quiz'

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
  chunkId = `chunk:${evidenceRole}`,
): RetrievedChunk {
  return {
    chunkId,
    documentId: 'document:knowledge',
    sourceType: KnowledgeSourceType.UserNote,
    evidenceRole,
    ownerId: null,
    title: 'Knowledge',
    sourceUri: 'fixture:knowledge',
    heading: 'Knowledge',
    text: 'LangGraph Node 读取 State 并返回局部状态更新。',
    ordinal: 0,
    score: 1,
  }
}

function createQuizDraft(round = 2) {
  const evidence = knowledgeChunk()
  const draft = createRawQuizDraft(round)
  return {
    ...draft,
    questions: draft.questions.map(question => ({
      ...question,
      sourceChunkIds: [evidence.chunkId],
    })),
  }
}

class FakePlannerKnowledgeRetriever implements Pick<KnowledgeRetriever, 'search'> {
  readonly calls: Parameters<KnowledgeRetriever['search']>[0][] = []

  async search(
    input: Parameters<KnowledgeRetriever['search']>[0],
  ): Promise<RetrievedChunk[]> {
    input.signal.throwIfAborted()
    this.calls.push(input)
    const role = input.filter?.evidenceRoles?.[0]
      ?? KnowledgeEvidenceRole.AnswerEvidence
    return [knowledgeChunk(role)]
  }
}

class BatchedKnowledgeRetriever implements Pick<KnowledgeRetriever, 'search'> {
  readonly calls: Parameters<KnowledgeRetriever['search']>[0][] = []

  constructor(private readonly batches: RetrievedChunk[][]) {}

  async search(
    input: Parameters<KnowledgeRetriever['search']>[0],
  ): Promise<RetrievedChunk[]> {
    input.signal.throwIfAborted()
    const batch = this.batches[this.calls.length] ?? []
    this.calls.push(input)
    return batch
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

function searchQuestionSignalResponse(
  callId = 'search-question-signal-call',
) {
  return functionCallResponse([{
    callId,
    name: KnowledgeToolName.SearchQuestionSignal,
    arguments: { query: 'LangGraph 高频面试误区' },
  }])
}

function searchAnswerEvidenceResponse(
  callId = 'search-answer-evidence-call',
) {
  return functionCallResponse([{
    callId,
    name: KnowledgeToolName.SearchAnswerEvidence,
    arguments: { query: 'LangGraph StateGraph Node state update' },
  }])
}

function searchSimilarJdsResponse(
  callId = 'search-similar-jds-call',
) {
  return functionCallResponse([{
    callId,
    name: JdToolName.SearchSimilarJds,
    arguments: { query: 'Agent 前端共同要求' },
  }])
}

function skillTrace(outputText: string): OpenAIResponse[] {
  return [
    loadSkillResponse(),
    readResourcesResponse(),
    searchAnswerEvidenceResponse(),
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

function fakeExecutor(
  responses: readonly OpenAIResponse[],
  capture?: (params: Record<string, unknown>) => void,
  reasoning?: NonNullable<
    OpenAI.Responses.ResponseCreateParamsNonStreaming['reasoning']
  >,
) {
  return new OpenAIResponsesExecutor({
    client: fakeClient(responses, capture),
    defaults: {
      model: 'fake-model',
      store: false,
      ...(reasoning ? { reasoning } : {}),
    },
  })
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
    memoryContext: { weakKnowledgePoints: [] },
    jdContext: null,
  }
}

function plannerOptions(
  catalog: readonly SkillCatalogEntry[] = skillCatalog,
) {
  return {
    skillCatalog: catalog,
    questionSignalRetriever: new FakePlannerKnowledgeRetriever(),
    answerEvidenceRetriever: new FakePlannerKnowledgeRetriever(),
  }
}

function createPlanner(
  responses: readonly OpenAIResponse[],
  catalog: readonly SkillCatalogEntry[] = skillCatalog,
) {
  return new QuizPlanner(
    fakeExecutor(responses),
    plannerOptions(catalog),
  )
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
  test('长期记忆最多注入八个薄弱点，空记忆不增加上下文块', () => {
    const weakKnowledgePoints = Array.from(
      { length: 10 },
      (_, index) => `weak-${index + 1}`,
    )
    const rendered = renderLearningMemory({ weakKnowledgePoints })

    expect(rendered).toContain('<learning_memory>')
    expect(rendered).toContain('weak-8')
    expect(rendered).not.toContain('weak-9')
    expect(renderLearningMemory({ weakKnowledgePoints: [] })).toBe('')
  })

  test('长期记忆只进入当前 Planner 请求，不进入 continuationItems', async () => {
    const requests: Array<Record<string, unknown>> = []
    const draft = createQuizDraft(2)
    const planner = new QuizPlanner(
      fakeExecutor(
        skillTrace(JSON.stringify(draft)),
        params => requests.push(params),
      ),
      plannerOptions(),
    )
    const result = await planner.createRound({
      ...validPlannerInput(),
      memoryContext: {
        weakKnowledgePoints: ['memory-only-state', 'memory-only-tool'],
      },
    }, { signal: new AbortController().signal })

    expect(result.ok).toBe(true)
    expect(JSON.stringify(requests[0]?.input)).toContain('<learning_memory>')
    expect(JSON.stringify(requests[0]?.input)).toContain('memory-only-state')
    if (result.ok) {
      expect(JSON.stringify(result.continuationItems))
        .not
        .toContain('<learning_memory>')
      expect(JSON.stringify(result.continuationItems))
        .not
        .toContain('memory-only-state')
    }
  })

  test('历史题干以有界负向列表进入模型，不携带私有题目字段', () => {
    const stems = Array.from(
      { length: MAX_FORBIDDEN_QUESTION_STEMS + 5 },
      (_, index) => `历史题干 ${index + 1}`,
    )
    stems.splice(1, 0, '  历史题干 1  ')

    const rendered = renderForbiddenQuestionStems(stems)
    const serialized = rendered
      .replace(/^<forbidden_question_stems>\n[^\n]+\n/, '')
      .replace(/\n<\/forbidden_question_stems>$/, '')
    const parsed = JSON.parse(serialized) as string[]

    expect(parsed).toHaveLength(MAX_FORBIDDEN_QUESTION_STEMS)
    expect(parsed[0]).toBe('历史题干 1')
    expect(parsed.at(-1)).toBe(`历史题干 ${MAX_FORBIDDEN_QUESTION_STEMS}`)
    expect(rendered).toContain('不是示范')
    expect(rendered).not.toContain('correctOptionIds')
    expect(rendered).not.toContain('explanation')
  })

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
    expect(result.retrievedChunks).toEqual([knowledgeChunk()])
    expect(result.usage).toEqual({
      inputTokens: 700,
      cachedTokens: 200,
      cacheWriteTokens: 0,
    })
  })

  test('四轮请求复用 toModelTurn continuation，并保持 metadata 前缀与稳定 cache key', async () => {
    const requests: Array<Record<string, unknown>> = []
    const draft = createQuizDraft(2)
    const input = validPlannerInput()
    input.previousQuestionStems = ['旧题：Agent Loop 的职责是什么？']
    const planner = new QuizPlanner(
      fakeExecutor(
        skillTrace(JSON.stringify(draft)),
        params => requests.push(params),
        { effort: 'medium' },
      ),
      plannerOptions(),
    )

    await planner.createRound(input, {
      signal: new AbortController().signal,
    })

    expect(requests).toHaveLength(4)
    expect(requests[0]).toMatchObject({
      instructions: AGENT_QUIZ_INSTRUCTIONS,
      prompt_cache_key: AGENT_QUIZ_PROMPT_CACHE_KEY,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      reasoning: { effort: 'medium' },
      store: false,
    })
    expect(AGENT_QUIZ_PROMPT_CACHE_KEY).toBe('agent-interview-quiz:v5')
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
    const planningContext = String(firstInput[2]!.content)
    expect(firstInput[2]!.role).toBe('user')
    expect(planningContext).toContain('<retrieved_knowledge>')
    expect(planningContext).toContain('<forbidden_question_stems>')
    expect(planningContext).toContain('旧题：Agent Loop 的职责是什么？')

    const secondInput = requests[1]!.input as Array<Record<string, unknown>>
    expect(secondInput.filter(item => item.type === 'function_call')).toHaveLength(1)
    expect(secondInput.filter(item => item.type === 'function_call_output')).toHaveLength(1)
    expect(JSON.stringify(secondInput)).toContain('# Test Question Authoring')

    const thirdInput = requests[2]!.input as Array<Record<string, unknown>>
    expect(thirdInput.filter(item => item.type === 'function_call')).toHaveLength(4)
    expect(thirdInput.filter(item => item.type === 'function_call_output')).toHaveLength(4)
    expect(JSON.stringify(thirdInput)).toContain('Exactly one option')
    expect(JSON.stringify(thirdInput)).toContain('At least two options')

    const fourthInput = requests[3]!.input as Array<Record<string, unknown>>
    expect(fourthInput.filter(item => item.type === 'function_call')).toHaveLength(5)
    expect(fourthInput.filter(item => item.type === 'function_call_output')).toHaveLength(5)
    expect(JSON.stringify(fourthInput)).toContain(knowledgeChunk().chunkId)
  })

  test('RAG 模式加载两个 Skill，并通过两个 Tool 动态追加资料', async () => {
    const requests: Array<Record<string, unknown>> = []
    const evidence = knowledgeChunk()
    const signal = knowledgeChunk(KnowledgeEvidenceRole.QuestionSignal)
    const draft = createQuizDraft(2)
    const questionSignalRetriever = new FakePlannerKnowledgeRetriever()
    const answerEvidenceRetriever = new FakePlannerKnowledgeRetriever()
    const planner = new QuizPlanner(
      fakeExecutor([
        loadBothSkillsResponse(),
        readResourcesResponse(),
        searchQuestionSignalResponse(),
        searchAnswerEvidenceResponse(),
        finalResponse(JSON.stringify(draft)),
      ], params => requests.push(params)),
      {
        skillCatalog: knowledgeSkillCatalog,
        questionSignalRetriever,
        answerEvidenceRetriever,
      },
    )

    const result = await planner.createRound({
      ...validPlannerInput(),
      retrievedChunks: [signal],
    }, { signal: new AbortController().signal })

    expect(result.ok).toBe(true)
    expect(JSON.stringify(requests[0]?.input)).toContain(signal.chunkId)
    expect(JSON.stringify(requests[0]?.input)).not.toContain(evidence.chunkId)
    expect(JSON.stringify(requests[1]?.input)).toContain('# Knowledge Retrieval')
    expect(questionSignalRetriever.calls).toHaveLength(1)
    expect(answerEvidenceRetriever.calls).toHaveLength(1)
    if (result.ok) {
      expect(result.retrievedChunks).toEqual([signal, evidence])
      expect(JSON.stringify(result.continuationItems)).not.toContain(
        '<retrieved_knowledge>',
      )
      expect(JSON.stringify(result.continuationItems)).not.toContain(
        'search-answer-evidence-call',
      )
    }
  })

  test('只有市场 JD 模式注册 search_similar_jds，并把有界结果返回模型', async () => {
    const requests: Array<Record<string, unknown>> = []
    const catalogCalls: unknown[] = []
    const selectedItemKey
      = 'question-signal/jd-market/jd-market-aaaaaaaaaaaaaaaaaaaa.md'
    const planner = new QuizPlanner(
      fakeExecutor([
        loadSkillResponse(),
        searchSimilarJdsResponse(),
        searchAnswerEvidenceResponse(),
        finalResponse(JSON.stringify(createQuizDraft(2))),
      ], params => requests.push(params)),
      {
        ...plannerOptions(),
        marketJdCatalog: {
          async search(input) {
            catalogCalls.push(input)
            return [{
              itemKey: 'question-signal/jd-market/jd-market-bbbbbbbbbbbbbbbbbbbb.md',
              title: 'AI Agent 前端工程师',
              company: '示例公司',
              location: '广州',
              salary: '20-35K',
              highlights: ['React', 'LangGraph'],
              focusKnowledgePoints: ['LangGraph', 'Tool Calling'],
              summary: '负责 Agent 前端与 Tool Calling 交互。',
            }]
          },
        },
      },
    )

    const result = await planner.createRound({
      ...validPlannerInput(),
      jdContext: {
        reference: {
          source: SelectedJdSource.Market,
          itemKey: selectedItemKey,
        },
        title: 'Agent 前端工程师',
        focusKnowledgePoints: ['LangGraph'],
      },
    }, { signal: new AbortController().signal })

    expect(result.ok).toBe(true)
    expect(catalogCalls[0]).toMatchObject({
      query: 'Agent 前端共同要求',
      limit: 3,
      excludeItemKey: selectedItemKey,
    })
    const firstTools = requests[0]?.tools as Array<{ name: string }>
    expect(firstTools.map(tool => tool.name)).toContain(
      JdToolName.SearchSimilarJds,
    )
    expect(JSON.stringify(requests[2]?.input)).toContain('示例公司')
  })

  test('相近 JD 搜索超额时在执行任何 Catalog 查询前拒绝整轮', async () => {
    let searchCount = 0
    const calls = Array.from(
      { length: MAX_SIMILAR_JD_SEARCHES + 1 },
      (_, index) => ({
        callId: `similar-jd-${index}`,
        name: JdToolName.SearchSimilarJds,
        arguments: { query: `Agent 前端 ${index}` },
      }),
    )
    const planner = new QuizPlanner(
      fakeExecutor([loadSkillResponse(), functionCallResponse(calls)]),
      {
        ...plannerOptions(),
        marketJdCatalog: {
          async search() {
            searchCount += 1
            return []
          },
        },
      },
    )
    const itemKey
      = 'question-signal/jd-market/jd-market-aaaaaaaaaaaaaaaaaaaa.md'

    const result = await planner.createRound({
      ...validPlannerInput(),
      jdContext: {
        reference: { source: SelectedJdSource.Market, itemKey },
        title: 'Agent 前端工程师',
        focusKnowledgePoints: ['LangGraph'],
      },
    }, { signal: new AbortController().signal })

    expectPlannerError(result, InterviewQuizErrorCode.SimilarJdSearchLimit)
    expect(searchCount).toBe(0)
  })

  test('没有 answer_evidence 就输出时返回稳定错误', async () => {
    const result = await createPlanner([
      loadSkillResponse(),
      finalResponse(JSON.stringify(createQuizDraft(2))),
    ]).createRound(validPlannerInput(), {
      signal: new AbortController().signal,
    })

    expectPlannerError(result, InterviewQuizErrorCode.AnswerEvidenceMissing)
  })

  test('Question Signal 搜索超额时在执行任何搜索前拒绝整轮', async () => {
    const questionSignalRetriever = new FakePlannerKnowledgeRetriever()
    const calls = Array.from(
      { length: MAX_QUESTION_SIGNAL_SEARCHES + 1 },
      (_, index) => ({
        callId: `question-signal-${index}`,
        name: KnowledgeToolName.SearchQuestionSignal,
        arguments: { query: `LangGraph 高频误区 ${index}` },
      }),
    )
    const planner = new QuizPlanner(
      fakeExecutor([loadSkillResponse(), functionCallResponse(calls)]),
      {
        skillCatalog,
        questionSignalRetriever,
        answerEvidenceRetriever: new FakePlannerKnowledgeRetriever(),
      },
    )

    const result = await planner.createRound(validPlannerInput(), {
      signal: new AbortController().signal,
    })

    expectPlannerError(
      result,
      InterviewQuizErrorCode.QuestionSignalSearchLimit,
    )
    expect(questionSignalRetriever.calls).toHaveLength(0)
  })

  test('Answer Evidence 搜索超额时在执行任何搜索前拒绝整轮', async () => {
    const answerEvidenceRetriever = new FakePlannerKnowledgeRetriever()
    const calls = Array.from(
      { length: MAX_ANSWER_EVIDENCE_SEARCHES + 1 },
      (_, index) => ({
        callId: `answer-evidence-${index}`,
        name: KnowledgeToolName.SearchAnswerEvidence,
        arguments: { query: `LangGraph 官方证据 ${index}` },
      }),
    )
    const planner = new QuizPlanner(
      fakeExecutor([loadSkillResponse(), functionCallResponse(calls)]),
      {
        skillCatalog,
        questionSignalRetriever: new FakePlannerKnowledgeRetriever(),
        answerEvidenceRetriever,
      },
    )

    const result = await planner.createRound(validPlannerInput(), {
      signal: new AbortController().signal,
    })

    expectPlannerError(
      result,
      InterviewQuizErrorCode.AnswerEvidenceSearchLimit,
    )
    expect(answerEvidenceRetriever.calls).toHaveLength(0)
  })

  test('Knowledge Tool 失败时隐藏 Retriever 原始异常', async () => {
    const failingRetriever: Pick<KnowledgeRetriever, 'search'> = {
      async search() {
        throw new Error('secret cloudflare response')
      },
    }
    const planner = new QuizPlanner(
      fakeExecutor([loadSkillResponse(), searchAnswerEvidenceResponse()]),
      {
        skillCatalog,
        questionSignalRetriever: new FakePlannerKnowledgeRetriever(),
        answerEvidenceRetriever: failingRetriever,
      },
    )

    const result = await planner.createRound(validPlannerInput(), {
      signal: new AbortController().signal,
    })

    expectPlannerError(result, InterviewQuizErrorCode.KnowledgeToolFailed)
    if (!result.ok)
      expect(result.error.message).not.toContain('secret')
  })

  test('两种 Chunk 分别限量，丢弃项既不进 State 也不回传模型', async () => {
    const requests: Array<Record<string, unknown>> = []
    const initialSignals = Array.from({ length: 4 }, (_, index) => (
      knowledgeChunk(
        KnowledgeEvidenceRole.QuestionSignal,
        `initial-signal:${index}`,
      )
    ))
    const extraSignals = Array.from({ length: 5 }, (_, index) => (
      knowledgeChunk(
        KnowledgeEvidenceRole.QuestionSignal,
        `extra-signal:${index}`,
      )
    ))
    const allEvidence = Array.from({ length: 15 }, (_, index) => (
      knowledgeChunk(
        KnowledgeEvidenceRole.AnswerEvidence,
        `answer-evidence:${index}`,
      )
    ))
    const answerEvidenceRetriever = new BatchedKnowledgeRetriever([
      allEvidence.slice(0, 5),
      allEvidence.slice(5, 10),
      allEvidence.slice(10, 15),
    ])
    const draft = createQuizDraft(2)
    draft.questions = draft.questions.map(question => ({
      ...question,
      sourceChunkIds: ['answer-evidence:0'],
    }))
    const planner = new QuizPlanner(
      fakeExecutor([
        loadSkillResponse(),
        searchQuestionSignalResponse(),
        searchAnswerEvidenceResponse('answer-search-1'),
        searchAnswerEvidenceResponse('answer-search-2'),
        searchAnswerEvidenceResponse('answer-search-3'),
        finalResponse(JSON.stringify(draft)),
      ], params => requests.push(params)),
      {
        skillCatalog,
        questionSignalRetriever: new BatchedKnowledgeRetriever([extraSignals]),
        answerEvidenceRetriever,
      },
    )

    const result = await planner.createRound({
      ...validPlannerInput(),
      retrievedChunks: initialSignals,
    }, { signal: new AbortController().signal })

    expect(result.ok).toBe(true)
    if (!result.ok)
      throw new Error(result.error.code)

    expect(result.retrievedChunks.filter(chunk => (
      chunk.evidenceRole === KnowledgeEvidenceRole.QuestionSignal
    ))).toHaveLength(8)
    expect(result.retrievedChunks.filter(chunk => (
      chunk.evidenceRole === KnowledgeEvidenceRole.AnswerEvidence
    ))).toHaveLength(12)
    expect(JSON.stringify(requests.at(-1)?.input)).toContain('answer-evidence:11')
    expect(JSON.stringify(requests.at(-1)?.input)).not.toContain('answer-evidence:12')
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

  test('超过 Planner Tool 轮次预算时停止', async () => {
    const repeatedCalls = Array.from(
      { length: MAX_PLANNER_TOOL_ROUNDS + 1 },
      () => loadSkillResponse(),
    )
    const result = await createPlanner(repeatedCalls)
      .createRound(validPlannerInput(), {
        signal: new AbortController().signal,
      })

    expectPlannerError(result, InterviewQuizErrorCode.PlannerToolRoundLimit)
  })

  test('加载 Skill 后没有最终文本时返回 final output missing', async () => {
    const result = await createPlanner([
      loadSkillResponse(),
      searchAnswerEvidenceResponse(),
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

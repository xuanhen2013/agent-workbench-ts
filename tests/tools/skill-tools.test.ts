import { describe, expect, test } from 'bun:test'
import { SkillName } from '@/skills/contracts'
import { loadSkillCatalog } from '@/skills/skill-loader'
import { ToolExecutionErrorType } from '@/tools/_core'
import {
  createSkillToolRuntime,
  SkillToolName,
} from '@/tools/skill'

const validRoot = new URL(
  '../skills/fixtures/question-authoring/',
  import.meta.url,
)

function executeOptions() {
  return {
    runId: 'skill-tool-test-run',
    signal: new AbortController().signal,
  }
}

describe('Skill Function Tools', () => {
  test('转换成两个严格的 Responses Function definitions', async () => {
    const catalog = await loadSkillCatalog([validRoot])
    const runtime = createSkillToolRuntime(catalog)

    expect(runtime.definitions).toHaveLength(2)
    expect(runtime.definitions.map(tool => tool.name)).toEqual([
      SkillToolName.LoadSkill,
      SkillToolName.ReadSkillResource,
    ])
    expect(runtime.definitions.every(tool => (
      tool.type === 'function' && tool.strict === true
    ))).toBe(true)
  })

  test('load_skill 通过统一 ToolExecutor 返回完整入口', async () => {
    const catalog = await loadSkillCatalog([validRoot])
    const runtime = createSkillToolRuntime(catalog)
    const result = await runtime.executor.execute({
      callId: 'load-call',
      name: SkillToolName.LoadSkill,
      arguments: JSON.stringify({
        skillName: SkillName.QuestionAuthoring,
      }),
    }, executeOptions())

    expect(result.ok).toBe(true)
    if (!result.ok)
      throw new Error(`Expected load_skill success: ${result.error.code}`)

    expect(result.output).toMatchObject({
      name: SkillName.QuestionAuthoring,
      description: 'Test question authoring instructions.',
      instructions: expect.stringContaining('# Test Question Authoring'),
    })
  })

  test('read_skill_resource 返回目标 reference', async () => {
    const catalog = await loadSkillCatalog([validRoot])
    const runtime = createSkillToolRuntime(catalog)
    const result = await runtime.executor.execute({
      callId: 'resource-call',
      name: SkillToolName.ReadSkillResource,
      arguments: JSON.stringify({
        skillName: SkillName.QuestionAuthoring,
        resourcePath: 'references/single-choice.md',
      }),
    }, executeOptions())

    expect(result.ok).toBe(true)
    if (!result.ok)
      throw new Error(`Expected resource success: ${result.error.code}`)

    expect(result.output).toMatchObject({
      skillName: SkillName.QuestionAuthoring,
      resourcePath: 'references/single-choice.md',
      content: expect.stringContaining('Exactly one option'),
    })
  })

  test('未登记 Skill、非法参数和越界路径返回受控失败', async () => {
    const emptyRuntime = createSkillToolRuntime([])
    const unknown = await emptyRuntime.executor.execute({
      callId: 'unknown-call',
      name: SkillToolName.LoadSkill,
      arguments: JSON.stringify({
        skillName: SkillName.QuestionAuthoring,
      }),
    }, executeOptions())

    expect(unknown).toMatchObject({
      ok: false,
      error: {
        code: ToolExecutionErrorType.EXECUTION_FAILED,
        message: 'Skill is not registered.',
      },
    })

    const catalog = await loadSkillCatalog([validRoot])
    const runtime = createSkillToolRuntime(catalog)
    const invalidArguments = await runtime.executor.execute({
      callId: 'invalid-arguments-call',
      name: SkillToolName.LoadSkill,
      arguments: JSON.stringify({ skillName: 'unknown-skill' }),
    }, executeOptions())
    const escaped = await runtime.executor.execute({
      callId: 'escaped-call',
      name: SkillToolName.ReadSkillResource,
      arguments: JSON.stringify({
        skillName: SkillName.QuestionAuthoring,
        resourcePath: '../secret.md',
      }),
    }, executeOptions())

    expect(invalidArguments).toMatchObject({
      ok: false,
      error: { code: ToolExecutionErrorType.INVALID_ARGUMENTS },
    })
    expect(escaped).toMatchObject({
      ok: false,
      error: {
        code: ToolExecutionErrorType.EXECUTION_FAILED,
        message: 'Skill resource path must be a Markdown file under references/.',
      },
    })
    expect(JSON.stringify([unknown, invalidArguments, escaped])).not.toContain('agent-workbench-ts')
  })
})

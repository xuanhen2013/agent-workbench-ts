import { describe, expect, test } from 'bun:test'
import { SkillName } from '@/skills/contracts'
import {
  loadSkill,
  loadSkillCatalog,
  parseSkillDocument,
  readSkillResource,
  SkillLoaderError,
  SkillLoaderErrorCode,
} from '@/skills/skill-loader'

const validRoot = new URL('./fixtures/question-authoring/', import.meta.url)

function expectLoaderError(
  operation: () => unknown,
  code: SkillLoaderErrorCode,
) {
  try {
    operation()
    throw new Error('Expected Skill Loader to throw.')
  }
  catch (error) {
    expect(error).toBeInstanceOf(SkillLoaderError)
    expect((error as SkillLoaderError).code).toBe(code)
  }
}

async function expectAsyncLoaderError(
  operation: () => Promise<unknown>,
  code: SkillLoaderErrorCode,
) {
  try {
    await operation()
    throw new Error('Expected Skill Loader to reject.')
  }
  catch (error) {
    expect(error).toBeInstanceOf(SkillLoaderError)
    expect((error as SkillLoaderError).code).toBe(code)
    expect((error as Error).message).not.toContain('agent-workbench-ts')
  }
}

describe('Skill Loader', () => {
  test('解析标准 frontmatter，并且正文不包含 frontmatter', () => {
    const parsed = parseSkillDocument([
      '---',
      'name: question-authoring',
      'description: Generate reliable questions.',
      '---',
      '',
      '# Instructions',
    ].join('\n'), SkillName.QuestionAuthoring)

    expect(parsed.metadata).toEqual({
      name: SkillName.QuestionAuthoring,
      description: 'Generate reliable questions.',
    })
    expect(parsed.instructions).toBe('# Instructions')
  })

  test('Catalog 只保留 metadata 与私有 root', async () => {
    const catalog = await loadSkillCatalog([validRoot])

    expect(catalog).toHaveLength(1)
    expect(catalog[0]).toMatchObject({
      name: SkillName.QuestionAuthoring,
      description: 'Test question authoring instructions.',
      root: expect.any(URL),
    })
    expect(catalog[0]).not.toHaveProperty('instructions')
  })

  test('激活时读取完整入口正文', async () => {
    const [entry] = await loadSkillCatalog([validRoot])
    if (!entry)
      throw new Error('Expected a catalog entry.')

    const loaded = await loadSkill(entry)

    expect(loaded.name).toBe(SkillName.QuestionAuthoring)
    expect(loaded.instructions).toContain('# Test Question Authoring')
    expect(loaded.instructions).not.toContain('description:')
  })

  test('目录名、frontmatter 和正文错误会被拒绝', () => {
    expectLoaderError(() => parseSkillDocument([
      '---',
      'name: question-authoring',
      'description: Valid description.',
      '---',
      '# Instructions',
    ].join('\n'), 'different-directory'), SkillLoaderErrorCode.NameMismatch)

    expectLoaderError(() => parseSkillDocument([
      '---',
      'name: question-authoring',
      'description: ""',
      '---',
      '# Instructions',
    ].join('\n'), SkillName.QuestionAuthoring), SkillLoaderErrorCode.InvalidDocument)

    expectLoaderError(() => parseSkillDocument([
      '---',
      'name: question-authoring',
      'description: Valid description.',
      '---',
      '',
    ].join('\n'), SkillName.QuestionAuthoring), SkillLoaderErrorCode.InvalidDocument)
  })

  test('读取 references 下的 Markdown', async () => {
    const [entry] = await loadSkillCatalog([validRoot])
    if (!entry)
      throw new Error('Expected a catalog entry.')

    const resource = await readSkillResource(
      entry,
      'references/single-choice.md',
    )

    expect(resource).toMatchObject({
      skillName: SkillName.QuestionAuthoring,
      resourcePath: 'references/single-choice.md',
    })
    expect(resource.content).toContain('Exactly one option')
  })

  test('拒绝路径穿越、绝对路径、反斜杠和非 reference', async () => {
    const [entry] = await loadSkillCatalog([validRoot])
    if (!entry)
      throw new Error('Expected a catalog entry.')

    const invalidPaths = [
      '../secret.md',
      'references/../../secret.md',
      'references/%2e%2e/secret.md',
      'C:/secret.md',
      '/etc/passwd.md',
      '\\\\server\\share\\secret.md',
      'references\\single-choice.md',
      'scripts/run.md',
      'references/file.txt',
    ]

    for (const resourcePath of invalidPaths) {
      await expectAsyncLoaderError(
        () => readSkillResource(entry, resourcePath),
        SkillLoaderErrorCode.InvalidResourcePath,
      )
    }
  })

  test('文件不存在和重复 Catalog 名称返回受控错误', async () => {
    const [entry] = await loadSkillCatalog([validRoot])
    if (!entry)
      throw new Error('Expected a catalog entry.')

    await expectAsyncLoaderError(
      () => readSkillResource(entry, 'references/missing.md'),
      SkillLoaderErrorCode.ResourceReadFailed,
    )
    await expectAsyncLoaderError(
      () => loadSkillCatalog([validRoot, validRoot]),
      SkillLoaderErrorCode.DuplicateName,
    )
  })
})

/** Skill Loader 自己的稳定错误边界。 */
export enum SkillLoaderErrorCode {
  InvalidRoot = 'skill_invalid_root',
  ManifestReadFailed = 'skill_manifest_read_failed',
  InvalidDocument = 'skill_invalid_document',
  NameMismatch = 'skill_name_mismatch',
  DuplicateName = 'skill_duplicate_name',
  InvalidResourcePath = 'skill_invalid_resource_path',
  ResourceReadFailed = 'skill_resource_read_failed',
}

/**
 * 对外安全的默认消息；不包含文件绝对路径、底层 fs 异常或 stack。
 */
export const SkillLoaderErrorMessages = {
  [SkillLoaderErrorCode.InvalidRoot]: 'Skill root must be a local file URL.',
  [SkillLoaderErrorCode.ManifestReadFailed]: 'Skill manifest could not be read.',
  [SkillLoaderErrorCode.InvalidDocument]: 'SKILL.md frontmatter is invalid.',
  [SkillLoaderErrorCode.NameMismatch]: 'Skill name must match its directory name.',
  [SkillLoaderErrorCode.DuplicateName]: 'Skill catalog contains a duplicate name.',
  [SkillLoaderErrorCode.InvalidResourcePath]: 'Skill resource path must be a Markdown file under references/.',
  [SkillLoaderErrorCode.ResourceReadFailed]: 'Skill resource could not be read.',
} satisfies Record<SkillLoaderErrorCode, string>

export class SkillLoaderError extends Error {
  constructor(
    readonly code: SkillLoaderErrorCode,
    message = SkillLoaderErrorMessages[code],
  ) {
    super(message)
    this.name = 'SkillLoaderError'
  }
}

export function createSkillLoaderError(
  code: SkillLoaderErrorCode,
): SkillLoaderError {
  return new SkillLoaderError(code)
}

export function raiseSkillLoaderError(
  code: SkillLoaderErrorCode,
): never {
  throw createSkillLoaderError(code)
}

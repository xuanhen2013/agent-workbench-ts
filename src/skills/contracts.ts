import { z } from 'zod/v4'

export enum SkillName {
  QuestionAuthoring = 'question-authoring',
}

/** 可以进入模型上下文的轻量 Skill 信息。 */
export interface SkillMetadata {
  name: SkillName
  description: string
}

/** 服务端 Catalog 条目；root 是私有能力边界，不能进入 Web DTO。 */
export interface SkillCatalogEntry extends SkillMetadata {
  root: URL
}

/** Skill 激活后返回的完整入口说明。 */
export interface LoadedSkill extends SkillMetadata {
  instructions: string
}

/** 按需读取的一份附属资源。 */
export interface LoadedSkillResource {
  skillName: SkillName
  resourcePath: string
  content: string
}

/** SKILL.md frontmatter 是文件输入边界，只在解析时校验一次。 */
export const SkillFrontmatterSchema = z.object({
  name: z.enum(SkillName),
  description: z.string().trim().min(1).max(1024),
}).passthrough()

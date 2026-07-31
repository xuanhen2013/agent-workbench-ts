import type { OpenAIResponseFunctionTool } from '@/clients/openai'
import type {
  LoadedSkill,
  LoadedSkillResource,
  SkillCatalogEntry,
} from '@/skills/contracts'
import type { MiniTool } from '@/tools/_core/types'
import { z } from 'zod/v4'
import { SkillName } from '@/skills/contracts'
import {
  findSkill,
  loadSkill,
  readSkillResource,
} from '@/skills/skill-loader'
import { defineTool, ToolExecutor, ToolRegistry } from '@/tools/_core'
import { toResponseTool } from '@/tools/_core/adapters/openai-response'

export enum SkillToolName {
  LoadSkill = 'load_skill',
  ReadSkillResource = 'read_skill_resource',
}

export const LoadSkillInputSchema = z.object({
  skillName: z.enum(SkillName),
}).strict()

export const ReadSkillResourceInputSchema = z.object({
  skillName: z.enum(SkillName),
  resourcePath: z.string().trim().min(1),
}).strict()

export type LoadSkillOutput = LoadedSkill
export type ReadSkillResourceOutput = LoadedSkillResource

export function createSkillTools(
  catalog: readonly SkillCatalogEntry[],
): readonly MiniTool[] {
  const loadSkillTool = defineTool({
    name: SkillToolName.LoadSkill,
    description: '读取一个已登记 Skill 的完整 SKILL.md。只有当前任务需要该 Skill 时才调用。',
    schema: LoadSkillInputSchema,
    handler: async ({ skillName }) => {
      const entry = findSkill(catalog, skillName)
      if (!entry)
        throw new Error('Skill is not registered.')

      return await loadSkill(entry)
    },
  })

  const readSkillResourceTool = defineTool({
    name: SkillToolName.ReadSkillResource,
    description: '读取已登记 Skill 中 SKILL.md 明确引用的一份 Markdown reference。',
    schema: ReadSkillResourceInputSchema,
    handler: async ({ skillName, resourcePath }) => {
      const entry = findSkill(catalog, skillName)
      if (!entry)
        throw new Error('Skill is not registered.')

      return await readSkillResource(entry, resourcePath)
    },
  })

  return [loadSkillTool, readSkillResourceTool]
}

export interface SkillToolRuntime {
  definitions: OpenAIResponseFunctionTool[]
  executor: ToolExecutor
}

export function createSkillToolRuntime(
  catalog: readonly SkillCatalogEntry[],
): SkillToolRuntime {
  const registry = new ToolRegistry()
  const tools = createSkillTools(catalog)

  for (const tool of tools)
    registry.register(tool)

  return {
    definitions: tools.map(toResponseTool),
    executor: new ToolExecutor(registry),
  }
}

import type { MiniTool } from '../types'
import { zodResponsesFunction } from 'openai/helpers/zod'

/**
 * response 结构
{
  type: 'function',
  name: 'get_weather',
  description: '...',
  parameters: { JSON Schema },
  strict: true,
}
 */

/**
 * chat 结构
{
    type: 'function',
    function: {
      name: 'get_weather',
      parameters: {},
    },
  }
 */

export function toResponseTool(tool: MiniTool) {
  return zodResponsesFunction({
    name: tool.name,
    description: tool.description,
    parameters: tool.schema,
  })
}

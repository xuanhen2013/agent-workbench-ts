import type OpenAI from 'openai'
import type z from 'zod'

export interface ToolDefinition extends OpenAI.Responses.FunctionTool {
  schema: z.ZodType
  fn: (args: any) => Promise<string>
}

export class ToolExecutor {
  tools: Record<string, ToolDefinition> = {}

  constructor() {
    this.tools = {}
  }

  registerTool(name: string, tool: ToolDefinition) {
    if (this.tools[name]) {
      throw new Error(`Tool ${name} is already registered`)
    }
    this.tools[name] = tool
  }

  getTool(name: string): OpenAI.Responses.FunctionTool {
    const tool = this.tools[name]
    if (!tool) {
      throw new Error(`Tool ${name} is not registered`)
    }

    return {
      type: tool.type,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      allowed_callers: tool.allowed_callers,
      strict: tool.strict ?? true,
    }
  }

  getAvailableTools(): Array<OpenAI.Responses.FunctionTool> {
    return Object.keys(this.tools).map(name => this.getTool(name))
  }

  async executeTool(name: string, argumentsJson: string): Promise<string> {
    if (!this.tools[name]) {
      return `不允许调用未知工具：${name}`
    }
    const tool = this.tools[name]
    if (!tool) {
      return `不允许调用未知工具：${name}`
    }

    const rawArguments = JSON.parse(argumentsJson)
    const args = tool.schema.parse(rawArguments)
    return tool.fn(args)
  }
}

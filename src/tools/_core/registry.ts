import type { MiniTool } from './types'

export class ToolRegistry {
  private tools: Map<string, MiniTool> = new Map()

  has(name: string): boolean {
    return this.tools.has(name)
  }

  get(name: string): MiniTool | undefined {
    return this.tools.get(name)
  }

  list(): MiniTool[] {
    return Array.from(this.tools.values())
  }

  register(tool: MiniTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`)
    }
    this.tools.set(tool.name, tool)
  }
}

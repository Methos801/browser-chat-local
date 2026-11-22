/**
 * ToolsRegistry: the single source of truth for the tools a model can call.
 *
 * Merges internal tools (document_parse, web_search, web_extract, scratch)
 * with tools contributed by local MCP servers (see mcp.ts) into one map of
 * { name, description, parameters, handler }. The tool loop (loop.ts)
 * advertises the specs to the model and routes calls back through handle().
 */

import type { ToolSpec } from "../ipc";

/** Executes a tool; returns the plain text fed back to the model. */
export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

export interface Tool extends ToolSpec {
  handler: ToolHandler;
}

export class ToolsRegistry {
  private tools = new Map<string, Tool>();

  /** Register a tool. First registration wins on name collisions. */
  register(tool: Tool): boolean {
    if (this.tools.has(tool.name)) return false;
    this.tools.set(tool.name, tool);
    return true;
  }

  removePrefix(prefix:string):void { for(const name of this.tools.keys()) if(name.startsWith(prefix)) this.tools.delete(name); }

  names(): string[] {
    return [...this.tools.keys()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Schemas to advertise to the model (all tools, or the given subset). */
  specs(names?: string[]): ToolSpec[] {
    const wanted = names && names.length ? names : this.names();
    const out: ToolSpec[] = [];
    for (const name of wanted) {
      const t = this.tools.get(name);
      if (t) out.push({ name: t.name, description: t.description, parameters: t.parameters });
    }
    return out;
  }

  /**
   * Route a tool call to its handler. Throws for unknown tools — the loop
   * catches that and feeds the error back to the model as a tool result.
   */
  async handle(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      const known = this.names().join(", ") || "none";
      throw new Error(`unknown tool "${name}" (registered: ${known})`);
    }
    return tool.handler(args ?? {});
  }
}

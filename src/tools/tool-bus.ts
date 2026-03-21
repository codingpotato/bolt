import { ToolError } from './tool';
import type { Tool, ToolCall, ToolContext, ToolResult, JSONSchema } from './tool';

/** Anthropic API tool definition format. */
export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: JSONSchema & { type: 'object' };
}

/**
 * Validates that all required fields declared in the JSON Schema are present
 * in the input object.  Deep validation is out of scope; we only check the
 * top-level `required` array.
 */
function validateRequired(schema: JSONSchema, input: unknown): string | null {
  const required = schema.required;
  if (!required || required.length === 0) return null;

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return `input must be an object`;
  }
  const obj = input as Record<string, unknown>;
  for (const field of required) {
    if (!(field in obj)) {
      return `required field "${field}" is missing`;
    }
  }
  return null;
}

/**
 * The Tool Bus is the central registry and dispatcher.
 *
 * Responsibilities:
 * - Register / unregister tools
 * - List registered tools
 * - Produce Anthropic API tool definitions
 * - Dispatch single and batched tool calls (with allowlist enforcement,
 *   input validation, audit logging, and parallelism control)
 */
export class ToolBus {
  private readonly registry = new Map<string, Tool>();

  register(tool: Tool): void {
    this.registry.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.registry.delete(name);
  }

  list(): Tool[] {
    return Array.from(this.registry.values());
  }

  getAnthropicDefinitions(): AnthropicToolDefinition[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: { ...tool.inputSchema, type: 'object' as const },
    }));
  }

  /**
   * Dispatch a single tool call.
   *
   * Order of checks:
   * 1. Allowlist — if ctx.allowedTools is set, the tool must be in the list.
   * 2. Existence — tool must be registered.
   * 3. Input validation — required fields must be present.
   * 4. Execute — call the tool.
   *
   * ToolErrors are caught and returned as is_error results.
   * Any other exception propagates to the caller.
   * All dispatches (success or failure) are written to the audit log.
   */
  async dispatch(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    // 1. Allowlist check
    if (ctx.allowedTools !== undefined && !ctx.allowedTools.includes(call.name)) {
      const errContent = JSON.stringify({
        error: `tool "${call.name}" is not allowed in this scope`,
      });
      await ctx.log.log(call.name, call.input, { error: 'not allowed' });
      return { id: call.id, content: errContent, is_error: true };
    }

    // 2. Existence check
    const tool = this.registry.get(call.name);
    if (tool === undefined) {
      const errContent = JSON.stringify({ error: `unknown tool: "${call.name}"` });
      await ctx.log.log(call.name, call.input, { error: 'unknown tool' });
      return { id: call.id, content: errContent, is_error: true };
    }

    // 3. Input validation
    const validationError = validateRequired(tool.inputSchema, call.input);
    if (validationError !== null) {
      const errContent = JSON.stringify({ error: `invalid input — ${validationError}` });
      await ctx.log.log(call.name, call.input, { error: validationError });
      return { id: call.id, content: errContent, is_error: true };
    }

    // 4. Execute (only ToolError is caught; other exceptions propagate)
    let result: unknown;
    try {
      result = await tool.execute(call.input, ctx);
    } catch (err) {
      if (err instanceof ToolError) {
        const errContent = JSON.stringify({ error: err.message, retryable: err.retryable });
        await ctx.log.log(call.name, call.input, { error: err.message });
        return { id: call.id, content: errContent, is_error: true };
      }
      throw err;
    }

    await ctx.log.log(call.name, call.input, result);
    return { id: call.id, content: JSON.stringify(result) };
  }

  /**
   * Dispatch multiple tool calls, respecting the `sequential` flag.
   *
   * - Non-sequential calls are launched concurrently with Promise.all.
   * - Sequential calls (tool.sequential === true) are awaited one at a time
   *   in the order they appear in `calls`.
   *
   * Results are returned in the same order as `calls`.
   */
  async dispatchAll(calls: ToolCall[], ctx: ToolContext): Promise<ToolResult[]> {
    const results: ToolResult[] = new Array(calls.length) as ToolResult[];

    // Split calls into sequential and parallel groups, preserving indices.
    const parallelBatch: Array<{ index: number; call: ToolCall }> = [];
    const sequentialBatch: Array<{ index: number; call: ToolCall }> = [];

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      if (call === undefined) continue;
      const tool = this.registry.get(call.name);
      if (tool?.sequential === true) {
        sequentialBatch.push({ index: i, call });
      } else {
        parallelBatch.push({ index: i, call });
      }
    }

    // Run parallel calls concurrently
    await Promise.all(
      parallelBatch.map(async ({ index, call }) => {
        results[index] = await this.dispatch(call, ctx);
      }),
    );

    // Run sequential calls one at a time
    for (const { index, call } of sequentialBatch) {
      results[index] = await this.dispatch(call, ctx);
    }

    return results;
  }

  /**
   * Compute the intersection of two optional allowlists.
   *
   * - Both undefined  → undefined (all tools allowed)
   * - One undefined   → the other list
   * - Both defined    → intersection
   */
  static intersectAllowlists(
    a: string[] | undefined,
    b: string[] | undefined,
  ): string[] | undefined {
    if (a === undefined && b === undefined) return undefined;
    if (a === undefined) return b;
    if (b === undefined) return a;
    const setB = new Set(b);
    return a.filter((name) => setB.has(name));
  }
}

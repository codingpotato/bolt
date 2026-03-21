import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolBus } from './tool-bus';
import { ToolError } from './tool';
import type { Tool, ToolContext, ToolCall } from './tool';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(
  name: string,
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>,
  sequential = false,
): Tool {
  return {
    name,
    description: `a ${name} tool`,
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
    sequential,
    execute: execute as Tool['execute'],
  };
}

function makeCall(name: string, input: unknown, id = '1'): ToolCall {
  return { id, name, input };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolBus', () => {
  let bus: ToolBus;
  let mockLogger: { log: ReturnType<typeof vi.fn> };
  let ctx: ToolContext;

  beforeEach(() => {
    bus = new ToolBus();
    mockLogger = { log: vi.fn().mockResolvedValue(undefined) };
    ctx = { cwd: '/tmp', log: mockLogger };
  });

  // ── register / list / unregister ──────────────────────────────────────────

  describe('register / list / unregister', () => {
    it('list returns empty array initially', () => {
      expect(bus.list()).toEqual([]);
    });

    it('list returns a registered tool', () => {
      const tool = makeTool('greet', async () => ({}));
      bus.register(tool);
      expect(bus.list()).toContain(tool);
    });

    it('list returns all registered tools', () => {
      const a = makeTool('a', async () => ({}));
      const b = makeTool('b', async () => ({}));
      bus.register(a);
      bus.register(b);
      expect(bus.list()).toHaveLength(2);
    });

    it('unregister removes the tool', () => {
      const tool = makeTool('greet', async () => ({}));
      bus.register(tool);
      bus.unregister('greet');
      expect(bus.list()).toHaveLength(0);
    });

    it('unregister on unknown name is a no-op', () => {
      expect(() => bus.unregister('nonexistent')).not.toThrow();
    });
  });

  // ── getAnthropicDefinitions ───────────────────────────────────────────────

  describe('getAnthropicDefinitions', () => {
    it('returns correct Anthropic format for a registered tool', () => {
      bus.register(makeTool('greet', async () => ({})));
      const defs = bus.getAnthropicDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0]).toMatchObject({
        name: 'greet',
        description: 'a greet tool',
        input_schema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      });
    });

    it('returns empty array when no tools registered', () => {
      expect(bus.getAnthropicDefinitions()).toEqual([]);
    });
  });

  // ── dispatch ─────────────────────────────────────────────────────────────

  describe('dispatch', () => {
    it('executes a known tool and returns its result', async () => {
      bus.register(
        makeTool('greet', async (input: Record<string, unknown>) => ({
          msg: `hello ${String(input['value'])}`,
        })),
      );
      const result = await bus.dispatch(makeCall('greet', { value: 'world' }), ctx);
      expect(result.is_error).toBeFalsy();
      const parsed = JSON.parse(result.content) as { msg: string };
      expect(parsed.msg).toBe('hello world');
    });

    it('echoes the call id back in the result', async () => {
      bus.register(makeTool('greet', async () => ({ ok: true })));
      const result = await bus.dispatch(makeCall('greet', { value: 'x' }, 'abc-123'), ctx);
      expect(result.id).toBe('abc-123');
    });

    it('returns ToolError for unknown tool', async () => {
      const result = await bus.dispatch(makeCall('unknown', {}), ctx);
      expect(result.is_error).toBe(true);
      expect(result.content).toMatch(/unknown tool/i);
    });

    it('returns ToolError when tool throws ToolError', async () => {
      bus.register(
        makeTool('fail', async () => {
          throw new ToolError('bad input');
        }),
      );
      const result = await bus.dispatch(makeCall('fail', { value: 'x' }), ctx);
      expect(result.is_error).toBe(true);
      expect(result.content).toMatch(/bad input/);
    });

    it('re-throws unexpected non-ToolError exceptions', async () => {
      bus.register(
        makeTool('explode', async () => {
          throw new TypeError('unexpected crash');
        }),
      );
      await expect(bus.dispatch(makeCall('explode', { value: 'x' }), ctx)).rejects.toThrow(
        'unexpected crash',
      );
    });

    it('logs every successful dispatch to audit log', async () => {
      bus.register(makeTool('greet', async () => ({ ok: true })));
      await bus.dispatch(makeCall('greet', { value: 'test' }), ctx);
      expect(mockLogger.log).toHaveBeenCalledOnce();
      expect(mockLogger.log).toHaveBeenCalledWith('greet', { value: 'test' }, expect.anything());
    });

    it('logs failed ToolError dispatch to audit log', async () => {
      bus.register(
        makeTool('fail', async () => {
          throw new ToolError('oops');
        }),
      );
      const result = await bus.dispatch(makeCall('fail', { value: 'x' }), ctx);
      expect(result.is_error).toBe(true);
      expect(mockLogger.log).toHaveBeenCalledOnce();
    });

    it('logs unknown-tool dispatch to audit log', async () => {
      await bus.dispatch(makeCall('ghost', {}), ctx);
      expect(mockLogger.log).toHaveBeenCalledOnce();
    });

    // ── allowlisting (S2-2) ────────────────────────────────────────────────

    it('allows tool when allowedTools is undefined (all allowed)', async () => {
      bus.register(makeTool('greet', async () => ({ ok: true })));
      const result = await bus.dispatch(makeCall('greet', { value: 'x' }), ctx);
      expect(result.is_error).toBeFalsy();
    });

    it('allows tool when it appears in allowedTools', async () => {
      bus.register(makeTool('greet', async () => ({ ok: true })));
      const restrictedCtx: ToolContext = { ...ctx, allowedTools: ['greet', 'other'] };
      const result = await bus.dispatch(makeCall('greet', { value: 'x' }), restrictedCtx);
      expect(result.is_error).toBeFalsy();
    });

    it('returns ToolError when tool is not in allowedTools', async () => {
      bus.register(makeTool('greet', async () => ({ ok: true })));
      const restrictedCtx: ToolContext = { ...ctx, allowedTools: ['other'] };
      const result = await bus.dispatch(makeCall('greet', { value: 'x' }), restrictedCtx);
      expect(result.is_error).toBe(true);
      expect(result.content).toMatch(/not allowed/i);
    });

    // ── input validation (S2-1) ────────────────────────────────────────────

    it('returns ToolError when a required input field is missing', async () => {
      bus.register(makeTool('greet', async () => ({ ok: true })));
      const result = await bus.dispatch(makeCall('greet', {}), ctx); // missing required 'value'
      expect(result.is_error).toBe(true);
      expect(result.content).toMatch(/required/i);
    });

    it('calls execute when all required fields are present', async () => {
      const executeSpy = vi.fn().mockResolvedValue({ ok: true });
      bus.register(makeTool('greet', executeSpy));
      const result = await bus.dispatch(makeCall('greet', { value: 'hi' }), ctx);
      expect(result.is_error).toBeFalsy();
      expect(executeSpy).toHaveBeenCalledOnce();
    });
  });

  // ── dispatchAll (S2-3 concurrency) ────────────────────────────────────────

  describe('dispatchAll', () => {
    it('returns results for all calls', async () => {
      bus.register(makeTool('a', async () => ({ r: 'a' })));
      bus.register(makeTool('b', async () => ({ r: 'b' })));
      const results = await bus.dispatchAll(
        [makeCall('a', { value: 'x' }, '1'), makeCall('b', { value: 'y' }, '2')],
        ctx,
      );
      expect(results).toHaveLength(2);
    });

    it('runs non-sequential tools concurrently', async () => {
      const startTimes: number[] = [];
      let resolveFirst!: () => void;

      const toolA = makeTool('a', async () => {
        startTimes.push(Date.now());
        await new Promise<void>((r) => {
          resolveFirst = r;
        });
        return {};
      });
      const toolB = makeTool('b', async () => {
        startTimes.push(Date.now());
        // unblock toolA so the test can complete
        resolveFirst();
        return {};
      });

      bus.register(toolA);
      bus.register(toolB);

      await bus.dispatchAll(
        [makeCall('a', { value: 'x' }, '1'), makeCall('b', { value: 'y' }, '2')],
        ctx,
      );

      // Both tools started — if sequential, toolB would never start because toolA
      // waits for resolveFirst which only toolB calls.
      expect(startTimes).toHaveLength(2);
    });

    it('runs sequential tools one at a time', async () => {
      const order: string[] = [];

      const toolA = makeTool(
        'a',
        async () => {
          order.push('a');
          return {};
        },
        true /* sequential */,
      );
      const toolB = makeTool(
        'b',
        async () => {
          order.push('b');
          return {};
        },
        true /* sequential */,
      );

      bus.register(toolA);
      bus.register(toolB);

      await bus.dispatchAll(
        [makeCall('a', { value: 'x' }, '1'), makeCall('b', { value: 'y' }, '2')],
        ctx,
      );

      expect(order).toEqual(['a', 'b']);
    });

    it('preserves result order matching input call order', async () => {
      bus.register(makeTool('a', async () => ({ r: 'a' })));
      bus.register(makeTool('b', async () => ({ r: 'b' })));
      const results = await bus.dispatchAll(
        [makeCall('a', { value: 'x' }, '1'), makeCall('b', { value: 'y' }, '2')],
        ctx,
      );
      expect(results[0]?.id).toBe('1');
      expect(results[1]?.id).toBe('2');
    });
  });

  // ── allowlist intersection (S2-2) ─────────────────────────────────────────

  describe('intersectAllowlists', () => {
    it('returns intersection of two non-null lists', () => {
      const result = ToolBus.intersectAllowlists(['bash', 'file_read', 'web_fetch'], [
        'web_fetch',
        'file_write',
      ]);
      expect(result).toEqual(['web_fetch']);
    });

    it('returns the non-null list when one is undefined', () => {
      expect(ToolBus.intersectAllowlists(undefined, ['file_read'])).toEqual(['file_read']);
      expect(ToolBus.intersectAllowlists(['file_read'], undefined)).toEqual(['file_read']);
    });

    it('returns undefined when both are undefined', () => {
      expect(ToolBus.intersectAllowlists(undefined, undefined)).toBeUndefined();
    });
  });
});

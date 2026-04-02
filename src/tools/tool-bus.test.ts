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
    ctx = { cwd: '/tmp', log: mockLogger, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, progress: { onSessionStart: vi.fn(), onThinking: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(), onTaskStatusChange: vi.fn(), onContextInjection: vi.fn(), onMemoryCompaction: vi.fn(), onRetry: vi.fn() } };
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

    // ── progress emissions (S5-2) ──────────────────────────────────────────

    it('emits onToolCall before executing the tool', async () => {
      bus.register(makeTool('greet', async () => ({ ok: true })));
      await bus.dispatch(makeCall('greet', { value: 'hi' }), ctx);
      expect(ctx.progress.onToolCall).toHaveBeenCalledOnce();
      expect(ctx.progress.onToolCall).toHaveBeenCalledWith('greet', { value: 'hi' });
    });

    it('emits onToolResult with success=true after a successful dispatch', async () => {
      bus.register(makeTool('greet', async () => ({ ok: true })));
      await bus.dispatch(makeCall('greet', { value: 'hi' }), ctx);
      expect(ctx.progress.onToolResult).toHaveBeenCalledOnce();
      expect(ctx.progress.onToolResult).toHaveBeenCalledWith('greet', true, expect.any(String));
    });

    it('emits onToolResult with success=false when tool throws ToolError', async () => {
      bus.register(
        makeTool('fail', async () => {
          throw new ToolError('bad input');
        }),
      );
      await bus.dispatch(makeCall('fail', { value: 'x' }), ctx);
      expect(ctx.progress.onToolResult).toHaveBeenCalledOnce();
      expect(ctx.progress.onToolResult).toHaveBeenCalledWith('fail', false, 'bad input');
    });

    it('does not emit onToolCall for allowlist failures', async () => {
      bus.register(makeTool('greet', async () => ({ ok: true })));
      const restrictedCtx: ToolContext = { ...ctx, allowedTools: ['other'] };
      await bus.dispatch(makeCall('greet', { value: 'hi' }), restrictedCtx);
      expect(restrictedCtx.progress.onToolCall).not.toHaveBeenCalled();
    });

    it('succeeds when tool has no required fields', async () => {
      const toolWithNoRequired: Tool = {
        name: 'optional',
        description: 'no required fields',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => ({ ok: true }),
      };
      bus.register(toolWithNoRequired);
      const result = await bus.dispatch(makeCall('optional', {}), ctx);
      expect(result.is_error).toBeFalsy();
    });

    it('handles non-JSON string result in summariseResult', async () => {
      bus.register(
        makeTool('textResult', async () => 'plain text string not json'),
      );
      await bus.dispatch(makeCall('textResult', { value: 'x' }), ctx);
      expect(ctx.progress.onToolResult).toHaveBeenCalledWith(
        'textResult',
        true,
        'plain text string not json',
      );
    });

    it('summarises exitCode from JSON result', async () => {
      bus.register(makeTool('bash', async () => ({ exitCode: 0, stdout: '' })));
      await bus.dispatch(makeCall('bash', { value: 'x' }), ctx);
      expect(ctx.progress.onToolResult).toHaveBeenCalledWith('bash', true, 'exit 0');
    });

    it('summarises path from JSON result', async () => {
      bus.register(makeTool('file', async () => ({ path: '/tmp/file.txt' })));
      await bus.dispatch(makeCall('file', { value: 'x' }), ctx);
      expect(ctx.progress.onToolResult).toHaveBeenCalledWith('file', true, '/tmp/file.txt');
    });

    it('summarises tasks count from JSON result', async () => {
      bus.register(
        makeTool('listTasks', async () => ({ tasks: [{ id: '1' }, { id: '2' }] })),
      );
      await bus.dispatch(makeCall('listTasks', { value: 'x' }), ctx);
      expect(ctx.progress.onToolResult).toHaveBeenCalledWith('listTasks', true, '2 tasks');
    });

    it('summarises id from JSON result', async () => {
      bus.register(makeTool('create', async () => ({ id: 'task-123' })));
      await bus.dispatch(makeCall('create', { value: 'x' }), ctx);
      expect(ctx.progress.onToolResult).toHaveBeenCalledWith('create', true, 'task-123');
    });
  });

  // ── input validation — null guard ─────────────────────────────────────────

  describe('validateRequired — null guard', () => {
    it('returns ToolError when a required field is null', async () => {
      bus.register(makeTool('greet', async () => ({ ok: true })));
      const result = await bus.dispatch(makeCall('greet', { value: null }), ctx);
      expect(result.is_error).toBe(true);
      expect(result.content).toMatch(/required/i);
    });

    it('returns ToolError when input itself is null', async () => {
      bus.register(makeTool('greet', async () => ({ ok: true })));
      const result = await bus.dispatch(makeCall('greet', null), ctx);
      expect(result.is_error).toBe(true);
      expect(result.content).toMatch(/must be an object/i);
    });

    it('returns ToolError when input is an array', async () => {
      bus.register(makeTool('greet', async () => ({ ok: true })));
      const result = await bus.dispatch(makeCall('greet', ['a', 'b']), ctx);
      expect(result.is_error).toBe(true);
      expect(result.content).toMatch(/must be an object/i);
    });
  });

  // ── register — duplicate name ──────────────────────────────────────────────

  describe('register — duplicate name', () => {
    it('second registration with the same name overwrites the first', () => {
      const toolV1 = makeTool('greet', async () => ({ version: 1 }));
      const toolV2 = makeTool('greet', async () => ({ version: 2 }));
      bus.register(toolV1);
      bus.register(toolV2);
      expect(bus.list()).toHaveLength(1);
      expect(bus.list()[0]).toBe(toolV2);
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

    it('sequential tool at index 0 starts before slow parallel tool at index 1 completes', async () => {
      // Proves the sequential-mutex approach: seq's dispatch is scheduled as a
      // microtask immediately (not gated behind all parallel calls completing).
      // With the old batch-split impl, seq would only start after par finished.
      const seqStarted: boolean[] = [];
      let releasePar!: () => void;

      const toolSeq = makeTool(
        'seq',
        async () => {
          seqStarted.push(true);
          return {};
        },
        true /* sequential */,
      );

      const toolPar = makeTool('par', async () => {
        // par blocks until the test explicitly releases it.
        await new Promise<void>((r) => {
          releasePar = r;
        });
        return {};
      });

      bus.register(toolSeq);
      bus.register(toolPar);

      // Start but don't await — let microtasks run manually.
      const dispatchPromise = bus.dispatchAll(
        [makeCall('seq', { value: 'x' }, '1'), makeCall('par', { value: 'y' }, '2')],
        ctx,
      );

      // One microtask turn: seq's chained dispatch should have started.
      await Promise.resolve();

      // seq must have started even though par is still blocked.
      expect(seqStarted).toHaveLength(1);

      // Unblock par so dispatchAll can settle.
      releasePar();
      await dispatchPromise;
    });

    it('propagates non-ToolError exceptions thrown inside any call', async () => {
      bus.register(makeTool('ok', async () => ({ ok: true })));
      bus.register(
        makeTool('crash', async () => {
          throw new TypeError('unexpected boom');
        }),
      );

      await expect(
        bus.dispatchAll(
          [makeCall('ok', { value: 'x' }, '1'), makeCall('crash', { value: 'y' }, '2')],
          ctx,
        ),
      ).rejects.toThrow('unexpected boom');
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

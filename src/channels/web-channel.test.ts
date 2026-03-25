import { describe, it, expect, vi } from 'vitest';
import { type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { WebChannel, type ServerMessage } from './web-channel';
import type { UserReviewRequest } from './channel';

// Mock fs/promises so tests don't touch the real filesystem
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('<html><body>bolt</body></html>'),
  stat: vi.fn().mockResolvedValue({ isFile: () => true }),
}));

// Mock fs (sync) for createReadStream
vi.mock('node:fs', () => ({
  createReadStream: vi.fn().mockReturnValue({
    pipe: vi.fn((res: { write: (d: string) => void; end: () => void }) => {
      res.write('media-bytes');
      res.end();
    }),
  }),
}));

// Import the mocks so individual tests can override them
import { readFile, stat } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// WebSocket stub
// ---------------------------------------------------------------------------

class FakeWs extends EventEmitter {
  sent: string[] = [];
  readyState = 1; // OPEN

  send(data: string): void {
    this.sent.push(data);
  }

  lastSent(): ServerMessage {
    const last = this.sent[this.sent.length - 1];
    if (last === undefined) throw new Error('no messages sent');
    return JSON.parse(last) as ServerMessage;
  }

  simulateMessage(msg: object): void {
    this.emit('message', JSON.stringify(msg));
  }

  simulateClose(): void {
    this.emit('close');
  }
}

// ---------------------------------------------------------------------------
// HTTP server stub that exposes simulateUpgrade / simulateRequest helpers
// ---------------------------------------------------------------------------

class FakeServer extends EventEmitter {
  listening = false;
  lastListenArgs: { port: number; host: string } | null = null;

  listen(port: number, host: string, cb: () => void): this {
    this.lastListenArgs = { port, host };
    this.listening = true;
    cb();
    return this;
  }

  close(cb: () => void): this {
    this.listening = false;
    cb();
    return this;
  }

  simulateUpgrade(authHeader: string, _ws: FakeWs): void {
    // Patch the WebSocketServer to hand back our fake WS.
    // We emit 'upgrade' on the server — WebChannel listens for this.
    const req = Object.assign(new EventEmitter(), {
      headers: { authorization: authHeader },
      url: '/',
    }) as unknown as IncomingMessage;
    const socket = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      destroy: vi.fn(),
    });
    this.emit('upgrade', req, socket, Buffer.alloc(0));
    // The real WebChannel calls wss.handleUpgrade; we skip that and call
    // onConnection directly via the helper below.
    return;
  }

  simulateRequest(
    method: string,
    path: string,
    body: unknown,
    authHeader: string
  ): { res: FakeResponse } {
    const req = Object.assign(new EventEmitter(), {
      method,
      url: path,
      headers: { authorization: authHeader },
    }) as unknown as IncomingMessage;

    const res = new FakeResponse();
    this.emit('request', req, res as unknown as ServerResponse);

    // Emit the body after a tick so the 'data'/'end' listeners are attached.
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });

    return { res };
  }
}

class FakeResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';

  writeHead(code: number, headers?: Record<string, string>): this {
    this.statusCode = code;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }

  write(data: string): boolean {
    this.body += data;
    return true;
  }

  end(data?: string): this {
    if (data) this.body += data;
    this.emit('finish');
    return this;
  }
}

// ---------------------------------------------------------------------------
// Helper: build a WebChannel with a FakeServer and expose onConnection
// ---------------------------------------------------------------------------

function makeChannel(
  opts: {
    token?: string;
    mode?: 'http' | 'websocket';
    enabled?: boolean;
    workspaceRoot?: string;
    persistent?: boolean;
  } = {}
): {
  channel: WebChannel & { _onConnection: (ws: FakeWs) => void };
  server: FakeServer;
} {
  const server = new FakeServer();
  const channel = new WebChannel(
    {
      port: 3000,
      token: opts.token,
      mode: opts.mode ?? 'websocket',
      enabled: opts.enabled,
      workspaceRoot: opts.workspaceRoot,
      persistent: opts.persistent,
    },
    server as unknown as Server
  ) as WebChannel & { _onConnection: (ws: FakeWs) => void };

  // Expose the private onConnection so tests can simulate WS connections
  // without going through the real WebSocketServer upgrade path.
  channel['_onConnection'] = (ws: FakeWs) =>
    (channel as unknown as { onConnection: (ws: FakeWs) => void }).onConnection(ws);

  return { channel, server };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebChannel', () => {
  describe('WebSocket mode — connection roles', () => {
    it('marks the first connection as active', () => {
      const { channel } = makeChannel();
      const ws = new FakeWs();
      channel['_onConnection'](ws);
      expect(ws.lastSent()).toMatchObject({ type: 'status', readOnly: false });
    });

    it('marks the second connection as read-only', () => {
      const { channel } = makeChannel();
      const ws1 = new FakeWs();
      const ws2 = new FakeWs();
      channel['_onConnection'](ws1);
      channel['_onConnection'](ws2);
      expect(ws2.lastSent()).toMatchObject({ type: 'status', readOnly: true });
    });

    it('promotes the oldest read-only when active disconnects', () => {
      const { channel } = makeChannel();
      const ws1 = new FakeWs();
      const ws2 = new FakeWs();
      const ws3 = new FakeWs();
      channel['_onConnection'](ws1);
      channel['_onConnection'](ws2);
      channel['_onConnection'](ws3);

      ws1.simulateClose();

      // ws2 is oldest read-only → should be promoted
      const lastMsg = ws2.lastSent();
      expect(lastMsg).toMatchObject({ type: 'status', readOnly: false });
      // ws3 stays read-only (no additional status message)
    });

    it('rejects messages from read-only connections', () => {
      const { channel } = makeChannel();
      const ws1 = new FakeWs();
      const ws2 = new FakeWs();
      channel['_onConnection'](ws1);
      channel['_onConnection'](ws2);

      ws2.simulateMessage({ type: 'message', content: 'hello' });

      expect(ws2.lastSent()).toMatchObject({ type: 'error', content: 'read-only' });
    });
  });

  describe('WebSocket mode — messaging', () => {
    it('enqueues turns from the active connection', async () => {
      const { channel } = makeChannel();
      const ws = new FakeWs();
      channel['_onConnection'](ws);

      const iter = channel.receive()[Symbol.asyncIterator]();

      ws.simulateMessage({ type: 'message', content: 'hello world' });

      const { value } = await iter.next();
      expect(value).toEqual({ content: 'hello world' });
    });

    it('broadcasts send() to all connections', async () => {
      const { channel } = makeChannel();
      const ws1 = new FakeWs();
      const ws2 = new FakeWs();
      channel['_onConnection'](ws1);
      channel['_onConnection'](ws2);

      await channel.send('great response');

      const msg1 = ws1.lastSent();
      const msg2 = ws2.lastSent();
      expect(msg1).toMatchObject({ type: 'response', content: 'great response' });
      expect(msg2).toMatchObject({ type: 'response', content: 'great response' });
    });

    it('ignores malformed JSON messages silently', async () => {
      const { channel } = makeChannel();
      const ws = new FakeWs();
      channel['_onConnection'](ws);

      // Emit raw bad JSON — should not throw
      ws.emit('message', 'not-json');

      // One status message sent, no error
      expect(ws.sent).toHaveLength(1);
    });
  });

  describe('WebSocket mode — review flow', () => {
    it('broadcasts review request and resolves when client replies', async () => {
      const { channel } = makeChannel();
      const ws = new FakeWs();
      channel['_onConnection'](ws);

      const request: UserReviewRequest = {
        content: 'My draft post',
        contentType: 'text',
        question: 'Does this look good?',
      };

      const reviewPromise = channel.requestReview(request);

      // The last sent message should be the review broadcast
      const reviewMsg = ws.lastSent();
      expect(reviewMsg.type).toBe('review');
      expect(reviewMsg.reviewId).toBeDefined();
      expect(reviewMsg.reviewRequest).toMatchObject({ content: 'My draft post' });

      // Active connection replies
      ws.simulateMessage({
        type: 'review_reply',
        reviewId: reviewMsg.reviewId,
        approved: true,
      });

      const response = await reviewPromise;
      expect(response).toEqual({ approved: true });
    });

    it('passes feedback in review reply', async () => {
      const { channel } = makeChannel();
      const ws = new FakeWs();
      channel['_onConnection'](ws);

      const reviewPromise = channel.requestReview({
        content: 'Draft',
        contentType: 'text',
        question: 'OK?',
      });

      const reviewMsg = ws.lastSent();
      ws.simulateMessage({
        type: 'review_reply',
        reviewId: reviewMsg.reviewId,
        approved: false,
        feedback: 'needs more detail',
      });

      const response = await reviewPromise;
      expect(response).toEqual({ approved: false, feedback: 'needs more detail' });
    });
  });

  describe('HTTP mode — GET / (static frontend)', () => {
    it('returns 200 with the HTML file content', async () => {
      const { server } = makeChannel({ mode: 'http' });
      const { res } = server.simulateRequest('GET', '/', {}, '');
      await new Promise((r) => setTimeout(r, 10));
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toContain('text/html');
      expect(res.body).toContain('bolt');
    });

    it('returns 404 when the HTML file cannot be read', async () => {
      vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const { server } = makeChannel({ mode: 'http' });
      const { res } = server.simulateRequest('GET', '/', {}, '');
      await new Promise((r) => setTimeout(r, 10));
      expect(res.statusCode).toBe(404);
    });
  });

  describe('HTTP mode — POST /chat', () => {
    it('accepts a valid message and enqueues a turn', async () => {
      const { channel, server } = makeChannel({ mode: 'http' });
      const iter = channel.receive()[Symbol.asyncIterator]();

      const { res } = server.simulateRequest(
        'POST',
        '/chat',
        { type: 'message', content: 'hi from http' },
        ''
      );

      await new Promise((r) => process.nextTick(r));

      const { value } = await iter.next();
      expect(value).toEqual({ content: 'hi from http' });
      expect(res.statusCode).toBe(202);
    });

    it('returns 400 for invalid JSON body', async () => {
      const { channel } = makeChannel({ mode: 'http' });

      const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        url: '/chat',
        headers: { authorization: '' },
      }) as unknown as IncomingMessage;

      const res = new FakeResponse();
      channel['httpServer'].emit('request', req, res as unknown as ServerResponse);

      req.emit('data', Buffer.from('not-json'));
      req.emit('end');

      await new Promise((r) => process.nextTick(r));
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for unknown paths', async () => {
      const { server } = makeChannel({ mode: 'http' });
      const { res } = server.simulateRequest('GET', '/unknown', {}, '');
      await new Promise((r) => process.nextTick(r));
      expect(res.statusCode).toBe(404);
    });
  });

  describe('Authentication', () => {
    it('rejects HTTP requests without a valid token', async () => {
      const { server } = makeChannel({ token: 'secret' });
      const { res } = server.simulateRequest('POST', '/chat', {}, 'Bearer wrong');
      await new Promise((r) => process.nextTick(r));
      expect(res.statusCode).toBe(401);
    });

    it('accepts HTTP requests with a valid token', async () => {
      const { channel, server } = makeChannel({ token: 'secret', mode: 'http' });
      const iter = channel.receive()[Symbol.asyncIterator]();

      const { res } = server.simulateRequest(
        'POST',
        '/chat',
        { type: 'message', content: 'authorized' },
        'Bearer secret'
      );

      await new Promise((r) => process.nextTick(r));
      const { value } = await iter.next();
      expect(value).toEqual({ content: 'authorized' });
      expect(res.statusCode).toBe(202);
    });

    it('allows all requests when no token is configured', async () => {
      const { channel, server } = makeChannel({ mode: 'http' });
      const iter = channel.receive()[Symbol.asyncIterator]();

      const { res } = server.simulateRequest(
        'POST',
        '/chat',
        { type: 'message', content: 'open' },
        ''
      );

      await new Promise((r) => process.nextTick(r));
      await iter.next();
      expect(res.statusCode).toBe(202);
    });
  });

  describe('SSE — GET /events', () => {
    it('sets correct SSE headers and sends an initial comment', () => {
      const { server } = makeChannel({ mode: 'http' });
      const { res } = server.simulateRequest('GET', '/events', {}, '');

      expect(res.headers['Content-Type']).toBe('text/event-stream');
      expect(res.body).toContain(':\n\n');
    });

    it('broadcasts send() to SSE streams', async () => {
      const { channel, server } = makeChannel({ mode: 'http' });

      const req = Object.assign(new EventEmitter(), {
        method: 'GET',
        url: '/events',
        headers: {},
      }) as unknown as IncomingMessage;
      const res = new FakeResponse();
      server.emit('request', req, res as unknown as ServerResponse);

      await channel.send('hello sse');

      expect(res.body).toContain('"type":"response"');
      expect(res.body).toContain('"content":"hello sse"');
    });
  });

  describe('WebSocket mode — promoted connection can send messages', () => {
    it('allows the promoted connection to send messages after active disconnects', async () => {
      const { channel } = makeChannel();
      const ws1 = new FakeWs();
      const ws2 = new FakeWs();
      channel['_onConnection'](ws1);
      channel['_onConnection'](ws2);

      // ws1 disconnects → ws2 is promoted to active
      ws1.simulateClose();

      const iter = channel.receive()[Symbol.asyncIterator]();
      ws2.simulateMessage({ type: 'message', content: 'from promoted' });

      const { value } = await iter.next();
      expect(value).toEqual({ content: 'from promoted' });
    });
  });

  describe('WebSocket upgrade — token auth via ?token= query param', () => {
    it('rejects upgrade when token in query param does not match', () => {
      const { channel } = makeChannel({ token: 'secret' });
      const socket = { write: vi.fn(), destroy: vi.fn(), on: vi.fn() };
      const req = Object.assign(new EventEmitter(), {
        headers: {},
        url: '/?token=wrong',
      }) as unknown as IncomingMessage;
      channel['httpServer'].emit('upgrade', req, socket, Buffer.alloc(0));
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('allows upgrade when ?token= matches', () => {
      const { channel } = makeChannel({ token: 'secret' });
      const socket = { write: vi.fn(), destroy: vi.fn(), on: vi.fn() };
      const req = Object.assign(new EventEmitter(), {
        headers: {},
        url: '/?token=secret',
      }) as unknown as IncomingMessage;
      // wss.handleUpgrade will throw since this is a fake socket, but
      // destroy() should NOT have been called (auth passed).
      try {
        channel['httpServer'].emit('upgrade', req, socket, Buffer.alloc(0));
      } catch {
        // expected — fake socket
      }
      expect(socket.destroy).not.toHaveBeenCalled();
    });
  });

  describe('Lifecycle — persistent mode', () => {
    it('does NOT close receive() when all connections drop in persistent mode', async () => {
      const { channel } = makeChannel({ persistent: true });
      const ws = new FakeWs();
      channel['_onConnection'](ws);

      const turns: string[] = [];
      let completed = false;
      const done = (async () => {
        for await (const turn of channel.receive()) {
          turns.push(turn.content);
        }
        completed = true;
      })();

      // Enqueue a turn then close the only connection
      ws.simulateMessage({ type: 'message', content: 'hello' });
      ws.simulateClose();

      // Give the loop a chance to process
      await new Promise((r) => setTimeout(r, 10));

      // receive() must still be running — not completed
      expect(completed).toBe(false);
      expect(turns).toEqual(['hello']);

      // Cleanup: stop() should terminate it
      await channel.stop();
      await done;
      expect(completed).toBe(true);
    });

    it('closes receive() normally when all connections drop in non-persistent mode', async () => {
      const { channel } = makeChannel({ persistent: false });
      const ws = new FakeWs();
      channel['_onConnection'](ws);

      let completed = false;
      const done = (async () => {
        for await (const _turn of channel.receive()) { /* consume */ }
        completed = true;
      })();

      ws.simulateClose();
      await done;
      expect(completed).toBe(true);
    });

    it('stop() terminates receive() even in persistent mode', async () => {
      const { channel } = makeChannel({ persistent: true });

      let completed = false;
      const done = (async () => {
        for await (const _turn of channel.receive()) { /* consume */ }
        completed = true;
      })();

      await channel.stop();
      await done;
      expect(completed).toBe(true);
    });
  });

  describe('Lifecycle — enabled flag', () => {
    it('listen() rejects when enabled is false', async () => {
      const { channel } = makeChannel({ enabled: false } as Parameters<typeof makeChannel>[0]);
      await expect(channel.listen()).rejects.toThrow('disabled');
    });
  });

  describe('Lifecycle — stop()', () => {
    it('stop() terminates receive() iteration', async () => {
      const { channel } = makeChannel();
      const turns: string[] = [];

      const done = (async () => {
        for await (const turn of channel.receive()) {
          turns.push(turn.content);
        }
      })();

      await channel.stop();
      await done;
      expect(turns).toHaveLength(0);
    });

    it('stop() rejects pending reviews', async () => {
      const { channel } = makeChannel();
      const ws = new FakeWs();
      channel['_onConnection'](ws);

      const reviewPromise = channel.requestReview({
        content: 'c',
        contentType: 'text',
        question: 'q?',
      });

      await channel.stop();
      await expect(reviewPromise).rejects.toThrow('WebChannel stopped');
    });
  });

  describe('sendMedia()', () => {
    it('broadcasts a media message with mediaUrl and caption', async () => {
      const { channel } = makeChannel({ workspaceRoot: '/workspace' });
      const ws = new FakeWs();
      channel['_onConnection'](ws);

      await channel.sendMedia('images/photo.png', 'A photo');

      const msg = ws.lastSent();
      expect(msg.type).toBe('media');
      expect(msg.mediaUrl).toContain('photo.png');
      expect(msg.caption).toBe('A photo');
    });

    it('broadcasts a media message without a caption', async () => {
      const { channel } = makeChannel({ workspaceRoot: '/workspace' });
      const ws = new FakeWs();
      channel['_onConnection'](ws);

      await channel.sendMedia('video.mp4');

      const msg = ws.lastSent();
      expect(msg.type).toBe('media');
      expect(msg.caption).toBeUndefined();
    });
  });

  describe('sendProgress()', () => {
    it('broadcasts a progress message to connected clients', () => {
      const { channel } = makeChannel();
      const ws = new FakeWs();
      channel['_onConnection'](ws);

      channel.sendProgress('⟳ Thinking…');

      const msg = ws.lastSent();
      expect(msg.type).toBe('progress');
      expect(msg.content).toBe('⟳ Thinking…');
    });
  });

  describe('listen()', () => {
    it('binds to 127.0.0.1 by default', async () => {
      const { channel, server } = makeChannel();
      await channel.listen();
      expect(server.lastListenArgs).toEqual({ port: 3000, host: '127.0.0.1' });
    });

    it('binds to the provided host', async () => {
      const server = new FakeServer();
      const channel = new WebChannel(
        { port: 3000, host: '0.0.0.0', mode: 'websocket' },
        server as unknown as Server
      );
      await channel.listen();
      expect(server.lastListenArgs).toEqual({ port: 3000, host: '0.0.0.0' });
    });

    it('rejects with a clear message when EADDRINUSE', async () => {
      const server = new FakeServer();
      // Override listen to emit EADDRINUSE instead of calling the callback
      server.listen = function (_port: number, _host: string, _cb: () => void): typeof server {
        process.nextTick(() => {
          server.emit('error', Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' }));
        });
        return server;
      };
      const channel = new WebChannel(
        { port: 3000, mode: 'websocket' },
        server as unknown as Server
      );
      await expect(channel.listen()).rejects.toThrow('Port 3000 is already in use');
    });

    it('rejects with the original error for non-EADDRINUSE errors', async () => {
      const server = new FakeServer();
      server.listen = function (_port: number, _host: string, _cb: () => void): typeof server {
        process.nextTick(() => {
          server.emit('error', Object.assign(new Error('EACCES'), { code: 'EACCES' }));
        });
        return server;
      };
      const channel = new WebChannel(
        { port: 3000, mode: 'websocket' },
        server as unknown as Server
      );
      await expect(channel.listen()).rejects.toThrow('EACCES');
    });
  });

  describe('HTTP mode — GET /media/:path', () => {
    it('returns 404 when workspaceRoot is not configured', async () => {
      const { server } = makeChannel({ mode: 'http' });
      const { res } = server.simulateRequest('GET', '/media/photo.png', {}, '');
      await new Promise((r) => setTimeout(r, 10));
      expect(res.statusCode).toBe(404);
    });

    it('serves a file within the workspace root', async () => {
      const { server } = makeChannel({ mode: 'http', workspaceRoot: '/workspace' });
      const { res } = server.simulateRequest('GET', '/media/photo.png', {}, '');
      await new Promise((r) => setTimeout(r, 10));
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toContain('image/png');
      expect(res.body).toContain('media-bytes');
    });

    it('returns 403 for path traversal attempts', async () => {
      const { server } = makeChannel({ mode: 'http', workspaceRoot: '/workspace' });
      const { res } = server.simulateRequest('GET', '/media/..%2F..%2Fetc%2Fpasswd', {}, '');
      await new Promise((r) => setTimeout(r, 10));
      expect(res.statusCode).toBe(403);
    });

    it('returns 404 when stat() rejects (file not found)', async () => {
      vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const { server } = makeChannel({ mode: 'http', workspaceRoot: '/workspace' });
      const { res } = server.simulateRequest('GET', '/media/missing.png', {}, '');
      await new Promise((r) => setTimeout(r, 10));
      expect(res.statusCode).toBe(404);
    });
  });
});

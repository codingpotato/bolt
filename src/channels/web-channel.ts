import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Channel, UserTurn, UserReviewRequest, UserReviewResponse } from './channel';

const INDEX_HTML_PATH = path.join(__dirname, '../../public', 'index.html');

/** Shape of messages sent from client → server over WebSocket or HTTP. */
interface ClientMessage {
  type: 'message';
  content: string;
}

/** Shape of messages sent from server → client. */
export interface ServerMessage {
  type: 'response' | 'review' | 'error' | 'status';
  content?: string;
  reviewId?: string;
  reviewRequest?: UserReviewRequest;
  readOnly?: boolean;
}

/** Shape of the client's reply to a review request. */
interface ReviewReply {
  type: 'review_reply';
  reviewId: string;
  approved: boolean;
  feedback?: string;
}

function isClientMessage(msg: unknown): msg is ClientMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as ClientMessage).type === 'message' &&
    typeof (msg as ClientMessage).content === 'string'
  );
}

function isReviewReply(msg: unknown): msg is ReviewReply {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as ReviewReply).type === 'review_reply' &&
    typeof (msg as ReviewReply).reviewId === 'string' &&
    typeof (msg as ReviewReply).approved === 'boolean'
  );
}

interface PendingReview {
  resolve: (response: UserReviewResponse) => void;
  reject: (err: Error) => void;
}

export interface WebChannelOptions {
  port: number;
  token?: string;
  mode: 'http' | 'websocket';
  enabled?: boolean;
}

/**
 * Channel implementation for web-based interaction.
 *
 * WebSocket mode:
 *   - Persistent bidirectional connection
 *   - First connection is "active" (read-write), subsequent are "read-only"
 *   - Read-only connections receive all messages but cannot send turns
 *   - When active disconnects, oldest read-only is promoted
 *
 * HTTP mode:
 *   - POST /chat sends a user turn; response delivered via SSE stream
 */
export class WebChannel implements Channel {
  private readonly opts: WebChannelOptions;
  private readonly httpServer: Server;
  private readonly wss: WebSocketServer;

  /** Active (read-write) WebSocket connection. */
  private activeWs: WebSocket | null = null;
  /** Read-only connections in order of arrival. */
  private readOnlyWs: WebSocket[] = [];

  /** Queued user turns waiting to be consumed by receive(). */
  private turnQueue: UserTurn[] = [];
  /** Resolvers waiting for the next turn. */
  private turnWaiters: Array<(turn: UserTurn) => void> = [];
  /** Set to true when the server is stopped. */
  private closed = false;
  /** Resolvers waiting for channel close. */
  private closeWaiters: Array<() => void> = [];

  /** Pending review requests keyed by reviewId. */
  private pendingReviews: Map<string, PendingReview> = new Map();
  private reviewCounter = 0;

  /** SSE response streams awaiting the next agent message (HTTP mode). */
  private sseStreams: ServerResponse[] = [];

  constructor(opts: WebChannelOptions, server?: Server) {
    this.opts = opts;
    this.httpServer = server ?? createServer();
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on('request', (req, res) => this.handleRequest(req, res));
    this.httpServer.on('upgrade', (req, socket, head) => {
      if (!this.authFromRequest(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.onConnection(ws);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Auth helpers
  // ---------------------------------------------------------------------------

  private authenticate(bearerOrToken: string): boolean {
    const { token } = this.opts;
    if (!token) return true; // no auth configured
    const cleaned = bearerOrToken.replace(/^Bearer\s+/i, '').split('?')[0];
    return cleaned === token;
  }

  private authFromRequest(req: IncomingMessage): boolean {
    const auth = req.headers['authorization'] ?? '';
    if (auth) return this.authenticate(auth);
    // Fall back to ?token= query param
    const url = new URL(req.url ?? '/', 'http://localhost');
    return this.authenticate(url.searchParams.get('token') ?? '');
  }

  // ---------------------------------------------------------------------------
  // WebSocket connection management
  // ---------------------------------------------------------------------------

  private onConnection(ws: WebSocket): void {
    if (this.activeWs !== null) {
      this.readOnlyWs.push(ws);
      const msg: ServerMessage = { type: 'status', readOnly: true, content: 'read-only' };
      ws.send(JSON.stringify(msg));
    } else {
      this.activeWs = ws;
      const msg: ServerMessage = { type: 'status', readOnly: false, content: 'active' };
      ws.send(JSON.stringify(msg));
    }

    ws.on('message', (data) => {
      if (ws !== this.activeWs) {
        // read-only connections cannot send turns
        ws.send(JSON.stringify({ type: 'error', content: 'read-only' } satisfies ServerMessage));
        return;
      }
      this.handleWsMessage(data.toString());
    });

    ws.on('close', () => {
      if (ws === this.activeWs) {
        this.activeWs = null;
        this.promoteNextReadOnly();
      } else {
        this.readOnlyWs = this.readOnlyWs.filter((c) => c !== ws);
      }

      if (this.activeWs === null && this.readOnlyWs.length === 0) {
        this.signalClose();
      }
    });
  }

  private promoteNextReadOnly(): void {
    if (this.readOnlyWs.length === 0) return;
    this.activeWs = this.readOnlyWs.shift()!;
    const msg: ServerMessage = { type: 'status', readOnly: false, content: 'active' };
    this.activeWs.send(JSON.stringify(msg));
  }

  private handleWsMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }

    if (isClientMessage(parsed)) {
      const turn: UserTurn = { content: parsed.content };
      this.enqueueTurn(turn);
    } else if (isReviewReply(parsed)) {
      const pending = this.pendingReviews.get(parsed.reviewId);
      if (pending) {
        this.pendingReviews.delete(parsed.reviewId);
        pending.resolve({ approved: parsed.approved, feedback: parsed.feedback });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP request handling
  // ---------------------------------------------------------------------------

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!this.authFromRequest(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      this.handleIndex(res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/chat') {
      this.handleHttpChat(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      this.handleSse(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  private handleIndex(res: ServerResponse): void {
    readFile(INDEX_HTML_PATH, 'utf-8')
      .then((html) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      })
      .catch(() => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
  }

  private handleHttpChat(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }

      if (!isClientMessage(parsed)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'expected { type: "message", content: string }' }));
        return;
      }

      this.enqueueTurn({ content: parsed.content });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  }

  private handleSse(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(':\n\n'); // SSE comment to keep the connection alive
    this.sseStreams.push(res);

    res.on('close', () => {
      this.sseStreams = this.sseStreams.filter((s) => s !== res);
    });
  }

  // ---------------------------------------------------------------------------
  // Broadcast helpers
  // ---------------------------------------------------------------------------

  private broadcastWs(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    if (this.activeWs) this.activeWs.send(data);
    for (const ro of this.readOnlyWs) ro.send(data);
  }

  private broadcastSse(msg: ServerMessage): void {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of this.sseStreams) res.write(data);
  }

  // ---------------------------------------------------------------------------
  // Turn queue
  // ---------------------------------------------------------------------------

  private enqueueTurn(turn: UserTurn): void {
    if (this.turnWaiters.length > 0) {
      const waiter = this.turnWaiters.shift()!;
      this.closeWaiters.shift(); // remove the paired close waiter to avoid a leak
      waiter(turn);
    } else {
      this.turnQueue.push(turn);
    }
  }

  private signalClose(): void {
    for (const resolve of this.closeWaiters) resolve();
    this.closeWaiters = [];
    this.closed = true;
  }

  // ---------------------------------------------------------------------------
  // Channel interface
  // ---------------------------------------------------------------------------

  async *receive(): AsyncIterable<UserTurn> {
    while (true) {
      if (this.turnQueue.length > 0) {
        yield this.turnQueue.shift()!;
        continue;
      }

      if (this.closed) return;

      const turn = await new Promise<UserTurn | null>((resolve) => {
        this.turnWaiters.push((t) => resolve(t));
        this.closeWaiters.push(() => resolve(null));
      });

      if (turn === null) return;
      yield turn;
    }
  }

  async send(response: string): Promise<void> {
    const msg: ServerMessage = { type: 'response', content: response };
    this.broadcastWs(msg);
    this.broadcastSse(msg);
  }

  async requestReview(request: UserReviewRequest): Promise<UserReviewResponse> {
    const reviewId = `review-${++this.reviewCounter}`;
    const msg: ServerMessage = { type: 'review', reviewId, reviewRequest: request };
    this.broadcastWs(msg);
    this.broadcastSse(msg);

    return new Promise<UserReviewResponse>((resolve, reject) => {
      this.pendingReviews.set(reviewId, { resolve, reject });
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Start listening. Throws if `enabled` is explicitly set to false. */
  listen(): Promise<void> {
    if (this.opts.enabled === false) {
      return Promise.reject(new Error('WebChannel is disabled (enabled: false)'));
    }
    return new Promise((resolve) => {
      this.httpServer.listen(this.opts.port, () => resolve());
    });
  }

  /** Stop the server and close all connections. */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close();
      this.httpServer.close(() => resolve());
      // Reject any pending reviews
      for (const [, pending] of this.pendingReviews) {
        pending.reject(new Error('WebChannel stopped'));
      }
      this.pendingReviews.clear();
      this.signalClose();
    });
  }
}

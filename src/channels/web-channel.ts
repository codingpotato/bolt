import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
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
  type: 'response' | 'review' | 'error' | 'status' | 'media' | 'progress' | 'user_message' | 'processing' | 'queue_status' | 'task_complete';
  content?: string;
  reviewId?: string;
  reviewRequest?: UserReviewRequest;
  /** Deprecated: kept for type compatibility; no longer sent in WS mode. */
  readOnly?: boolean;
  mediaUrl?: string;
  caption?: string;
  /** Author name for user_message / processing events. */
  author?: string;
  /** 1-indexed position in queue for user_message events. */
  queuePosition?: number;
  /** Author of the user turn Bolt is replying to, sent with response events. */
  replyTo?: string;
  /** Sent with status events on connect. */
  userId?: string;
  connectedUsers?: number;
  queueDepth?: number;
  /** Current queue depth for queue_status events. */
  depth?: number;
  /** Task title for task_complete events. */
  title?: string;
  /** Task completion status for task_complete events. */
  status?: 'completed' | 'failed';
  /** Task result for task_complete events. */
  result?: string;
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
  /** Network interface to bind to. Defaults to '127.0.0.1'. Use '0.0.0.0' to listen on all interfaces. */
  host?: string;
  token?: string;
  mode: 'http' | 'websocket';
  enabled?: boolean;
  /** Absolute path to the workspace root — used to serve media files safely. */
  workspaceRoot?: string;
  /**
   * When true, the channel does NOT signal close when all WebSocket connections
   * drop — the server keeps listening for new connections. Used by daemon mode.
   * stop() still terminates receive() unconditionally.
   */
  persistent?: boolean;
}

const MEDIA_CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

/**
 * Channel implementation for web-based interaction.
 *
 * WebSocket mode (multi-user shared conversation):
 *   - Any number of clients may connect simultaneously; all can send messages
 *   - Each client identifies itself via the ?name= query param
 *   - All user messages are broadcast to every connected client
 *   - Turns are queued (FIFO); Bolt processes one at a time
 *   - Progress, responses, and review requests are broadcast to all clients
 *
 * HTTP mode:
 *   - POST /chat sends a user turn; response delivered via SSE stream
 *   - Single-user; no broadcast semantics
 */
export class WebChannel implements Channel {
  private readonly opts: WebChannelOptions;
  private readonly httpServer: Server;
  private readonly wss: WebSocketServer;

  /** All connected WebSocket clients, keyed by socket, value is the user's display name. */
  private connections: Map<WebSocket, { userId: string }> = new Map();
  /** Counter for auto-assigning names when ?name= is absent. */
  private userCounter = 0;
  /** The turn currently being processed by the agent (set when dequeued, cleared after send). */
  private currentlyProcessing: UserTurn | null = null;

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
      const url = new URL(req.url ?? '/', 'http://localhost');
      const requestedName = url.searchParams.get('name') ?? undefined;
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.onConnection(ws, requestedName);
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

  private onConnection(ws: WebSocket, requestedName?: string): void {
    const userId = requestedName ?? `User${++this.userCounter}`;
    this.connections.set(ws, { userId });

    const statusMsg: ServerMessage = {
      type: 'status',
      readOnly: false,
      userId,
      connectedUsers: this.connections.size,
      queueDepth: this.turnQueue.length,
    };
    ws.send(JSON.stringify(statusMsg));

    ws.on('message', (data) => {
      this.handleWsMessage(data.toString(), ws);
    });

    ws.on('close', () => {
      this.connections.delete(ws);
      if (this.connections.size === 0 && !this.opts.persistent) {
        this.signalClose();
      }
    });
  }

  private handleWsMessage(raw: string, ws: WebSocket): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }

    const info = this.connections.get(ws);
    if (!info) return;

    if (isClientMessage(parsed)) {
      const turn: UserTurn = { content: parsed.content, author: info.userId };
      const queuePosition = this.turnQueue.length + 1;
      const userMsg: ServerMessage = {
        type: 'user_message',
        author: info.userId,
        content: parsed.content,
        queuePosition,
      };
      this.broadcastWs(userMsg);
      this.broadcastSse(userMsg);
      this.enqueueTurn(turn);
      const queueStatus: ServerMessage = { type: 'queue_status', depth: this.turnQueue.length };
      this.broadcastWs(queueStatus);
      this.broadcastSse(queueStatus);
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

    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      this.handleMedia(url.pathname, res);
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

  private handleMedia(pathname: string, res: ServerResponse): void {
    const root = this.opts.workspaceRoot;
    if (!root) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'media serving not configured' }));
      return;
    }

    // Strip leading /media/ prefix to get the relative path
    const relative = decodeURIComponent(pathname.slice('/media/'.length));
    const resolved = path.resolve(root, relative);

    // Workspace confinement: resolved path must stay within root
    if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const contentType = MEDIA_CONTENT_TYPES[ext] ?? 'application/octet-stream';

    stat(resolved)
      .then(() => {
        res.writeHead(200, { 'Content-Type': contentType });
        createReadStream(resolved).pipe(res);
      })
      .catch(() => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
  }

  // ---------------------------------------------------------------------------
  // Broadcast helpers
  // ---------------------------------------------------------------------------

  private broadcastWs(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.connections.keys()) {
      ws.send(data);
    }
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
        const turn = this.turnQueue.shift()!;
        // Broadcast updated queue depth now that we've consumed one turn.
        const depthMsg: ServerMessage = { type: 'queue_status', depth: this.turnQueue.length };
        this.broadcastWs(depthMsg);
        this.broadcastSse(depthMsg);
        this.currentlyProcessing = turn;
        this.broadcastProcessingEvent(turn);
        yield turn;
        continue;
      }

      if (this.closed) return;

      const turn = await new Promise<UserTurn | null>((resolve) => {
        this.turnWaiters.push((t) => resolve(t));
        this.closeWaiters.push(() => resolve(null));
      });

      if (turn === null) return;
      this.currentlyProcessing = turn;
      this.broadcastProcessingEvent(turn);
      yield turn;
    }
  }

  private broadcastProcessingEvent(turn: UserTurn): void {
    if (!turn.author) return;
    const msg: ServerMessage = { type: 'processing', author: turn.author, content: turn.content };
    this.broadcastWs(msg);
    this.broadcastSse(msg);
  }

  async send(response: string): Promise<void> {
    const replyTo = this.currentlyProcessing?.author;
    this.currentlyProcessing = null;
    const msg: ServerMessage = {
      type: 'response',
      content: response,
      ...(replyTo !== undefined ? { replyTo } : {}),
    };
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

  async notifyTaskCompletion(
    _taskId: string,
    title: string,
    status: 'completed' | 'failed',
    result?: string,
    _error?: string,
  ): Promise<void> {
    const msg: ServerMessage = {
      type: 'task_complete',
      title,
      status,
      ...(result !== undefined ? { result } : {}),
    };
    this.broadcastWs(msg);
    this.broadcastSse(msg);
  }

  sendProgress(text: string): void {
    const msg: ServerMessage = { type: 'progress', content: text };
    this.broadcastWs(msg);
    this.broadcastSse(msg);
  }

  async sendMedia(filePath: string, caption?: string): Promise<void> {
    const root = this.opts.workspaceRoot ?? '';
    const relative = root ? path.relative(root, path.resolve(root, filePath)) : filePath;
    const mediaUrl = `/media/${relative.split('/').map(encodeURIComponent).join('/')}`;
    const msg: ServerMessage = { type: 'media', mediaUrl, caption };
    this.broadcastWs(msg);
    this.broadcastSse(msg);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Start listening. Throws if `enabled` is explicitly set to false or if the port is already in use. */
  listen(): Promise<void> {
    if (this.opts.enabled === false) {
      return Promise.reject(new Error('WebChannel is disabled (enabled: false)'));
    }
    const host = this.opts.host ?? '127.0.0.1';
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.opts.port} is already in use`));
        } else {
          reject(err);
        }
      };
      this.httpServer.once('error', onError);
      this.httpServer.listen(this.opts.port, host, () => {
        this.httpServer.removeListener('error', onError);
        resolve();
      });
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

export type ContentType =
  | 'script'
  | 'storyboard'
  | 'image_prompt'
  | 'video_prompt'
  | 'image'
  | 'video'
  | 'text';

export interface UserReviewRequest {
  content: string;
  contentType: ContentType;
  question: string;
  mediaFiles?: string[];
}

export interface UserReviewResponse {
  approved: boolean;
  feedback?: string;
}

/** A single inbound message from a user. */
export interface UserTurn {
  /** The message content from the user. */
  content: string;
  /**
   * Display name of the sender.
   * Set by WebChannel from the ?name= query param; auto-assigned as User1/User2/…
   * when omitted. Not set by CliChannel (single-user).
   * AgentCore prefixes the LLM message with [author]: when this is present.
   */
  author?: string;
  /**
   * Transport-specific metadata — not passed to the model.
   * Examples: { userId, channelId } for Discord; absent for CLI.
   */
  metadata?: Record<string, string>;
}

/** Abstraction for all inbound/outbound communication with the agent. */
export interface Channel {
  /** Yields inbound user turns; completes when the channel closes. */
  receive(): AsyncIterable<UserTurn>;
  /** Sends the agent's final response back to the user. */
  send(response: string): Promise<void>;
  /**
   * Present content for interactive user review.
   * Optional — only channels with rich UI support need to implement this.
   * The user_review tool falls back to ctx.confirm when this is absent.
   */
  requestReview?(request: UserReviewRequest): Promise<UserReviewResponse>;
  /**
   * Send a media file (image or video) to the user with an optional caption.
   * Optional — channels without media support may omit this.
   */
  sendMedia?(filePath: string, caption?: string): Promise<void>;
}

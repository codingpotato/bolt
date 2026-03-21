/** A single inbound message from a user. */
export interface UserTurn {
  /** The message content from the user. */
  content: string;
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
}

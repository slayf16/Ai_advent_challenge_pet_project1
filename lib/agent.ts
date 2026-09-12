import type { IncomingMessage, ResponseSettings } from './chat-request';
import {
  httpChatTransport,
  type ChatTransport,
  type StreamChatOptions,
  type StreamChatResult,
} from './chat-stream';

export type AgentProfile = {
  id: string;
  name: string;
  settings: ResponseSettings;
};

/**
 * A configured LLM participant.  The browser only gives it a transport to the
 * internal API route; provider credentials never become part of an Agent.
 */
export class Agent {
  readonly id: string;
  readonly name: string;
  readonly settings: ResponseSettings;
  private readonly transport: ChatTransport;

  constructor(profile: AgentProfile, transport: ChatTransport = httpChatTransport) {
    this.id = profile.id;
    this.name = profile.name;
    this.settings = { ...profile.settings };
    this.transport = transport;
  }

  request(
    messages: IncomingMessage[],
    options: StreamChatOptions = {},
  ): Promise<StreamChatResult> {
    return this.transport.request(messages, this.settings, options);
  }

  withSettings(settings: ResponseSettings): Agent {
    return new Agent({ id: this.id, name: this.name, settings }, this.transport);
  }

  toProfile(): AgentProfile {
    return { id: this.id, name: this.name, settings: { ...this.settings } };
  }
}

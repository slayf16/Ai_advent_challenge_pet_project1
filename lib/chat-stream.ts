import type { IncomingMessage, ResponseSettings } from './chat-request';

export type TokenUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
};

type StreamOptions = {
  signal?: AbortSignal;
  onRequest?: (requestJson: string) => void;
  onDelta?: (content: string) => void;
  onUsage?: (usage: TokenUsage) => void;
};

function takeFrames(buffer: string) {
  const result: string[] = [];
  let boundary = buffer.search(/\r\n\r\n|\n\n|\r\r/);
  while (boundary !== -1) {
    const separator =
      buffer.slice(boundary).match(/^(?:\r\n\r\n|\n\n|\r\r)/)?.[0] ?? '\n\n';
    result.push(buffer.slice(0, boundary));
    buffer = buffer.slice(boundary + separator.length);
    boundary = buffer.search(/\r\n\r\n|\n\n|\r\r/);
  }
  return { result, buffer };
}

function parseFrame(frame: string) {
  let eventName = 'message';
  const data: string[] = [];
  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') eventName = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  let value: unknown;
  try {
    value = JSON.parse(data.join('\n'));
  } catch {
    throw new Error('Сервер вернул повреждённое потоковое событие.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Сервер вернул повреждённое потоковое событие.');
  return { eventName, value: value as Record<string, unknown> };
}

export async function streamChat(
  messages: IncomingMessage[],
  settings: ResponseSettings,
  options: StreamOptions,
): Promise<{
  message: string;
  finishReason: string | null;
  usage: TokenUsage | null;
  model: string;
}> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, settings }),
    signal: options.signal,
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !contentType.includes('text/event-stream')) {
    let error = `Сервер вернул ошибку ${response.status}.`;
    try {
      const payload = (await response.json()) as {
        error?: unknown;
        requestJson?: unknown;
      };
      if (typeof payload.requestJson === 'string')
        options.onRequest?.(payload.requestJson);
      if (typeof payload.error === 'string') error = payload.error;
    } catch {
      /* Keep the status-based message for a non-JSON body. */
    }
    throw new Error(error);
  }
  if (!response.body) throw new Error('Сервер вернул пустой поток.');

  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '',
    message = '',
    finishReason: string | null = null;
  let usage: TokenUsage | null = null,
    model = '',
    doneSeen = false;
  const consume = (frame: string) => {
    const parsed = parseFrame(frame);
    if (!parsed) return;
    if (doneSeen) throw new Error('Сервер отправил данные после события done.');
    const { eventName, value } = parsed;
    if (eventName === 'request') {
      if (typeof value.requestJson !== 'string')
        throw new Error('Событие request имеет неверный формат.');
      options.onRequest?.(value.requestJson);
    } else if (eventName === 'delta') {
      if (typeof value.content !== 'string')
        throw new Error('Событие delta имеет неверный формат.');
      message += value.content;
      options.onDelta?.(value.content);
    } else if (eventName === 'done') {
      if (
        (value.finishReason !== null &&
          typeof value.finishReason !== 'string') ||
        (value.usage !== null &&
          (typeof value.usage !== 'object' || Array.isArray(value.usage))) ||
        typeof value.model !== 'string'
      )
        throw new Error('Событие done имеет неверный формат.');
      doneSeen = true;
      finishReason = value.finishReason as string | null;
      usage = value.usage as TokenUsage | null;
      model = value.model;
      if (usage) options.onUsage?.(usage);
    } else if (eventName === 'error') {
      if (typeof value.error !== 'string')
        throw new Error('Событие error имеет неверный формат.');
      throw new Error(value.error);
    } else throw new Error(`Неизвестное потоковое событие: ${eventName}.`);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const parsed = takeFrames(buffer);
      buffer = parsed.buffer;
      for (const frame of parsed.result) consume(frame);
      if (done) break;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (buffer.trim()) throw new Error('Поток завершился посреди события.');
  if (!doneSeen) throw new Error('Поток завершился до события done.');
  if (!message.trim()) throw new Error('Сервер вернул пустой ответ.');
  return { message, finishReason, usage, model };
}

import {
  buildChatRequest,
  DEFAULT_SETTINGS,
  isValidMessage,
  MAX_MESSAGES,
  FREE_MODEL,
  settingsError,
  type ResponseSettings,
} from '../../../lib/chat-request';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 300_000;
const encoder = new TextEncoder();
export const dynamic = 'force-dynamic';

type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
};

function event(name: string, value: unknown) {
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
}

function safeUsage(value: unknown): Usage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const usage: Usage = {};
  for (const key of [
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'prompt_cache_hit_tokens',
    'prompt_cache_miss_tokens',
  ] as const) {
    if (typeof source[key] === 'number' && Number.isFinite(source[key]))
      usage[key] = source[key];
  }
  const details = source.completion_tokens_details;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    const reasoning = (details as Record<string, unknown>).reasoning_tokens;
    if (typeof reasoning === 'number' && Number.isFinite(reasoning)) {
      usage.completion_tokens_details = { reasoning_tokens: reasoning };
    }
  }
  return Object.keys(usage).length ? usage : null;
}

async function* sseData(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reachedEnd = false;
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal.aborted) cancelReader();
  else signal.addEventListener('abort', cancelReader, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary = buffer.search(/\r\n\r\n|\n\n|\r\r/);
      while (boundary !== -1) {
        const separator =
          buffer.slice(boundary).match(/^(?:\r\n\r\n|\n\n|\r\r)/)?.[0] ??
          '\n\n';
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separator.length);
        const data = frame
          .split(/\r\n|\r|\n/)
          .filter((line) => !line.startsWith(':'))
          .filter((line) => line === 'data' || line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) yield data;
        boundary = buffer.search(/\r\n\r\n|\n\n|\r\r/);
      }
      if (done) {
        reachedEnd = true;
        break;
      }
    }
    if (buffer.trim()) throw new Error('Незавершённый SSE-кадр провайдера.');
  } finally {
    signal.removeEventListener('abort', cancelReader);
    if (!reachedEnd) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function POST(request: Request) {
  const jsonHeaders = { 'Cache-Control': 'no-store' };
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: 'Некорректный JSON в запросе.' },
      { status: 400, headers: jsonHeaders },
    );
  }

  const messages = (body as { messages?: unknown })?.messages;
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > MAX_MESSAGES
  ) {
    return Response.json(
      { error: `Передайте от 1 до ${MAX_MESSAGES} сообщений.` },
      { status: 400, headers: jsonHeaders },
    );
  }
  if (!messages.every(isValidMessage) || messages.at(-1)?.role !== 'user') {
    return Response.json(
      { error: 'История диалога имеет неверный формат.' },
      { status: 400, headers: jsonHeaders },
    );
  }
  const settings = (body as { settings?: unknown }).settings;
  const resolvedSettings = settings === undefined ? DEFAULT_SETTINGS : settings;
  const invalidSettings = settingsError(resolvedSettings);
  if (invalidSettings)
    return Response.json(
      { error: invalidSettings },
      { status: 400, headers: jsonHeaders },
    );
  const requestSettings = {
    ...DEFAULT_SETTINGS,
    ...(resolvedSettings as Partial<ResponseSettings>),
  };
  const isOpenRouter = requestSettings.model === FREE_MODEL;
  const provider = isOpenRouter ? 'OpenRouter' : 'DeepSeek';
  const keyName = isOpenRouter ? 'OPENROUTER_API_KEY' : 'DEEPSEEK_API_KEY';
  const apiKey = (
    isOpenRouter ? process.env.OPENROUTER_API_KEY : process.env.DEEPSEEK_API_KEY
  )?.trim();
  const timeoutMessage = `Таймаут приложения: ожидание ${provider} превысило 5 минут. Частичный ответ сохранён, если успел поступить.`;
  if (!apiKey)
    return Response.json(
      {
        error: `На сервере не задана переменная ${keyName}. Запрос в ${provider} не отправлен.`,
      },
      { status: 503, headers: jsonHeaders },
    );

  const requestJson = JSON.stringify(
    buildChatRequest(messages, requestSettings),
  );
  const abortController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, TIMEOUT_MS);
  const disconnect = () => abortController.abort();
  if (request.signal.aborted) abortController.abort();
  else request.signal.addEventListener('abort', disconnect, { once: true });
  const cleanup = () => {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', disconnect);
  };

  let upstream: Response;
  try {
    upstream = await fetch(
      isOpenRouter ? OPENROUTER_API_URL : DEEPSEEK_API_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: requestJson,
        signal: abortController.signal,
      },
    );
  } catch {
    cleanup();
    return Response.json(
      {
        error: timedOut
          ? timeoutMessage
          : `Не удалось связаться с ${provider}: соединение прервано или провайдер недоступен.`,
        requestJson,
      },
      { status: timedOut ? 504 : 502, headers: jsonHeaders },
    );
  }
  if (!upstream.ok) {
    cleanup();
    void upstream.body?.cancel().catch(() => undefined);
    const errors: Record<number, string> = {
      401: `${provider} отклонил API-ключ. Проверьте переменную ${keyName}.`,
      402: `${provider} ограничил доступ по балансу аккаунта. Проверьте аккаунт провайдера.`,
      403: `${provider} запретил доступ к модели. Проверьте настройки аккаунта и доступность модели.`,
      404: `${provider}: выбранная модель или её бесплатные провайдеры сейчас недоступны.`,
      408: `${provider} вернул HTTP 408: истекло время ожидания у провайдера.`,
      504: `${provider} вернул HTTP 504: истекло время ожидания у провайдера.`,
      429: `${provider} временно ограничил запросы: достигнут лимит или модель перегружена. Попробуйте позже.`,
    };
    return Response.json(
      {
        error:
          errors[upstream.status] ||
          `${provider} вернул ошибку HTTP ${upstream.status}.`,
        requestJson,
      },
      {
        status: upstream.status >= 500 ? 502 : upstream.status,
        headers: jsonHeaders,
      },
    );
  }
  if (!upstream.body) {
    cleanup();
    return Response.json(
      { error: `${provider} вернул пустой поток.`, requestJson },
      { status: 502, headers: jsonHeaders },
    );
  }

  const upstreamBody = upstream.body;
  let downstreamCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (name: string, value: unknown) => {
        if (downstreamCancelled) return false;
        controller.enqueue(event(name, value));
        return true;
      };
      emit('request', { requestJson });
      let contentSeen = false,
        doneSeen = false;
      let finishReason: string | null = null,
        usage: Usage | null = null,
        model = '';
      try {
        for await (const data of sseData(
          upstreamBody,
          abortController.signal,
        )) {
          if (downstreamCancelled) return;
          if (data === '[DONE]') {
            doneSeen = true;
            break;
          }
          let chunk: unknown;
          try {
            chunk = JSON.parse(data);
          } catch {
            throw new Error(`${provider} вернул повреждённый поток данных.`);
          }
          if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk))
            throw new Error(`${provider} вернул повреждённый поток данных.`);
          const record = chunk as Record<string, unknown>;
          if (record.error)
            throw new Error(`${provider} сообщил об ошибке в потоке.`);
          if (typeof record.model === 'string' && record.model)
            model = record.model;
          const nextUsage = safeUsage(record.usage);
          if (nextUsage) usage = Object.assign(usage ?? {}, nextUsage);
          const choice = Array.isArray(record.choices)
            ? record.choices[0]
            : null;
          if (choice && typeof choice === 'object') {
            const item = choice as Record<string, unknown>;
            if (item.finish_reason === 'error')
              throw new Error(`${provider} сообщил об ошибке в потоке.`);
            if (typeof item.finish_reason === 'string')
              finishReason = item.finish_reason;
            const delta = item.delta;
            if (delta && typeof delta === 'object') {
              const content = (delta as Record<string, unknown>).content;
              if (typeof content === 'string' && content) {
                contentSeen = true;
                emit('delta', { content });
              }
            }
          }
        }
        if (!doneSeen)
          throw new Error(`${provider} преждевременно закрыл поток.`);
        if (!contentSeen)
          throw new Error(
            finishReason === 'length'
              ? 'Лимит токенов исчерпан до появления ответа. Увеличьте лимит.'
              : `${provider} вернул пустой ответ. Проверьте лимит и стоп-строку.`,
          );
        if (!finishReason)
          throw new Error(`${provider} не указал причину завершения ответа.`);
        if (!model) throw new Error(`${provider} не указал модель в потоке.`);
        emit('done', { finishReason, usage, model });
      } catch (error) {
        if (!request.signal.aborted && !downstreamCancelled)
          emit('error', {
            error: timedOut
              ? timeoutMessage
              : error instanceof Error
                ? error.message
                : `Не удалось прочитать ответ ${provider}.`,
          });
      } finally {
        cleanup();
        if (!abortController.signal.aborted) abortController.abort();
        if (!downstreamCancelled) controller.close();
      }
    },
    cancel() {
      downstreamCancelled = true;
      abortController.abort();
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

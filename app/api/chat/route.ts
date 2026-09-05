import {
  buildDeepSeekRequest,
  DEFAULT_SETTINGS,
  isValidMessage,
  MAX_MESSAGES,
  MODEL,
  settingsError,
  type ResponseSettings,
} from '../../../lib/chat-request';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: 'Некорректный JSON в запросе.' },
      { status: 400, headers },
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
      { status: 400, headers },
    );
  }
  if (!messages.every(isValidMessage) || messages.at(-1)?.role !== 'user') {
    return Response.json(
      { error: 'История диалога имеет неверный формат.' },
      { status: 400, headers },
    );
  }

  const settings = (body as { settings?: unknown }).settings;
  const resolvedSettings = settings === undefined ? DEFAULT_SETTINGS : settings;
  const invalidSettings = settingsError(resolvedSettings);
  if (invalidSettings) {
    return Response.json({ error: invalidSettings }, { status: 400, headers });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return Response.json(
      {
        error:
          'На сервере не задана переменная DEEPSEEK_API_KEY. Запрос в DeepSeek не отправлен.',
      },
      { status: 503, headers },
    );
  }

  // Return the very same body passed to fetch, including on upstream errors.
  // Authorization is a separate server-only header and is never included here.
  const requestJson = JSON.stringify(
    buildDeepSeekRequest(messages, {
      ...DEFAULT_SETTINGS,
      ...(resolvedSettings as Partial<ResponseSettings>),
    }),
  );

  try {
    const upstream = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: requestJson,
      signal: AbortSignal.timeout(90000),
    });

    if (!upstream.ok) {
      const errorByStatus: Record<number, string> = {
        401: 'DeepSeek отклонил API-ключ. Проверьте переменную DEEPSEEK_API_KEY.',
        402: 'На балансе DeepSeek недостаточно средств.',
        429: 'DeepSeek временно ограничил частоту запросов. Попробуйте позже.',
      };
      return Response.json(
        {
          error:
            errorByStatus[upstream.status] ||
            `DeepSeek вернул ошибку ${upstream.status}.`,
          requestJson,
        },
        { status: upstream.status >= 500 ? 502 : upstream.status, headers },
      );
    }

    const result = (await upstream.json()) as {
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
    };
    const choice = result.choices?.[0];
    const message = choice?.message?.content?.trim();
    const finishReason = choice?.finish_reason ?? null;
    if (!message) {
      return Response.json(
        {
          error:
            finishReason === 'length'
              ? 'Лимит токенов исчерпан до появления ответа. Увеличьте лимит.'
              : 'DeepSeek вернул пустой ответ. Проверьте лимит и стоп-строку.',
          requestJson,
          finishReason,
        },
        { status: 502, headers },
      );
    }

    return Response.json(
      { message, model: MODEL, requestJson, finishReason },
      { headers },
    );
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return Response.json(
      {
        error: timedOut
          ? 'DeepSeek не ответил вовремя.'
          : 'Не удалось связаться с DeepSeek.',
        requestJson,
      },
      { status: 502, headers },
    );
  }
}

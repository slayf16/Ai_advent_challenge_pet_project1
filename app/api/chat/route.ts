type IncomingMessage = {
  role: 'user' | 'assistant';
  content: string;
};

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-flash';
const MAX_MESSAGES = 30;
const MAX_MESSAGE_LENGTH = 12000;

export const dynamic = 'force-dynamic';

function isValidMessage(value: unknown): value is IncomingMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.content === 'string' &&
    message.content.trim().length > 0 &&
    message.content.length <= MAX_MESSAGE_LENGTH
  );
}

export async function POST(request: Request) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'На сервере не задана переменная DEEPSEEK_API_KEY.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Некорректный JSON в запросе.' }, { status: 400 });
  }

  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return Response.json({ error: `Передайте от 1 до ${MAX_MESSAGES} сообщений.` }, { status: 400 });
  }
  if (!messages.every(isValidMessage) || messages.at(-1)?.role !== 'user') {
    return Response.json({ error: 'История диалога имеет неверный формат.' }, { status: 400 });
  }

  try {
    const upstream = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: 'Ты полезный ассистент. Отвечай ясно и по существу на языке пользователя.' },
          ...messages,
        ],
        stream: false,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(90000),
    });

    if (!upstream.ok) {
      const errorByStatus: Record<number, string> = {
        401: 'DeepSeek отклонил API-ключ. Проверьте переменную DEEPSEEK_API_KEY.',
        402: 'На балансе DeepSeek недостаточно средств.',
        429: 'DeepSeek временно ограничил частоту запросов. Попробуйте позже.',
      };
      return Response.json(
        { error: errorByStatus[upstream.status] || `DeepSeek вернул ошибку ${upstream.status}.` },
        { status: upstream.status >= 500 ? 502 : upstream.status, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const result = (await upstream.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const message = result.choices?.[0]?.message?.content?.trim();
    if (!message) {
      return Response.json({ error: 'DeepSeek вернул пустой ответ.' }, { status: 502 });
    }

    return Response.json({ message, model: MODEL }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return Response.json(
      { error: timedOut ? 'DeepSeek не ответил вовремя.' : 'Не удалось связаться с DeepSeek.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

export type IncomingMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type ResponseSettings = {
  format: string;
  maxTokens: number | null;
  stopMode: 'none' | 'instruction' | 'sequence';
  stopInstruction: string;
  stopSequence: string;
};

export const MODEL = 'deepseek-v4-flash';
export const MAX_MESSAGES = 30;
export const MAX_MESSAGE_LENGTH = 12000;
export const MAX_TOKENS = 4096;
export const DEFAULT_SETTINGS: ResponseSettings = {
  format: '',
  maxTokens: null,
  stopMode: 'none',
  stopInstruction: '',
  stopSequence: '',
};

export function settingsError(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Параметры ответа должны быть объектом.';
  }
  const settings = value as Record<string, unknown>;
  if (
    settings.format !== undefined &&
    (typeof settings.format !== 'string' || settings.format.length > 2000)
  ) {
    return 'Формат ответа должен быть строкой до 2 000 символов или пустым.';
  }
  if (
    settings.maxTokens !== undefined &&
    settings.maxTokens !== null &&
    (!Number.isInteger(settings.maxTokens) ||
      (settings.maxTokens as number) < 1 ||
      (settings.maxTokens as number) > MAX_TOKENS)
  ) {
    return `Укажите целое число от 1 до ${MAX_TOKENS} токенов или оставьте лимит пустым.`;
  }
  if (
    settings.stopMode !== undefined &&
    settings.stopMode !== 'none' &&
    settings.stopMode !== 'instruction' &&
    settings.stopMode !== 'sequence'
  ) {
    return 'Выберите способ завершения ответа.';
  }
  if (
    settings.stopInstruction !== undefined &&
    (typeof settings.stopInstruction !== 'string' ||
      settings.stopInstruction.length > 2000)
  ) {
    return 'Инструкция завершения должна быть строкой до 2 000 символов или пустой.';
  }
  if (
    settings.stopSequence !== undefined &&
    (typeof settings.stopSequence !== 'string' ||
      settings.stopSequence.length > 200)
  ) {
    return 'Стоп-строка должна содержать до 200 символов или быть пустой.';
  }
  return null;
}

export function isValidMessage(value: unknown): value is IncomingMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.content === 'string' &&
    message.content.trim().length > 0 &&
    message.content.length <= MAX_MESSAGE_LENGTH
  );
}

export function buildDeepSeekRequest(
  messages: IncomingMessage[],
  settings: ResponseSettings,
) {
  const stopSequence =
    settings.stopMode === 'sequence' && settings.stopSequence.trim()
      ? settings.stopSequence
      : null;
  const completion =
    settings.stopMode === 'instruction'
      ? settings.stopInstruction.trim()
      : stopSequence
        ? `После завершённого ответа выведи маркер ${JSON.stringify(stopSequence)} и сразу остановись. Не используй этот маркер внутри ответа.`
        : '';
  const instructions = [
    settings.format.trim() ? `Формат ответа: ${settings.format.trim()}` : '',
    settings.maxTokens !== null
      ? `Ограничение длины: не более ${settings.maxTokens} токенов. Планируй краткий, законченный ответ в пределах этого лимита.`
      : '',
    completion ? `Условие завершения: ${completion}` : '',
  ].filter(Boolean);

  return {
    model: MODEL,
    messages: [
      ...(instructions.length
        ? [
            {
              role: 'system' as const,
              content: [
                'Ты полезный ассистент. Отвечай ясно и по существу на языке пользователя.',
                ...instructions,
              ].join('\n\n'),
            },
          ]
        : []),
      ...messages.map(({ role, content }) => ({ role, content })),
    ],
    stream: false,
    // Small answer budgets should not be consumed by hidden reasoning.
    ...(settings.maxTokens !== null
      ? {
          thinking: { type: 'disabled' as const },
          max_tokens: settings.maxTokens,
        }
      : {}),
    ...(stopSequence ? { stop: [stopSequence] } : {}),
  };
}

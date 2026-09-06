export type IncomingMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type ResponseSettings = {
  model: ChatModel;
  systemPrompt: string;
  format: string;
  maxTokens: number | null;
  temperature: number | null;
  stopMode: 'none' | 'instruction' | 'sequence';
  stopInstruction: string;
  stopSequence: string;
};

export const MODEL = 'deepseek-v4-flash';
export const FREE_MODEL = 'liquid/lfm-2.5-2.6b:free';
export const MODELS = [
  {
    id: FREE_MODEL,
    name: 'Liquid LFM 2.5 2.6B',
    label: 'Маленькая · бесплатная',
    description:
      'Облачная модель через OpenRouter для сравнения с DeepSeek. Бесплатные запросы ограничены по частоте и доступности.',
  },
  {
    id: MODEL,
    name: 'DeepSeek V4 Flash',
    label: 'Слабее · дешевле',
    description: 'Для повседневных вопросов и простых задач.',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    label: 'Сильнее · дороже',
    description: 'Для сложных задач, анализа и программирования.',
  },
] as const;
export type ChatModel = (typeof MODELS)[number]['id'];
export const MAX_MESSAGES = 30;
export const MAX_MESSAGE_LENGTH = 12000;
export const MAX_SYSTEM_PROMPT_LENGTH = 8000;
export const MAX_TOKENS = 4096;
export const DEFAULT_SETTINGS: ResponseSettings = {
  model: MODEL,
  systemPrompt: '',
  format: '',
  maxTokens: null,
  temperature: null,
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
    settings.model !== undefined &&
    !MODELS.some((model) => model.id === settings.model)
  ) {
    return 'Выберите поддерживаемую модель.';
  }
  if (
    settings.systemPrompt !== undefined &&
    (typeof settings.systemPrompt !== 'string' ||
      settings.systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH)
  ) {
    return 'Системный промпт должен быть строкой до 8 000 символов или пустым.';
  }
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
    settings.temperature !== undefined &&
    settings.temperature !== null &&
    (typeof settings.temperature !== 'number' ||
      !Number.isFinite(settings.temperature) ||
      settings.temperature < 0 ||
      settings.temperature > 2)
  ) {
    return 'Укажите температуру от 0 до 2 или оставьте поле пустым.';
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

export function buildChatRequest(
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
  const systemPrompt = settings.systemPrompt.trim();

  return {
    model: settings.model ?? MODEL,
    messages: [
      ...(systemPrompt || instructions.length
        ? [
            {
              role: 'system' as const,
              content: [
                'Ты полезный ассистент. Отвечай ясно и по существу на языке пользователя.',
                systemPrompt,
                ...instructions,
              ]
                .filter(Boolean)
                .join('\n\n'),
            },
          ]
        : []),
      ...messages.map(({ role, content }) => ({ role, content })),
    ],
    stream: true,
    stream_options: { include_usage: true },
    // Thinking mode ignores temperature and can consume small answer budgets.
    ...(settings.model !== FREE_MODEL &&
    (settings.maxTokens !== null || settings.temperature != null)
      ? { thinking: { type: 'disabled' as const } }
      : {}),
    ...(settings.maxTokens !== null ? { max_tokens: settings.maxTokens } : {}),
    ...(settings.temperature != null
      ? { temperature: settings.temperature }
      : {}),
    ...(stopSequence ? { stop: [stopSequence] } : {}),
  };
}

// Backward-compatible name for existing callers.
export const buildDeepSeekRequest = buildChatRequest;

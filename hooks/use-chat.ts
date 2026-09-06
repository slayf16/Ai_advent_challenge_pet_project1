'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  settingsError,
  type IncomingMessage,
  type ResponseSettings,
} from '@/lib/chat-request';
import { streamChat } from '@/lib/chat-stream';
import type { RequestMetrics } from '@/lib/chat-metrics';
import {
  collectExperts,
  EXPERT_ROLES,
  expertMessages,
  expertSettings,
  historyMessages,
  synthesisMessages,
  synthesisSettings,
  type ExpertAnswer,
  type ExpertId,
} from '@/lib/experts';

export type ChatMessage = IncomingMessage & {
  id: string;
  runId?: string;
  finishReason?: string | null;
  metrics?: RequestMetrics;
  error?: string;
};
export type ExpertResult = Omit<ExpertAnswer, 'status'> & {
  status: 'running' | ExpertAnswer['status'];
  metrics: RequestMetrics;
  requestJson: string | null;
};
export type ExpertRun = {
  id: string;
  topic: string;
  dataset: string;
  experts: ExpertResult[];
};
type RequestSnapshot = {
  messages: IncomingMessage[];
  prompt: string;
  council: boolean;
  topic: string;
  dataset: string;
};
const makeId = () => crypto.randomUUID();
const newMetrics = (model: ResponseSettings['model']): RequestMetrics => ({
  model,
  startedAt: performance.now(),
  firstTokenAt: null,
  endedAt: null,
  usage: null,
  status: 'running',
});
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Не удалось получить ответ.';

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [runs, setRuns] = useState<ExpertRun[]>([]);
  const [settings, setSettings] = useState<ResponseSettings>({
    ...DEFAULT_SETTINGS,
  });
  const [isSending, setIsSending] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [requestJson, setRequestJson] = useState<string | null>(null);
  const [lastRequest, setLastRequest] = useState<RequestSnapshot | null>(null);
  const active = useRef<AbortController | null>(null);

  useEffect(() => () => active.current?.abort(), []);

  const send = useCallback(
    async (
      promptText: string,
      options?: {
        council?: boolean;
        topic?: string;
        dataset?: string;
        snapshot?: RequestSnapshot;
      },
    ) => {
      if (active.current)
        throw new Error('Дождитесь ответа или остановите текущий запрос.');
      const prompt = promptText.trim();
      if (!prompt || prompt.length > 12000)
        throw new Error('Введите задачу до 12 000 символов.');
      const invalid = settingsError(settings);
      if (invalid) throw new Error(invalid);
      const snapshot: RequestSnapshot = options?.snapshot ?? {
        prompt,
        council: Boolean(options?.council),
        topic: options?.topic?.trim() ?? '',
        dataset: options?.dataset ?? '',
        messages: historyMessages([
          ...messages
            .filter(
              (item) => !item.metrics || item.metrics.status === 'complete',
            )
            .map(({ role, content }) => ({ role, content })),
          { role: 'user', content: prompt },
        ]),
      };
      if (snapshot.council && !snapshot.topic)
        throw new Error('Укажите тему для группы экспертов.');
      if (snapshot.topic.length > 300 || snapshot.dataset.length > 11900)
        throw new Error('Тема — до 300 символов, данные — до 11 900.');
      const roleSettings = EXPERT_ROLES.map((role) =>
        expertSettings(settings, role.id, snapshot.topic),
      );
      const mainSettings = snapshot.council
        ? synthesisSettings(settings)
        : settings;
      if (snapshot.council) {
        const invalidRole = [...roleSettings, mainSettings]
          .map(settingsError)
          .find(Boolean);
        if (invalidRole)
          throw new Error(
            'Сократите системный промпт: вместе с инструкциями ролей он должен помещаться в 8 000 символов.',
          );
      }
      const requestHistory = snapshot.council
        ? expertMessages(snapshot.messages, snapshot.dataset)
        : snapshot.messages;
      const controller = new AbortController();
      active.current = controller;
      setIsSending(true);
      setError(null);
      setRequestJson(null);
      setLastRequest(snapshot);
      const runId = snapshot.council ? makeId() : undefined;
      setMessages((current) => [
        ...current,
        { id: makeId(), role: 'user', content: snapshot.prompt, runId },
      ]);

      const runMain = async (history: IncomingMessage[]) => {
        const id = makeId();
        let content = '';
        let metrics = newMetrics(settings.model);
        const patch = (changes: Partial<ChatMessage>) =>
          setMessages((current) =>
            current.map((item) =>
              item.id === id ? { ...item, ...changes } : item,
            ),
          );
        setMessages((current) => [
          ...current,
          { id, role: 'assistant', content, metrics },
        ]);
        try {
          const result = await streamChat(history, mainSettings, {
            signal: controller.signal,
            onRequest: setRequestJson,
            onDelta: (delta) => {
              content += delta;
              metrics = {
                ...metrics,
                firstTokenAt: metrics.firstTokenAt ?? performance.now(),
              };
              patch({ content, metrics });
            },
            onUsage: (usage) => {
              metrics = { ...metrics, usage };
              patch({ metrics });
            },
          });
          metrics = {
            ...metrics,
            endedAt: performance.now(),
            usage: result.usage,
            status: 'complete',
          };
          patch({
            content: result.message,
            finishReason: result.finishReason,
            metrics,
          });
          return result.message;
        } catch (caught) {
          metrics = {
            ...metrics,
            endedAt: performance.now(),
            status: controller.signal.aborted ? 'cancelled' : 'error',
          };
          patch({
            metrics,
            error: controller.signal.aborted
              ? 'Ответ остановлен. Показанный текст может быть неполным.'
              : errorText(caught),
          });
          throw caught;
        }
      };

      try {
        if (!snapshot.council) {
          setPhase('Модель отвечает');
          return await runMain(requestHistory);
        }
        setPhase('Три эксперта отвечают параллельно');
        const initialExperts: ExpertResult[] = EXPERT_ROLES.map((role) => ({
          id: role.id,
          content: '',
          status: 'running',
          requestJson: null,
          metrics: newMetrics(settings.model),
        }));
        setRuns((current) => [
          ...current,
          {
            id: runId!,
            topic: snapshot.topic,
            dataset: snapshot.dataset,
            experts: initialExperts,
          },
        ]);
        const updateExpert = (id: ExpertId, patch: Partial<ExpertResult>) =>
          setRuns((current) =>
            current.map((run) =>
              run.id === runId
                ? {
                    ...run,
                    experts: run.experts.map((expert) =>
                      expert.id === id ? { ...expert, ...patch } : expert,
                    ),
                  }
                : run,
            ),
          );
        const settled = await collectExperts(
          async (role): Promise<ExpertAnswer> => {
            let content = '';
            let metrics = newMetrics(settings.model);
            updateExpert(role.id, { metrics });
            try {
              const result = await streamChat(
                requestHistory,
                roleSettings[EXPERT_ROLES.indexOf(role)],
                {
                  signal: controller.signal,
                  onRequest: (json) => {
                    updateExpert(role.id, { requestJson: json });
                    setRequestJson(json);
                  },
                  onDelta: (delta) => {
                    content += delta;
                    metrics = {
                      ...metrics,
                      firstTokenAt: metrics.firstTokenAt ?? performance.now(),
                    };
                    updateExpert(role.id, { content, metrics });
                  },
                  onUsage: (usage) => {
                    metrics = { ...metrics, usage };
                    updateExpert(role.id, { metrics });
                  },
                },
              );
              metrics = {
                ...metrics,
                endedAt: performance.now(),
                usage: result.usage,
                status: 'complete',
              };
              updateExpert(role.id, {
                content: result.message,
                metrics,
                status: 'complete',
                finishReason: result.finishReason,
              });
              return {
                id: role.id,
                content: result.message,
                status: 'complete',
                finishReason: result.finishReason,
              };
            } catch (caught) {
              const status = controller.signal.aborted ? 'cancelled' : 'error';
              const message = controller.signal.aborted
                ? 'Ответ остановлен.'
                : errorText(caught);
              metrics = { ...metrics, endedAt: performance.now(), status };
              updateExpert(role.id, { metrics, status, error: message });
              return { id: role.id, content, status, error: message };
            }
          },
        );
        if (controller.signal.aborted) throw new Error('Запуск остановлен.');
        const answers: ExpertAnswer[] = settled.map((item, index) =>
          item.status === 'fulfilled'
            ? item.value
            : {
                id: EXPERT_ROLES[index].id,
                content: '',
                status: 'error',
                error: errorText(item.reason),
              },
        );
        if (!answers.some((answer) => answer.content.trim()))
          throw new Error(
            'Ни один эксперт не вернул ответ. Проверьте ошибки в панелях и повторите запрос.',
          );
        setPhase('Главный ассистент сопоставляет ответы');
        return await runMain(synthesisMessages(requestHistory, answers));
      } catch (caught) {
        setError(
          controller.signal.aborted
            ? 'Запрос остановлен. Частичные ответы сохранены.'
            : errorText(caught),
        );
        throw caught;
      } finally {
        active.current = null;
        setIsSending(false);
        setPhase('');
      }
    },
    [messages, settings],
  );

  const reset = () => {
    if (active.current) return;
    setMessages([]);
    setRuns([]);
    setError(null);
    setRequestJson(null);
    setLastRequest(null);
  };
  const repeat = async () => {
    if (!lastRequest) return;
    return send(lastRequest.prompt, { snapshot: lastRequest });
  };

  return {
    messages,
    runs,
    settings,
    setSettings,
    isSending,
    phase,
    error,
    setError,
    requestJson,
    lastRequest,
    send,
    reset,
    repeat,
    stop: () => active.current?.abort(),
  };
}

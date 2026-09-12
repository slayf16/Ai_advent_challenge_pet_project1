'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Agent, type AgentProfile } from '@/lib/agent';
import {
  DEFAULT_SETTINGS,
  isValidMessage,
  settingsError,
  type IncomingMessage,
  type ResponseSettings,
} from '@/lib/chat-request';
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
export type ChatSession = {
  id: string;
  title: string;
  updatedAt: number;
  agent: AgentProfile;
  messages: ChatMessage[];
  runs: ExpertRun[];
  error: string | null;
  requestJson: string | null;
  lastRequest: RequestSnapshot | null;
  draft: string;
  council: boolean;
  topic: string;
  dataset: string;
};

export const STORAGE_KEY = 'deepchat.sessions.v1';
const MAX_PERSISTED_OUTPUT_LENGTH = 1_000_000;
export class AcceptedChatError extends Error {
  readonly accepted = true;
}
const makeId = () => crypto.randomUUID();
const now = () => Date.now();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.length <= max ? value : '';
// TODO: Replace the fixed one-million-code-unit ceiling with quota-aware
// storage handling so unusually large, valid model outputs are not discarded.
const persistedOutput = (value: unknown) =>
  typeof value === 'string' && value.trim() && value.length <= MAX_PERSISTED_OUTPUT_LENGTH
    ? value
    : '';
const validJson = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
};
const newMetrics = (model: ResponseSettings['model']): RequestMetrics => ({
  model,
  startedAt: now(),
  firstTokenAt: null,
  endedAt: null,
  usage: null,
  status: 'running',
});
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Не удалось получить ответ.';

const normalizeSettings = (value: unknown): ResponseSettings => {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS };
  const settings = { ...DEFAULT_SETTINGS } as ResponseSettings;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof ResponseSettings)[]) {
    if (!(key in value)) continue;
    const candidate = { ...settings, [key]: value[key] };
    if (!settingsError(candidate)) Object.assign(settings, candidate);
  }
  return settings;
};

const normalizeMetrics = (value: unknown): RequestMetrics | undefined => {
  if (!isRecord(value)) return undefined;
  const status = value.status;
  if (!['running', 'complete', 'error', 'cancelled'].includes(String(status)))
    return undefined;
  if (!Number.isFinite(value.startedAt) || (value.endedAt !== null && !Number.isFinite(value.endedAt)))
    return undefined;
  const firstTokenAt = Number.isFinite(value.firstTokenAt) ? Number(value.firstTokenAt) : null;
  return {
    model: normalizeSettings({ model: value.model }).model,
    startedAt: Number(value.startedAt),
    firstTokenAt,
    endedAt: value.endedAt === null ? null : Number(value.endedAt),
    usage: isRecord(value.usage) ? value.usage : null,
    status: status === 'running' ? 'cancelled' : status as RequestMetrics['status'],
  };
};

const normalizeSnapshot = (value: unknown): RequestSnapshot | null => {
  if (!isRecord(value)) return null;
  const prompt = text(value.prompt, 12000).trim();
  const messages = Array.isArray(value.messages)
    ? value.messages.filter(isValidMessage).map(({ role, content }) => ({ role, content }))
    : [];
  if (!prompt || !messages.length) return null;
  return {
    prompt,
    messages,
    council: value.council === true,
    topic: text(value.topic, 300),
    dataset: text(value.dataset, 11900),
  };
};

const normalizeMessage = (value: unknown): ChatMessage | null => {
  if (!isRecord(value)) return null;
  const fields = value as Record<string, unknown>;
  if (typeof fields.id !== 'string') return null;
  if (fields.role !== 'user' && fields.role !== 'assistant') return null;
  const content = fields.role === 'assistant'
    ? persistedOutput(fields.content)
    : isValidMessage(value)
      ? value.content
      : '';
  if (!content) return null;
  const metrics = normalizeMetrics(fields.metrics);
  return {
    id: fields.id as string,
    role: fields.role,
    content,
    ...(typeof fields.runId === 'string' ? { runId: fields.runId } : {}),
    ...(typeof fields.finishReason === 'string' || fields.finishReason === null
      ? { finishReason: fields.finishReason }
      : {}),
    ...(metrics ? { metrics } : {}),
    ...(typeof fields.error === 'string' ? { error: fields.error } : {}),
  };
};

const normalizeRun = (value: unknown): ExpertRun | null => {
  if (!isRecord(value) || typeof value.id !== 'string' || !Array.isArray(value.experts)) return null;
  const persistedExperts: unknown[] = value.experts;
  const experts = EXPERT_ROLES.map((role): ExpertResult | null => {
    const item = persistedExperts.find((candidate: unknown) =>
      isRecord(candidate) && candidate.id === role.id,
    );
    if (!isRecord(item)) return null;
    const metrics = normalizeMetrics(item.metrics);
    if (!metrics || !['running', 'complete', 'error', 'cancelled'].includes(String(item.status))) return null;
    const status = item.status === 'running' ? 'cancelled' : item.status as ExpertAnswer['status'];
    return {
      id: role.id,
      content: persistedOutput(item.content),
      status,
      metrics,
      requestJson: validJson(item.requestJson) ? item.requestJson : null,
      ...(typeof item.finishReason === 'string' || item.finishReason === null
        ? { finishReason: item.finishReason }
        : {}),
      ...(typeof item.error === 'string' ? { error: item.error } : {}),
    };
  });
  const completeExperts = experts.filter((expert): expert is ExpertResult => expert !== null);
  return completeExperts.length === EXPERT_ROLES.length
    ? { id: value.id, topic: text(value.topic, 300), dataset: text(value.dataset, 11900), experts: completeExperts }
    : null;
};

const createSession = (): ChatSession => ({
  id: makeId(),
  title: 'Новый чат',
  updatedAt: now(),
  agent: { id: makeId(), name: 'Новый агент', settings: { ...DEFAULT_SETTINGS } },
  messages: [],
  runs: [],
  error: null,
  requestJson: null,
  lastRequest: null,
  draft: '',
  council: false,
  topic: '',
  dataset: '',
});

export const recoverSession = (value: unknown): ChatSession | null => {
  if (!isRecord(value) || !isRecord(value.agent) || typeof value.id !== 'string' || !value.id ||
    typeof value.agent.id !== 'string' || typeof value.agent.name !== 'string') return null;
  const messages = Array.isArray(value.messages)
    ? value.messages.map(normalizeMessage).filter((item): item is ChatMessage => item !== null)
    : [];
  const runs = Array.isArray(value.runs)
    ? value.runs.map(normalizeRun).filter((item): item is ExpertRun => item !== null)
    : [];
  return {
    id: value.id,
    title: text(value.title, 120) || 'Новый чат',
    updatedAt: Number.isFinite(value.updatedAt) ? Number(value.updatedAt) : now(),
    agent: {
      id: value.agent.id,
      name: text(value.agent.name, 80) || 'Новый агент',
      settings: normalizeSettings(value.agent.settings),
    },
    messages,
    runs,
    error: typeof value.error === 'string' ? value.error : null,
    requestJson: validJson(value.requestJson) ? value.requestJson : null,
    lastRequest: normalizeSnapshot(value.lastRequest),
    draft: text(value.draft, 12000),
    council: value.council === true,
    topic: text(value.topic, 300),
    dataset: text(value.dataset, 11900),
  };
};

export const restoreStore = (stored: string | null) => {
  const fallback = createSession();
  if (!stored) return { sessions: [fallback], activeSessionId: fallback.id };
  try {
    const parsed = JSON.parse(stored) as { activeSessionId?: unknown; sessions?: unknown };
    const sessions = Array.isArray(parsed.sessions)
      ? parsed.sessions.map(recoverSession).filter((item): item is ChatSession => item !== null)
      : [];
    if (!sessions.length) return { sessions: [fallback], activeSessionId: fallback.id };
    return {
      sessions,
      activeSessionId: typeof parsed.activeSessionId === 'string' && sessions.some((item) => item.id === parsed.activeSessionId)
        ? parsed.activeSessionId
        : sessions[0].id,
    };
  } catch {
    return { sessions: [fallback], activeSessionId: fallback.id };
  }
};

export function useChat() {
  // Deliberately do not read localStorage here: this first client render must match SSR.
  const [initial] = useState(createSession);
  const [sessions, setSessions] = useState<ChatSession[]>([initial]);
  const [activeSessionId, setActiveSessionId] = useState(initial.id);
  const [restored, setRestored] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [phase, setPhase] = useState('');
  const active = useRef<AbortController | null>(null);
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];

  useEffect(() => {
    let store;
    try {
      store = restoreStore(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      store = restoreStore(null);
    }
    queueMicrotask(() => {
      setSessions(store.sessions);
      setActiveSessionId(store.activeSessionId);
      setRestored(true);
    });
  }, []);
  useEffect(() => {
    if (!restored) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions, activeSessionId }));
    } catch {
      // The chat still works when browser storage is disabled or full.
    }
  }, [activeSessionId, restored, sessions]);
  useEffect(() => () => active.current?.abort(), []);

  const updateSession = useCallback(
    (id: string, transform: (session: ChatSession) => ChatSession) =>
      setSessions((current) => current.map((session) => session.id === id
        ? { ...transform(session), updatedAt: now() }
        : session)),
    [],
  );
  const patchSession = useCallback(
    (id: string, changes: Partial<ChatSession>) =>
      updateSession(id, (session) => ({ ...session, ...changes })),
    [updateSession],
  );

  const send = useCallback(async (promptText: string, options?: {
    council?: boolean;
    topic?: string;
    dataset?: string;
    snapshot?: RequestSnapshot;
  }) => {
    if (active.current) throw new Error('Дождитесь ответа или остановите текущий запрос.');
    const session = activeSession;
    const sessionId = session.id;
    const prompt = promptText.trim();
    if (!prompt || prompt.length > 12000) throw new Error('Введите задачу до 12 000 символов.');
    const agent = new Agent(session.agent);
    const settings = agent.settings;
    const invalid = settingsError(settings);
    if (invalid) throw new Error(invalid);
    const snapshot: RequestSnapshot = options?.snapshot ?? {
      prompt,
      council: Boolean(options?.council),
      topic: options?.topic?.trim() ?? '',
      dataset: options?.dataset ?? '',
      messages: historyMessages([...session.messages
        .filter((item) => !item.metrics || item.metrics.status === 'complete')
        .map(({ role, content }) => ({ role, content })), { role: 'user', content: prompt }]),
    };
    if (snapshot.council && !snapshot.topic) throw new Error('Укажите тему для группы экспертов.');
    if (snapshot.topic.length > 300 || snapshot.dataset.length > 11900)
      throw new Error('Тема — до 300 символов, данные — до 11 900.');
    const roleAgents = EXPERT_ROLES.map((role) => agent.withSettings(expertSettings(settings, role.id, snapshot.topic)));
    const mainAgent = snapshot.council ? agent.withSettings(synthesisSettings(settings)) : agent;
    if (snapshot.council && [...roleAgents, mainAgent].map((item) => settingsError(item.settings)).find(Boolean))
      throw new Error('Сократите системный промпт: вместе с инструкциями ролей он должен помещаться в 8 000 символов.');
    const requestHistory = snapshot.council ? expertMessages(snapshot.messages, snapshot.dataset) : snapshot.messages;
    const controller = new AbortController();
    active.current = controller;
    setIsSending(true);
    setPhase('');
    patchSession(sessionId, { error: null, requestJson: null, lastRequest: snapshot, draft: '' });
    const runId = snapshot.council ? makeId() : undefined;
    updateSession(sessionId, (current) => ({
      ...current,
      title: current.messages.length ? current.title : snapshot.prompt.slice(0, 48),
      messages: [...current.messages, { id: makeId(), role: 'user', content: snapshot.prompt, runId }],
    }));

    const runMain = async (history: IncomingMessage[]) => {
      const id = makeId();
      let content = '';
      let metrics = newMetrics(mainAgent.settings.model);
      const patch = (changes: Partial<ChatMessage>) => updateSession(sessionId, (current) => ({
        ...current,
        messages: current.messages.map((item) => item.id === id ? { ...item, ...changes } : item),
      }));
      updateSession(sessionId, (current) => ({
        ...current,
        messages: [...current.messages, { id, role: 'assistant', content, metrics }],
      }));
      try {
        const result = await mainAgent.request(history, {
          signal: controller.signal,
          onRequest: (requestJson) => patchSession(sessionId, { requestJson }),
          onDelta: (delta) => {
            content += delta;
            metrics = { ...metrics, firstTokenAt: metrics.firstTokenAt ?? now() };
            patch({ content, metrics });
          },
          onUsage: (usage) => { metrics = { ...metrics, usage }; patch({ metrics }); },
        });
        metrics = { ...metrics, endedAt: now(), usage: result.usage, status: 'complete' };
        patch({ content: result.message, finishReason: result.finishReason, metrics });
        return result.message;
      } catch (caught) {
        metrics = { ...metrics, endedAt: now(), status: controller.signal.aborted ? 'cancelled' : 'error' };
        patch({ metrics, error: controller.signal.aborted ? 'Ответ остановлен. Показанный текст может быть неполным.' : errorText(caught) });
        throw caught;
      }
    };

    try {
      if (!snapshot.council) { setPhase('Модель отвечает'); return await runMain(requestHistory); }
      setPhase('Три эксперта отвечают параллельно');
      const initialExperts: ExpertResult[] = EXPERT_ROLES.map((role) => ({
        id: role.id, content: '', status: 'running', requestJson: null, metrics: newMetrics(settings.model),
      }));
      updateSession(sessionId, (current) => ({
        ...current,
        runs: [...current.runs, { id: runId!, topic: snapshot.topic, dataset: snapshot.dataset, experts: initialExperts }],
      }));
      const updateExpert = (id: ExpertId, changes: Partial<ExpertResult>) => updateSession(sessionId, (current) => ({
        ...current,
        runs: current.runs.map((run) => run.id === runId ? {
          ...run,
          experts: run.experts.map((expert) => expert.id === id ? { ...expert, ...changes } : expert),
        } : run),
      }));
      const settled = await collectExperts(async (role): Promise<ExpertAnswer> => {
        let content = '';
        let metrics = newMetrics(roleAgents[EXPERT_ROLES.indexOf(role)].settings.model);
        updateExpert(role.id, { metrics });
        try {
          const result = await roleAgents[EXPERT_ROLES.indexOf(role)].request(requestHistory, {
            signal: controller.signal,
            onRequest: (requestJson) => {
              updateExpert(role.id, { requestJson });
              patchSession(sessionId, { requestJson });
            },
            onDelta: (delta) => {
              content += delta;
              metrics = { ...metrics, firstTokenAt: metrics.firstTokenAt ?? now() };
              updateExpert(role.id, { content, metrics });
            },
            onUsage: (usage) => { metrics = { ...metrics, usage }; updateExpert(role.id, { metrics }); },
          });
          metrics = { ...metrics, endedAt: now(), usage: result.usage, status: 'complete' };
          updateExpert(role.id, { content: result.message, metrics, status: 'complete', finishReason: result.finishReason });
          return { id: role.id, content: result.message, status: 'complete', finishReason: result.finishReason };
        } catch (caught) {
          const status = controller.signal.aborted ? 'cancelled' : 'error';
          const message = controller.signal.aborted ? 'Ответ остановлен.' : errorText(caught);
          metrics = { ...metrics, endedAt: now(), status };
          updateExpert(role.id, { metrics, status, error: message });
          return { id: role.id, content, status, error: message };
        }
      });
      if (controller.signal.aborted) throw new Error('Запуск остановлен.');
      const answers: ExpertAnswer[] = settled.map((item, index) => item.status === 'fulfilled'
        ? item.value
        : { id: EXPERT_ROLES[index].id, content: '', status: 'error', error: errorText(item.reason) });
      if (!answers.some((answer) => answer.content.trim()))
        throw new Error('Ни один эксперт не вернул ответ. Проверьте ошибки в панелях и повторите запрос.');
      setPhase('Главный ассистент сопоставляет ответы');
      return await runMain(synthesisMessages(requestHistory, answers));
    } catch (caught) {
      const message = controller.signal.aborted
        ? 'Запрос остановлен. Частичные ответы сохранены.'
        : errorText(caught);
      patchSession(sessionId, { error: message });
      throw new AcceptedChatError(message);
    } finally {
      active.current = null;
      setIsSending(false);
      setPhase('');
    }
  }, [activeSession, patchSession, updateSession]);

  const reset = () => {
    if (!active.current) patchSession(activeSession.id, { messages: [], runs: [], error: null, requestJson: null, lastRequest: null });
  };
  const newChat = () => {
    if (active.current) return;
    const session = createSession();
    setSessions((current) => [session, ...current]);
    setActiveSessionId(session.id);
  };
  const setActiveSession = (id: string) => {
    if (!active.current && sessions.some((session) => session.id === id)) setActiveSessionId(id);
  };
  const setSettings = (settings: ResponseSettings) => updateSession(activeSession.id, (session) => ({
    ...session, agent: { ...session.agent, settings },
  }));
  const setAgentName = (name: string) => updateSession(activeSession.id, (session) => ({
    ...session, agent: { ...session.agent, name: name.slice(0, 80) },
  }));
  const setField = <K extends keyof Pick<ChatSession, 'draft' | 'council' | 'topic' | 'dataset'>>(key: K, value: ChatSession[K]) =>
    patchSession(activeSession.id, { [key]: value } as Partial<ChatSession>);

  return {
    sessions, activeSessionId, setActiveSession, newChat, agent: activeSession.agent, setAgentName,
    messages: activeSession.messages, runs: activeSession.runs, settings: activeSession.agent.settings, setSettings,
    isSending, phase, error: activeSession.error,
    setError: (error: string | null) => patchSession(activeSession.id, { error }),
    requestJson: activeSession.requestJson, lastRequest: activeSession.lastRequest,
    draft: activeSession.draft, setDraft: (draft: string) => setField('draft', draft),
    council: activeSession.council, setCouncil: (council: boolean) => setField('council', council),
    topic: activeSession.topic, setTopic: (topic: string) => setField('topic', topic),
    dataset: activeSession.dataset, setDataset: (dataset: string) => setField('dataset', dataset),
    send,
    reset,
    repeat: async () => activeSession.lastRequest && send(activeSession.lastRequest.prompt, { snapshot: activeSession.lastRequest }),
    stop: () => active.current?.abort(),
  };
}

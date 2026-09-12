'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type SyntheticEvent,
} from 'react';
import {
  AlertCircle,
  ArrowUp,
  Bot,
  LoaderCircle,
  Plus,
  Sparkles,
  Square,
  User,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ResponseSettingsPanel } from '@/components/response-settings';
import { ExpertPanel } from '@/components/expert-panel';
import {
  AggregateMetricsView,
  RequestMetricsView,
} from '@/components/request-metrics';
import { AcceptedChatError, useChat } from '@/hooks/use-chat';
import { MODELS, settingsError } from '@/lib/chat-request';
import { EXPERT_ROLES, SYNTHESIS_PROMPT } from '@/lib/experts';

type ModelContext = {
  registerTool: (
    tool: {
      name: string;
      title?: string;
      description: string;
      inputSchema: object;
      annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
      execute: (input: unknown) => unknown;
    },
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>;
};
declare global {
  interface Document {
    readonly modelContext?: ModelContext;
  }
}

export default function Home() {
  const chat = useChat();
  const { send } = chat;
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);
  const {
    draft,
    setDraft,
    council,
    setCouncil,
    topic,
    setTopic,
    dataset,
    setDataset,
  } = chat;
  const endRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const previousSessionId = useRef<string | null>(null);
  const invalid = settingsError(chat.settings);
  const metrics = [
    ...chat.messages.flatMap((message) =>
      message.metrics ? [message.metrics] : [],
    ),
    ...chat.runs.flatMap((run) => run.experts.map((expert) => expert.metrics)),
  ];

  const scrollChat = useCallback((position: 'start' | 'end') => {
    const desktopLayout = window.matchMedia('(min-width: 1024px)').matches;
    if (desktopLayout) {
      const container = chatScrollRef.current;
      container?.scrollTo({
        top: position === 'end' ? container.scrollHeight : 0,
        behavior: 'auto',
      });
      return;
    }
    if (position === 'end') {
      endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
      return;
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  useEffect(() => {
    const trackScroll = () => {
      if (window.matchMedia('(min-width: 1024px)').matches) {
        const container = chatScrollRef.current;
        if (!container) return;
        followOutput.current =
          container.scrollHeight -
            container.scrollTop -
            container.clientHeight <=
          220;
        return;
      }
      const end = endRef.current;
      if (!end) {
        followOutput.current = true;
        return;
      }
      const { bottom } = end.getBoundingClientRect();
      followOutput.current = bottom >= 0 && bottom <= window.innerHeight + 220;
    };
    const container = chatScrollRef.current;
    container?.addEventListener('scroll', trackScroll, { passive: true });
    window.addEventListener('scroll', trackScroll, { passive: true });
    window.addEventListener('resize', trackScroll, { passive: true });
    return () => {
      container?.removeEventListener('scroll', trackScroll);
      window.removeEventListener('scroll', trackScroll);
      window.removeEventListener('resize', trackScroll);
    };
  }, []);
  useEffect(() => {
    if (previousSessionId.current === chat.activeSessionId) return;
    previousSessionId.current = chat.activeSessionId;
    followOutput.current = true;
    scrollChat(chat.messages.length ? 'end' : 'start');
  }, [chat.activeSessionId, chat.messages.length, scrollChat]);
  useEffect(() => {
    if (!followOutput.current) return;
    scrollChat(chat.messages.length ? 'end' : 'start');
  }, [chat.messages, chat.phase, chat.runs, scrollChat]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(
      context.registerTool(
        {
          name: 'send_deepseek_message',
          title: 'Отправить сообщение выбранной модели',
          description:
            'Отправляет сообщение в текущий диалог. По явному запросу пользователя council=true запускает трёх экспертов по указанной topic, затем показывает общий вывод.',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', minLength: 1, maxLength: 12000 },
              council: { type: 'boolean' },
              topic: { type: 'string', maxLength: 300 },
              dataset: { type: 'string', maxLength: 11900 },
            },
            required: ['message'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          async execute(input) {
            const args = input as {
              message?: unknown;
              council?: unknown;
              topic?: unknown;
              dataset?: unknown;
            };
            if (typeof args?.message !== 'string' || !args.message.trim())
              throw new Error('Поле message должно содержать непустую строку.');
            if (args.council !== undefined && typeof args.council !== 'boolean')
              throw new Error('Поле council должно быть логическим.');
            if (args.topic !== undefined && typeof args.topic !== 'string')
              throw new Error('Поле topic должно быть строкой.');
            if (args.dataset !== undefined && typeof args.dataset !== 'string')
              throw new Error('Поле dataset должно быть строкой.');
            const answer = await sendRef.current(args.message, {
              council: args.council === true,
              topic: args.topic as string | undefined,
              dataset: args.dataset as string | undefined,
            });
            return { status: 'completed', answer };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  const submit = async (event?: SyntheticEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (
      !draft.trim() ||
      chat.isSending ||
      invalid ||
      (council && !topic.trim())
    )
      return;
    const prompt = draft;
    setDraft('');
    followOutput.current = true;
    try {
      await send(prompt, { council, topic, dataset });
    } catch (caught) {
      if (!(caught instanceof AcceptedChatError)) {
        setDraft(prompt);
        chat.setError(
          caught instanceof Error
            ? caught.message
            : 'Не удалось отправить запрос.',
        );
      }
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <main className="min-h-dvh bg-background text-foreground lg:h-dvh lg:overflow-hidden">
      <div className="mx-auto flex min-h-dvh w-full max-w-[1680px] flex-col px-4 sm:px-6 lg:h-dvh">
        <header className="flex h-20 shrink-0 items-center justify-between border-b border-white/8">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-[0_0_30px_color-mix(in_oklab,var(--primary)_32%,transparent)]">
              <Sparkles className="size-5" aria-hidden="true" />
            </div>
            <div>
              <p className="font-semibold tracking-tight">DeepChat</p>
              <p className="text-xs text-muted-foreground">{MODELS.find((model) => model.id === chat.settings.model)?.name}</p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            className="rounded-xl border-white/10 bg-white/4"
            onClick={() => {
              chat.newChat();
            }}
            disabled={chat.isSending}
          >
            <Plus className="size-4" />
            <span>Новый диалог</span>
          </Button>
        </header>

        <div className="grid flex-1 grid-cols-1 gap-6 py-6 lg:min-h-0 lg:grid-cols-[220px_minmax(0,1fr)_340px] lg:gap-6">
          <aside className="min-w-0 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:pr-1" aria-label="Сохранённые чаты">
            <div className="rounded-2xl border border-white/10 bg-card/70 p-3">
              <div className="mb-3 flex items-center justify-between gap-2 px-2">
                <h2 className="text-sm font-semibold">Чаты и агенты</h2>
                <Button type="button" variant="ghost" size="icon" onClick={chat.newChat} disabled={chat.isSending} aria-label="Создать чат">
                  <Plus className="size-4" />
                </Button>
              </div>
              <div className="space-y-1">
                {chat.sessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    disabled={chat.isSending}
                    onClick={() => chat.setActiveSession(session.id)}
                    className={`w-full rounded-xl px-3 py-2 text-left text-sm transition-colors ${session.id === chat.activeSessionId ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-white/5'}`}
                  >
                    <span className="block truncate font-medium">{session.title}</span>
                    <span className="mt-0.5 block truncate text-xs opacity-75">{session.agent.name}</span>
                  </button>
                ))}
              </div>
              <p className="mt-3 px-2 text-xs leading-5 text-muted-foreground">
                Сессии и черновики хранятся только в этом браузере.
              </p>
            </div>
          </aside>
          <section
            className="flex min-w-0 flex-col lg:min-h-0"
            aria-label="Диалог с моделью"
          >
            <div
              ref={chatScrollRef}
              className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain lg:pr-2"
            >
              <div className="flex flex-1 flex-col">
                <section
                  className="rounded-2xl border border-primary/20 bg-primary/5 p-4 sm:p-5"
                  aria-labelledby="council-title"
                >
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Users className="size-5 shrink-0 text-primary" />
                  <div>
                    <label
                      id="council-title"
                      htmlFor="council-mode"
                      className="cursor-pointer font-semibold"
                    >
                      Группа экспертов
                    </label>
                    <p
                      id="council-hint"
                      className="mt-1 text-sm text-muted-foreground"
                    >
                      Три ответа параллельно, затем общий вывод
                    </p>
                  </div>
                </div>
                <Switch
                  id="council-mode"
                  checked={council}
                  onCheckedChange={setCouncil}
                  disabled={chat.isSending}
                  aria-describedby="council-hint"
                />
              </div>
              {council && (
                <fieldset disabled={chat.isSending} className="mt-5 space-y-4">
                  <div>
                    <label
                      htmlFor="expert-topic"
                      className="mb-2 block text-sm font-medium"
                    >
                      Тема экспертизы{' '}
                      <span className="text-muted-foreground">
                        · обязательно
                      </span>
                    </label>
                    <Input
                      id="expert-topic"
                      value={topic}
                      onChange={(event) => setTopic(event.target.value)}
                      maxLength={300}
                      placeholder="Например: алгоритмы, логистика, анализ продаж"
                      className="h-11"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="expert-data"
                      className="mb-2 block text-sm font-medium"
                    >
                      Данные для анализа{' '}
                      <span className="text-muted-foreground">
                        · необязательно
                      </span>
                    </label>
                    <Textarea
                      id="expert-data"
                      value={dataset}
                      onChange={(event) => setDataset(event.target.value)}
                      maxLength={11900}
                      placeholder="Вставьте таблицу, числа или исходные факты. Вопрос задайте ниже."
                      className="min-h-24 max-h-64 resize-y"
                    />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Один запуск — три экспертных запроса и один итоговый. Каждый
                    учитывается в расходе.
                  </p>
                  <details className="text-sm">
                    <summary className="cursor-pointer text-primary">
                      Посмотреть промпты ролей
                    </summary>
                    <div className="mt-3 space-y-4 leading-6">
                      {EXPERT_ROLES.map((role) => (
                        <div key={role.id}>
                          <h3 className="font-semibold">{role.title}</h3>
                          <p className="mt-1 text-muted-foreground">
                            {role.prompt}
                          </p>
                        </div>
                      ))}
                      <div>
                        <h3 className="font-semibold">Главный ассистент</h3>
                        <p className="mt-1 text-muted-foreground">
                          {SYNTHESIS_PROMPT}
                        </p>
                      </div>
                      <p className="text-muted-foreground">
                        В каждый запрос добавляются общая системная инструкция,
                        выбранная тема, текущие параметры ответа и исходный
                        контекст.
                      </p>
                    </div>
                  </details>
                </fieldset>
              )}
                </section>

                {metrics.length > 0 && (
                  <div className="mt-4">
                    <AggregateMetricsView
                      metrics={metrics}
                      label="За весь диалог"
                    />
                  </div>
                )}
                <div className="flex flex-1 flex-col">
              {!chat.messages.length ? (
                <div className="flex flex-1 items-center justify-center py-14 lg:py-6">
                  <div className="max-w-lg text-center">
                    <Bot className="mx-auto mb-5 size-10 text-primary" />
                    <h1 className="text-3xl font-semibold tracking-tight">
                      Какую задачу решим?
                    </h1>
                    <p className="mt-3 text-base leading-7 text-muted-foreground">
                      Задайте вопрос в чате или включите группу экспертов, чтобы
                      сравнить три подхода.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-6 py-6">
                  {chat.messages.map((message) => (
                    <Fragment key={message.id}>
                      <article
                        className={`flex items-start gap-3 ${message.role === 'user' ? 'justify-end' : ''}`}
                      >
                        {message.role === 'assistant' && (
                          <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary">
                            <Bot className="size-4" aria-hidden="true" />
                          </div>
                        )}
                        <div
                          className={
                            message.role === 'user'
                              ? 'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-primary px-4 py-3 text-base leading-7 text-primary-foreground'
                              : 'min-w-0 flex-1 pt-1 text-base leading-7'
                          }
                        >
                          <div className="whitespace-pre-wrap break-words">
                            {message.content ||
                              (message.metrics?.status === 'running'
                                ? 'Ожидаем первые токены…'
                                : 'Ответ не получен.')}
                          </div>
                          {message.finishReason === 'length' && (
                            <p className="mt-3 text-sm text-amber-200">
                              Ответ обрезан по лимиту токенов. Увеличьте лимит и
                              повторите запрос.
                            </p>
                          )}
                          {message.error && (
                            <p className="mt-3 text-sm text-amber-200">
                              {message.error}
                            </p>
                          )}
                          {message.metrics && (
                            <div className="mt-4">
                              <RequestMetricsView
                                metrics={message.metrics}
                                label="Главный ассистент"
                              />
                            </div>
                          )}
                        </div>
                        {message.role === 'user' && (
                          <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/5 text-muted-foreground">
                            <User className="size-4" aria-hidden="true" />
                          </div>
                        )}
                      </article>
                      {message.runId &&
                        chat.runs.find((run) => run.id === message.runId) && (
                          <ExpertPanel
                            run={chat.runs.find(
                              (run) => run.id === message.runId,
                            )!}
                          />
                        )}
                    </Fragment>
                  ))}
                  {chat.isSending && (
                    <output className="flex items-center gap-3 text-sm text-muted-foreground">
                      <LoaderCircle
                        className="size-4 animate-spin"
                        aria-hidden="true"
                      />
                      {chat.phase}
                    </output>
                  )}
                  <div ref={endRef} />
                </div>
              )}

                </div>
              </div>
            </div>

            <form
              className="mt-5 shrink-0 bg-background/95 pb-4 pt-3 backdrop-blur-xl sm:pb-7"
              onSubmit={submit}
            >
                {chat.error && (
                  <div
                    role="alert"
                    className="mb-3 flex items-start gap-2 rounded-2xl border border-destructive/35 bg-destructive/10 px-4 py-3 text-sm text-red-200"
                  >
                    <AlertCircle
                      className="mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span>{chat.error}</span>
                  </div>
                )}
                <div className="rounded-[1.7rem] border border-white/10 bg-card/95 p-2 shadow-[0_24px_80px_rgba(0,0,0,0.38)]">
                  <Textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={keyDown}
                    disabled={chat.isSending}
                    maxLength={12000}
                    aria-label="Сообщение"
                    placeholder={
                      council
                        ? 'Задача для трёх экспертов…'
                        : 'Напишите сообщение…'
                    }
                    className="min-h-24 resize-none border-0 bg-transparent px-4 py-3 text-base shadow-none focus-visible:ring-0"
                  />
                  <div className="flex items-center justify-between gap-3 px-2 pb-1">
                    <span className="pl-2 text-xs text-muted-foreground">
                      Enter — отправить · Shift+Enter — новая строка
                    </span>
                    {chat.isSending ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={chat.stop}
                        className="h-11 shrink-0 rounded-2xl"
                      >
                        <Square className="size-4" />
                        Остановить
                      </Button>
                    ) : (
                      <Button
                        type="submit"
                        className="h-11 shrink-0 rounded-2xl"
                        aria-label={
                          council ? 'Запустить трёх экспертов' : 'Отправить'
                        }
                        disabled={
                          !draft.trim() ||
                          Boolean(invalid) ||
                          (council && !topic.trim())
                        }
                      >
                        <ArrowUp className="size-5" />
                        {council && (
                          <span className="hidden sm:inline">
                            Запустить экспертов
                          </span>
                        )}
                      </Button>
                    )}
                  </div>
                </div>
                <p className="mt-3 text-center text-xs text-muted-foreground">
                  Модель может ошибаться — проверяйте важную информацию.
                </p>
            </form>
          </section>
          <ResponseSettingsPanel
            agentName={chat.agent.name}
            onAgentNameChange={chat.setAgentName}
            settings={chat.settings}
            onChange={chat.setSettings}
            isSending={chat.isSending}
            canRepeat={chat.lastRequest !== null}
            onRepeat={() => {
              followOutput.current = true;
              void chat
                .repeat()
                .catch((caught) =>
                  !(caught instanceof AcceptedChatError) && chat.setError(
                    caught instanceof Error ? caught.message : 'Не удалось повторить запрос.',
                  ),
                );
            }}
            requestJson={chat.requestJson}
          />
        </div>
      </div>
    </main>
  );
}

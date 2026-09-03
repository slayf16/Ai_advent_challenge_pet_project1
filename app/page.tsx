'use client';

import { KeyboardEvent, SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowUp, Bot, LoaderCircle, Plus, Sparkles, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
};

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

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isSending]);

  const sendMessage = useCallback(
    async (rawPrompt: string) => {
      const prompt = rawPrompt.trim();
      if (!prompt) throw new Error('Введите сообщение.');
      if (sendingRef.current) throw new Error('Дождитесь текущего ответа.');

      const userMessage: ChatMessage = { id: makeId(), role: 'user', content: prompt };
      const requestMessages = [...messages, userMessage].map(({ role, content }) => ({ role, content }));

      sendingRef.current = true;
      setIsSending(true);
      setError(null);
      setMessages((current) => [...current, userMessage]);

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: requestMessages }),
        });

        const data = (await response.json()) as { message?: string; error?: string };
        if (!response.ok || !data.message) {
          throw new Error(data.error || 'Не удалось получить ответ от DeepSeek.');
        }

        const assistantMessage: ChatMessage = {
          id: makeId(),
          role: 'assistant',
          content: data.message,
        };
        setMessages((current) => [...current, assistantMessage]);
        return data.message;
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Произошла неизвестная ошибка.';
        setError(message);
        throw caught;
      } finally {
        sendingRef.current = false;
        setIsSending(false);
      }
    },
    [messages],
  );

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;

    const lifecycle = new AbortController();
    void Promise.resolve(
      context.registerTool(
        {
          name: 'send_deepseek_message',
          title: 'Отправить сообщение в DeepSeek',
          description: 'Отправляет текст в текущий диалог с DeepSeek и показывает ответ в интерфейсе.',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', minLength: 1, maxLength: 12000 },
            },
            required: ['message'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          async execute(input) {
            const message = (input as { message?: unknown })?.message;
            if (typeof message !== 'string' || !message.trim()) {
              throw new Error('Поле message должно содержать непустую строку.');
            }
            const answer = await sendMessage(message);
            return { status: 'completed', answer };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);

    return () => lifecycle.abort();
  }, [sendMessage]);

  const submit = async (event?: SyntheticEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const prompt = draft;
    if (!prompt.trim() || isSending) return;
    setDraft('');
    try {
      await sendMessage(prompt);
    } catch {
      setDraft(prompt);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const resetChat = () => {
    if (isSending) return;
    setMessages([]);
    setDraft('');
    setError(null);
  };

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 sm:px-6">
        <header className="flex h-20 shrink-0 items-center justify-between border-b border-white/8">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-[0_0_30px_color-mix(in_oklab,var(--primary)_32%,transparent)]">
              <Sparkles className="size-5" aria-hidden="true" />
            </div>
            <div>
              <p className="font-semibold tracking-tight">DeepChat</p>
              <p className="text-xs text-muted-foreground">DeepSeek V4 Flash</p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            className="rounded-xl border-white/10 bg-white/4"
            onClick={resetChat}
            disabled={isSending || messages.length === 0}
          >
            <Plus className="size-4" />
            <span className="hidden sm:inline">Новый диалог</span>
          </Button>
        </header>

        <section className="flex flex-1 flex-col py-6 sm:py-10" aria-label="Диалог с DeepSeek">
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
            {messages.length === 0 ? (
              <div className="flex flex-1 items-center justify-center py-12">
                <div className="max-w-lg text-center">
                  <div className="mx-auto mb-6 grid size-16 place-items-center rounded-[1.4rem] border border-primary/25 bg-primary/10 text-primary">
                    <Bot className="size-8" aria-hidden="true" />
                  </div>
                  <h1 className="text-balance text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
                    О чём поговорим?
                  </h1>
                  <p className="mx-auto mt-3 max-w-md text-pretty text-base leading-7 text-muted-foreground">
                    Задайте вопрос, попросите объяснить сложную тему или помочь с идеей.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex-1 space-y-7 py-4 sm:py-8" aria-live="polite">
                {messages.map((message) => (
                  <article
                    key={message.id}
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
                          ? 'max-w-[85%] rounded-2xl rounded-tr-md bg-primary px-4 py-3 text-[0.98rem] leading-7 text-primary-foreground sm:max-w-[75%]'
                          : 'max-w-[calc(100%-3rem)] whitespace-pre-wrap pt-1 text-[0.98rem] leading-7 text-foreground'
                      }
                    >
                      {message.content}
                    </div>
                    {message.role === 'user' && (
                      <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/5 text-muted-foreground">
                        <User className="size-4" aria-hidden="true" />
                      </div>
                    )}
                  </article>
                ))}
                {isSending && (
                  <div className="flex items-center gap-3 text-muted-foreground">
                    <div className="grid size-9 place-items-center rounded-xl bg-primary/15 text-primary">
                      <Bot className="size-4" aria-hidden="true" />
                    </div>
                    <LoaderCircle className="size-5 animate-spin" aria-label="DeepSeek отвечает" />
                  </div>
                )}
                <div ref={endRef} />
              </div>
            )}

            <form className="sticky bottom-0 pb-4 pt-3 sm:pb-7" onSubmit={submit}>
              {error && (
                <div role="alert" className="mb-3 flex items-start gap-2 rounded-2xl border border-destructive/35 bg-destructive/10 px-4 py-3 text-sm text-red-200">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}
              <div className="rounded-[1.7rem] border border-white/10 bg-card/95 p-2 shadow-[0_24px_80px_rgba(0,0,0,0.38)] backdrop-blur-xl">
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={isSending}
                  maxLength={12000}
                  aria-label="Сообщение"
                  placeholder="Напишите сообщение…"
                  className="min-h-24 resize-none border-0 bg-transparent px-4 py-3 text-base shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
                />
                <div className="flex items-center justify-between gap-3 px-2 pb-1">
                  <span className="pl-2 text-xs text-muted-foreground">Enter — отправить · Shift+Enter — новая строка</span>
                  <Button
                    type="submit"
                    size="icon"
                    className="size-11 shrink-0 rounded-2xl"
                    aria-label="Отправить"
                    disabled={!draft.trim() || isSending}
                  >
                    {isSending ? <LoaderCircle className="size-5 animate-spin" /> : <ArrowUp className="size-5" />}
                  </Button>
                </div>
              </div>
              <p className="mt-3 text-center text-xs text-muted-foreground">
                DeepSeek может ошибаться — проверяйте важную информацию.
              </p>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}

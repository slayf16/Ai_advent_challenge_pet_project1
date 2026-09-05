'use client';

import { LoaderCircle } from 'lucide-react';
import { RequestMetricsView } from '@/components/request-metrics';
import { EXPERT_ROLES } from '@/lib/experts';
import type { ExpertRun } from '@/hooks/use-chat';

export function ExpertPanel({ run }: { run: ExpertRun }) {
  return (
    <section
      className="my-5 min-w-0 space-y-3"
      aria-label={`Ответы экспертов: ${run.topic}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">
          Группа экспертов · {run.topic}
        </h2>
        <span className="text-sm text-muted-foreground">
          Три независимых взгляда одной модели
        </span>
      </div>
      {run.dataset && (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">Данные для анализа</summary>
          <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words font-sans">
            {run.dataset}
          </pre>
        </details>
      )}
      <div className="grid min-w-0 gap-3 xl:grid-cols-3">
        {run.experts.map((expert) => {
          const role = EXPERT_ROLES.find((item) => item.id === expert.id)!;
          return (
            <article
              key={expert.id}
              className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-card/60"
            >
              <header className="flex items-start justify-between gap-2 border-b border-white/8 p-4">
                <div>
                  <h3 className="font-semibold">{role.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {role.description}
                  </p>
                </div>
                {expert.status === 'running' ? (
                  <LoaderCircle
                    className="mt-1 size-4 shrink-0 animate-spin text-primary"
                    aria-label="Отвечает"
                  />
                ) : (
                  <span
                    className={`text-xs ${expert.status === 'complete' ? 'text-emerald-300' : 'text-amber-200'}`}
                  >
                    {expert.status === 'complete'
                      ? 'Готово'
                      : expert.status === 'cancelled'
                        ? 'Остановлен'
                        : 'Ошибка'}
                  </span>
                )}
              </header>
              <section
                className="min-h-36 max-h-[32rem] flex-1 overflow-y-auto whitespace-pre-wrap break-words p-4 text-base leading-7"
                aria-label={`Ответ: ${role.title}`}
              >
                {expert.content || (
                  <span className="text-muted-foreground">
                    {expert.status === 'running'
                      ? 'Ожидаем первые токены…'
                      : 'Ответ не получен.'}
                  </span>
                )}
                {expert.finishReason === 'length' && (
                  <p className="mt-3 text-sm text-amber-200">
                    Ответ обрезан по лимиту токенов.
                  </p>
                )}
                {expert.error && (
                  <p role="alert" className="mt-3 text-sm text-amber-200">
                    {expert.error}
                  </p>
                )}
              </section>
              <div className="space-y-3 border-t border-white/8 p-4">
                <RequestMetricsView
                  metrics={expert.metrics}
                  label={role.title}
                />
                {expert.requestJson && (
                  <details className="text-sm text-muted-foreground">
                    <summary className="cursor-pointer">JSON запроса</summary>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
                      {JSON.stringify(JSON.parse(expert.requestJson), null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

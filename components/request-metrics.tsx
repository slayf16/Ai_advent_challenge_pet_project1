'use client';

import { useEffect, useState } from 'react';
import {
  aggregateMetrics,
  DEEPSEEK_V4_FLASH_PRICING,
  metricsSnapshot,
  type CostEstimate,
  type RequestMetrics,
} from '@/lib/chat-metrics';

const STATUS_LABEL: Record<RequestMetrics['status'], string> = {
  running: 'Выполняется',
  complete: 'Завершён',
  error: 'Ошибка',
  cancelled: 'Отменён',
};

function useClock(live: boolean) {
  const [clock, setClock] = useState(() => ({
    performanceMs: performance.now(),
    epochMs: Date.now(),
  }));

  useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval(
      () => setClock({ performanceMs: performance.now(), epochMs: Date.now() }),
      100,
    );
    return () => window.clearInterval(timer);
  }, [live]);

  return clock;
}

const formatDuration = (milliseconds: number) => {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} мс`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 2 : 1)} с`;
};

const formatUsd = (value: number) =>
  `$${value.toLocaleString('en-US', {
    minimumFractionDigits: value === 0 ? 2 : 6,
    maximumFractionDigits: 8,
  })}`;

function formatCost(cost: CostEstimate) {
  return cost.exact
    ? formatUsd(cost.minimumUsd)
    : `${formatUsd(cost.minimumUsd)}–${formatUsd(cost.maximumUsd)}`;
}

const tokenValue = (value: number | undefined) =>
  value === undefined ? 'Нет данных' : value.toLocaleString('ru-RU');

export function RequestMetricsView({
  metrics,
  label = 'Метрики запроса',
}: {
  metrics: RequestMetrics;
  label?: string;
}) {
  const clock = useClock(metrics.status === 'running');
  const snapshot = metricsSnapshot(metrics, clock.performanceMs, clock.epochMs);
  const usage = metrics.usage;
  const isTerminal = metrics.status !== 'running';

  return (
    <section
      className="rounded-2xl border border-white/10 bg-card/70 p-4"
      aria-label={label}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{label}</h3>
        <span className="rounded-full bg-white/6 px-2.5 py-1 text-xs text-muted-foreground">
          {STATUS_LABEL[metrics.status]}
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <Metric label="Время" value={formatDuration(snapshot.durationMs)} />
        <Metric
          label="До первого токена"
          value={
            snapshot.ttftMs === null
              ? metrics.status === 'running'
                ? 'Ожидание…'
                : 'Нет данных'
              : formatDuration(snapshot.ttftMs)
          }
        />
        <Metric
          label="Средняя скорость"
          value={
            snapshot.averageTokensPerSecond === null
              ? usage
                ? 'Нет данных'
                : isTerminal
                  ? 'Нет данных'
                  : 'Ожидание usage…'
              : `${snapshot.averageTokensPerSecond.toFixed(1)} токен/с`
          }
        />
        <Metric
          label="Стоимость"
          value={
            snapshot.cost
              ? formatCost(snapshot.cost)
              : usage
                ? 'Недоступно'
                : isTerminal
                  ? 'Нет данных'
                  : 'Ожидание usage…'
          }
        />
        <Metric
          label="Всего токенов"
          value={
            usage?.total_tokens === undefined
              ? isTerminal
                ? 'Нет данных'
                : 'Ожидание usage…'
              : tokenValue(usage.total_tokens)
          }
        />
      </dl>

      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        Скорость — выходные токены за полное время запроса; это включает
        ожидание и скрытое рассуждение до первого фрагмента.
      </p>

      <details className="mt-3 rounded-xl border border-white/8 bg-black/10 px-3 py-2 text-sm">
        <summary className="cursor-pointer select-none font-medium">
          Токены и расчёт стоимости
        </summary>
        {usage ? (
          <div className="mt-3 space-y-3 text-muted-foreground">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
              <Metric label="Входные" value={tokenValue(usage.prompt_tokens)} />
              <Metric
                label="Cache hit"
                value={tokenValue(usage.prompt_cache_hit_tokens)}
              />
              <Metric
                label="Cache miss"
                value={tokenValue(usage.prompt_cache_miss_tokens)}
              />
              <Metric
                label="Выходные"
                value={tokenValue(usage.completion_tokens)}
              />
              <Metric
                label="Из них reasoning"
                value={tokenValue(
                  usage.completion_tokens_details?.reasoning_tokens,
                )}
              />
              <Metric label="Всего" value={tokenValue(usage.total_tokens)} />
            </dl>
            {snapshot.cost && (
              <div className="space-y-1 border-t border-white/8 pt-3 text-xs leading-5">
                <p>
                  Тариф:{' '}
                  {snapshot.cost.tier === 'peak' ? 'пиковый' : 'внепиковый'}.
                  Cache hit × $
                  {
                    DEEPSEEK_V4_FLASH_PRICING[
                      snapshot.cost.tier === 'peak' ? 'peak' : 'offPeak'
                    ].cacheHitInput
                  }
                  /1M + cache miss × $
                  {
                    DEEPSEEK_V4_FLASH_PRICING[
                      snapshot.cost.tier === 'peak' ? 'peak' : 'offPeak'
                    ].cacheMissInput
                  }
                  /1M + output × $
                  {
                    DEEPSEEK_V4_FLASH_PRICING[
                      snapshot.cost.tier === 'peak' ? 'peak' : 'offPeak'
                    ].output
                  }
                  /1M.
                </p>
                {!snapshot.cost.exact && (
                  <p>
                    API не передал cache hit/miss, поэтому показан диапазон от
                    полного попадания до полного промаха кеша.
                  </p>
                )}
                <p>
                  Тариф проверен {DEEPSEEK_V4_FLASH_PRICING.verifiedAt}.{' '}
                  <a
                    className="text-primary underline underline-offset-2"
                    href={DEEPSEEK_V4_FLASH_PRICING.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Официальные цены DeepSeek
                  </a>
                </p>
              </div>
            )}
          </div>
        ) : (
          <p className="mt-3 text-sm leading-5 text-muted-foreground">
            {isTerminal
              ? 'API не передал итоговую статистику usage для этого запроса.'
              : 'Точные токены появятся после финального события usage. Они не оцениваются по текстовым фрагментам.'}
          </p>
        )}
      </details>
    </section>
  );
}

export function AggregateMetricsView({
  metrics,
  label = 'Весь запуск',
}: {
  metrics: RequestMetrics[];
  label?: string;
}) {
  const live = metrics.some((item) => item.status === 'running');
  const clock = useClock(live);
  const aggregate = aggregateMetrics(
    metrics,
    clock.performanceMs,
    clock.epochMs,
  );

  if (metrics.length === 0) return null;

  const cost =
    aggregate.minimumCostUsd === null || aggregate.maximumCostUsd === null
      ? 'Ожидание usage…'
      : aggregate.exactCost
        ? formatUsd(aggregate.minimumCostUsd)
        : `${formatUsd(aggregate.minimumCostUsd)}–${formatUsd(aggregate.maximumCostUsd)}`;
  const resolvedCost =
    aggregate.minimumCostUsd === null && !live ? 'Нет данных' : cost;

  return (
    <section
      className="rounded-2xl border border-primary/20 bg-primary/5 p-4"
      aria-label="Итоговые метрики запуска"
    >
      <h3 className="text-sm font-semibold">{label}</h3>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Metric
          label="Общее время"
          value={formatDuration(aggregate.wallTimeMs)}
        />
        <Metric
          label="Токены"
          value={
            aggregate.usage
              ? tokenValue(aggregate.usage.total_tokens)
              : live
                ? 'Ожидание…'
                : 'Нет данных'
          }
        />
        <Metric label="Стоимость" value={resolvedCost} />
        <Metric
          label="Получено usage"
          value={`${aggregate.usageCount} из ${aggregate.totalCount}`}
        />
      </dl>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        Общее время — от старта первого до завершения последнего запроса;
        параллельные интервалы не суммируются. Для метрик всего диалога это
        время включает паузы между запросами.
        {aggregate.isPartial &&
          ' Токены и стоимость пока частичные: учтены только ответы с финальным usage.'}
      </p>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words font-medium tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  );
}

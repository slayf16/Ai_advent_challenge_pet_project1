import { MODELS, type ChatModel } from './chat-request';
import type { TokenUsage } from './chat-stream';

export type PricingTier = 'off-peak' | 'peak';
export type PricingSnapshot = {
  model: ChatModel;
  tier: PricingTier;
  currency: 'USD';
  unitTokens: 1_000_000;
  cacheHitInput: number;
  cacheMissInput: number;
  output: number;
  verifiedAt: string;
  sourceUrl: string;
  legacyInferred?: true;
};
export type RequestMetrics = {
  requestId?: string;
  model?: ChatModel;
  pricingSnapshot?: PricingSnapshot;
  startedAt: number;
  firstTokenAt: number | null;
  endedAt: number | null;
  usage: TokenUsage | null;
  status: 'running' | 'complete' | 'error' | 'cancelled';
};

export const DEEPSEEK_V4_FLASH_PRICING = {
  model: 'deepseek-v4-flash',
  currency: 'USD',
  unitTokens: 1_000_000,
  verifiedAt: '2026-09-06',
  sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
  offPeak: { cacheHitInput: 0.007, cacheMissInput: 0.22, output: 0.66 },
  peak: { cacheHitInput: 0.014, cacheMissInput: 0.44, output: 1.32 },
} as const;
export const DEEPSEEK_V4_PRO_PRICING = {
  ...DEEPSEEK_V4_FLASH_PRICING,
  model: 'deepseek-v4-pro',
  offPeak: { cacheHitInput: 0.022, cacheMissInput: 0.66, output: 1.98 },
  peak: { cacheHitInput: 0.044, cacheMissInput: 1.32, output: 3.96 },
} as const;
export const LIQUID_FREE_PRICING = {
  ...DEEPSEEK_V4_FLASH_PRICING,
  model: 'liquid/lfm-2.5-2.6b:free',
  sourceUrl: 'https://openrouter.ai/liquid/lfm-2.5-2.6b:free',
  offPeak: { cacheHitInput: 0, cacheMissInput: 0, output: 0 },
  peak: { cacheHitInput: 0, cacheMissInput: 0, output: 0 },
} as const;
export const pricingForModel = (model?: ChatModel) =>
  model === 'liquid/lfm-2.5-2.6b:free'
    ? LIQUID_FREE_PRICING
    : model === 'deepseek-v4-pro'
      ? DEEPSEEK_V4_PRO_PRICING
      : DEEPSEEK_V4_FLASH_PRICING;
export function pricingTierAt(epochMs: number): PricingTier {
  const d = new Date(epochMs);
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) return 'off-peak';
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (m >= 60 && m < 240) || (m >= 360 && m < 600) ? 'peak' : 'off-peak';
}
export function pricingSnapshotForModel(
  model: ChatModel,
  startedAt: number,
  legacyInferred = false,
): PricingSnapshot {
  const table = pricingForModel(model);
  const tier = pricingTierAt(startedAt);
  const rates = table[tier === 'peak' ? 'peak' : 'offPeak'];
  return {
    model,
    tier,
    currency: 'USD',
    unitTokens: 1_000_000,
    ...rates,
    verifiedAt: table.verifiedAt,
    sourceUrl: table.sourceUrl,
    ...(legacyInferred ? { legacyInferred: true as const } : {}),
  };
}
const validModel = (value: unknown): value is ChatModel =>
  typeof value === 'string' && MODELS.some((model) => model.id === value);
const validUrl = (value: unknown) => {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};
export const normalizePricingSnapshot = (
  value: unknown,
): PricingSnapshot | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const v = value as Record<string, unknown>;
  const rates = ['cacheHitInput', 'cacheMissInput', 'output'];
  if (
    !validModel(v.model) ||
    (v.tier !== 'peak' && v.tier !== 'off-peak') ||
    v.currency !== 'USD' ||
    v.unitTokens !== 1_000_000 ||
    !rates.every(
      (key) =>
        typeof v[key] === 'number' && Number.isFinite(v[key]) && v[key] >= 0,
    ) ||
    Number(v.cacheHitInput) > Number(v.cacheMissInput) ||
    typeof v.verifiedAt !== 'string' ||
    !Number.isFinite(Date.parse(v.verifiedAt)) ||
    !validUrl(v.sourceUrl) ||
    (v.legacyInferred !== undefined && v.legacyInferred !== true)
  )
    return undefined;
  return {
    model: v.model,
    tier: v.tier,
    currency: 'USD',
    unitTokens: 1_000_000,
    cacheHitInput: v.cacheHitInput as number,
    cacheMissInput: v.cacheMissInput as number,
    output: v.output as number,
    verifiedAt: v.verifiedAt,
    sourceUrl: v.sourceUrl as string,
    ...(v.legacyInferred === true ? { legacyInferred: true } : {}),
  };
};
const nonNegative = (v: number | undefined) =>
  Number.isFinite(v) && v! >= 0 ? v! : 0;
const hasUsage = (
  u: TokenUsage | null,
): u is TokenUsage & {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} =>
  !!u &&
  [u.prompt_tokens, u.completion_tokens, u.total_tokens].every(
    (v) => Number.isInteger(v) && v! >= 0,
  ) &&
  u.total_tokens === u.prompt_tokens! + u.completion_tokens!;
function cacheBreakdown(usage: TokenUsage) {
  const hit = usage.prompt_cache_hit_tokens,
    miss = usage.prompt_cache_miss_tokens;
  return Number.isInteger(hit) &&
    hit! >= 0 &&
    Number.isInteger(miss) &&
    miss! >= 0 &&
    hit! + miss! === usage.prompt_tokens
    ? { hit: hit!, miss: miss! }
    : null;
}
export type CostEstimate = {
  exact: boolean;
  minimumUsd: number;
  maximumUsd: number;
  cacheHitInputUsd: number | null;
  cacheMissInputUsd: number | null;
  outputUsd: number;
  tier: PricingTier;
  snapshot: PricingSnapshot;
};
export function calculateCost(
  usage: TokenUsage | null,
  snapshotOrTier: PricingSnapshot | PricingTier,
  model?: ChatModel,
): CostEstimate | null {
  if (!hasUsage(usage)) return null;
  const snapshot =
    typeof snapshotOrTier === 'string'
      ? (() => {
          const table = pricingForModel(model);
          const rates = table[snapshotOrTier === 'peak' ? 'peak' : 'offPeak'];
          return {
            model: model ?? 'deepseek-v4-flash',
            tier: snapshotOrTier,
            currency: 'USD' as const,
            unitTokens: 1_000_000 as const,
            ...rates,
            verifiedAt: table.verifiedAt,
            sourceUrl: table.sourceUrl,
          };
        })()
      : snapshotOrTier;
  const outputUsd =
    (usage.completion_tokens * snapshot.output) / snapshot.unitTokens;
  if (
    snapshot.cacheHitInput === 0 &&
    snapshot.cacheMissInput === 0 &&
    snapshot.output === 0
  )
    return {
      exact: true,
      minimumUsd: 0,
      maximumUsd: 0,
      cacheHitInputUsd: 0,
      cacheMissInputUsd: 0,
      outputUsd: 0,
      tier: snapshot.tier,
      snapshot,
    };
  const cache = cacheBreakdown(usage);
  if (!cache)
    return {
      exact: false,
      minimumUsd:
        outputUsd +
        (usage.prompt_tokens * snapshot.cacheHitInput) / snapshot.unitTokens,
      maximumUsd:
        outputUsd +
        (usage.prompt_tokens * snapshot.cacheMissInput) / snapshot.unitTokens,
      cacheHitInputUsd: null,
      cacheMissInputUsd: null,
      outputUsd,
      tier: snapshot.tier,
      snapshot,
    };
  const cacheHitInputUsd =
      (cache.hit * snapshot.cacheHitInput) / snapshot.unitTokens,
    cacheMissInputUsd =
      (cache.miss * snapshot.cacheMissInput) / snapshot.unitTokens,
    total = cacheHitInputUsd + cacheMissInputUsd + outputUsd;
  return {
    exact: true,
    minimumUsd: total,
    maximumUsd: total,
    cacheHitInputUsd,
    cacheMissInputUsd,
    outputUsd,
    tier: snapshot.tier,
    snapshot,
  };
}
export function requestEpochMs(
  startedAt: number,
  nowPerformanceMs: number,
  nowEpochMs: number,
) {
  return nowEpochMs - nowPerformanceMs + startedAt;
}
export type MetricsSnapshot = {
  durationMs: number | null;
  ttftMs: number | null;
  averageTokensPerSecond: number | null;
  cost: CostEstimate | null;
};
const snapshotForMetrics = (m: RequestMetrics) => m.pricingSnapshot;
export function metricsSnapshot(
  metrics: RequestMetrics,
  performance: number,
  epoch: number,
): MetricsSnapshot {
  const epochClock = metrics.startedAt > 10_000_000_000,
    current = epochClock ? epoch : performance,
    durationMs = metrics.endedAt === null && metrics.status !== 'running' ? null : Math.max(0, (metrics.endedAt ?? current) - metrics.startedAt),
    ttftMs =
      metrics.firstTokenAt === null
        ? null
        : Math.max(0, metrics.firstTokenAt - metrics.startedAt);
  const pricingSnapshot = snapshotForMetrics(metrics);
  return {
    durationMs,
    ttftMs,
    averageTokensPerSecond:
      hasUsage(metrics.usage) && durationMs !== null && durationMs > 0
        ? metrics.usage.completion_tokens / (durationMs / 1000)
        : null,
    cost: pricingSnapshot
      ? calculateCost(metrics.usage, pricingSnapshot)
      : null,
  };
}
export type AggregateMetrics = {
  wallTimeMs: number;
  usage: TokenUsage | null;
  usageCount: number;
  costCount: number;
  totalCount: number;
  isPartial: boolean;
  minimumCostUsd: number | null;
  maximumCostUsd: number | null;
  exactCost: boolean;
};
export function aggregateMetrics(
  metrics: RequestMetrics[],
  performance: number,
  epoch: number,
): AggregateMetrics {
  if (!metrics.length)
    return {
      wallTimeMs: 0,
      usage: null,
      usageCount: 0,
      costCount: 0,
      totalCount: 0,
      isPartial: false,
      minimumCostUsd: null,
      maximumCostUsd: null,
      exactCost: false,
    };
  const intervals = metrics.map((m) => {
    const toEpoch = (v: number) =>
      m.startedAt > 10_000_000_000 ? v : requestEpochMs(v, performance, epoch);
    return {
      start: toEpoch(m.startedAt),
      end: toEpoch(
        m.endedAt ?? (m.startedAt > 10_000_000_000 ? epoch : performance),
      ),
    };
  });
  const known = metrics.filter(
    (
      m,
    ): m is RequestMetrics & {
      usage: TokenUsage & {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    } => hasUsage(m.usage),
  );
  const usage = known.length
    ? known.reduce<TokenUsage>(
        (total, item) => ({
          prompt_tokens:
            nonNegative(total.prompt_tokens) + item.usage.prompt_tokens,
          completion_tokens:
            nonNegative(total.completion_tokens) + item.usage.completion_tokens,
          total_tokens:
            nonNegative(total.total_tokens) + item.usage.total_tokens,
          prompt_cache_hit_tokens:
            nonNegative(total.prompt_cache_hit_tokens) +
            nonNegative(item.usage.prompt_cache_hit_tokens),
          prompt_cache_miss_tokens:
            nonNegative(total.prompt_cache_miss_tokens) +
            nonNegative(item.usage.prompt_cache_miss_tokens),
          completion_tokens_details: {
            reasoning_tokens:
              nonNegative(total.completion_tokens_details?.reasoning_tokens) +
              nonNegative(
                item.usage.completion_tokens_details?.reasoning_tokens,
              ),
          },
        }),
        {},
      )
    : null;
  const costs = known
    .map((m) => metricsSnapshot(m, performance, epoch).cost)
    .filter((cost): cost is CostEstimate => cost !== null);
  return {
    wallTimeMs: Math.max(
      0,
      Math.max(...intervals.map((i) => i.end)) -
        Math.min(...intervals.map((i) => i.start)),
    ),
    usage,
    usageCount: known.length,
    costCount: costs.length,
    totalCount: metrics.length,
    isPartial: known.length !== metrics.length || costs.length !== known.length,
    minimumCostUsd: costs.length
      ? costs.reduce((s, c) => s + c.minimumUsd, 0)
      : null,
    maximumCostUsd: costs.length
      ? costs.reduce((s, c) => s + c.maximumUsd, 0)
      : null,
    exactCost: costs.length === metrics.length && costs.every((c) => c.exact),
  };
}

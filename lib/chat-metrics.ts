import type { ChatModel } from './chat-request';
import type { TokenUsage } from './chat-stream';

export type RequestMetrics = {
  model?: ChatModel;
  startedAt: number;
  firstTokenAt: number | null;
  endedAt: number | null;
  usage: TokenUsage | null;
  status: 'running' | 'complete' | 'error' | 'cancelled';
};

export type PricingTier = 'off-peak' | 'peak';

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

export type CostEstimate = {
  exact: boolean;
  minimumUsd: number;
  maximumUsd: number;
  cacheHitInputUsd: number | null;
  cacheMissInputUsd: number | null;
  outputUsd: number;
  tier: PricingTier;
};

export type MetricsSnapshot = {
  durationMs: number;
  ttftMs: number | null;
  averageTokensPerSecond: number | null;
  cost: CostEstimate | null;
};

export type AggregateMetrics = {
  wallTimeMs: number;
  usage: TokenUsage | null;
  usageCount: number;
  totalCount: number;
  isPartial: boolean;
  minimumCostUsd: number | null;
  maximumCostUsd: number | null;
  exactCost: boolean;
};

const nonNegative = (value: number | undefined) =>
  Number.isFinite(value) && value! >= 0 ? value! : 0;

const hasCoreUsage = (
  usage: TokenUsage | null,
): usage is TokenUsage & {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} =>
  usage !== null &&
  Number.isInteger(usage.prompt_tokens) &&
  usage.prompt_tokens! >= 0 &&
  Number.isInteger(usage.completion_tokens) &&
  usage.completion_tokens! >= 0 &&
  Number.isInteger(usage.total_tokens) &&
  usage.total_tokens! >= 0;

export function requestEpochMs(
  startedAt: number,
  nowPerformanceMs: number,
  nowEpochMs: number,
) {
  return nowEpochMs - nowPerformanceMs + startedAt;
}

export function pricingTierAt(epochMs: number): PricingTier {
  const date = new Date(epochMs);
  if (date.getUTCDay() === 0 || date.getUTCDay() === 6) return 'off-peak';
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const isPeak =
    (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600);
  return isPeak ? 'peak' : 'off-peak';
}

function cacheBreakdown(usage: TokenUsage) {
  const prompt = nonNegative(usage.prompt_tokens);
  const suppliedHit = usage.prompt_cache_hit_tokens;
  const suppliedMiss = usage.prompt_cache_miss_tokens;
  if (
    !Number.isInteger(suppliedHit) ||
    suppliedHit! < 0 ||
    !Number.isInteger(suppliedMiss) ||
    suppliedMiss! < 0 ||
    suppliedHit! + suppliedMiss! !== prompt
  ) {
    return null;
  }
  return { hit: suppliedHit!, miss: suppliedMiss! };
}

export function calculateCost(
  usage: TokenUsage | null,
  tier: PricingTier,
  model?: ChatModel,
): CostEstimate | null {
  if (!hasCoreUsage(usage)) return null;
  const rates = pricingForModel(model)[tier === 'peak' ? 'peak' : 'offPeak'];
  const unit = DEEPSEEK_V4_FLASH_PRICING.unitTokens;
  const outputUsd =
    (nonNegative(usage.completion_tokens) * rates.output) / unit;
  if (model === 'liquid/lfm-2.5-2.6b:free') {
    return {
      exact: true,
      minimumUsd: 0,
      maximumUsd: 0,
      cacheHitInputUsd: 0,
      cacheMissInputUsd: 0,
      outputUsd: 0,
      tier: 'off-peak',
    };
  }
  const cache = cacheBreakdown(usage);

  if (!cache) {
    const prompt = nonNegative(usage.prompt_tokens);
    return {
      exact: false,
      minimumUsd: outputUsd + (prompt * rates.cacheHitInput) / unit,
      maximumUsd: outputUsd + (prompt * rates.cacheMissInput) / unit,
      cacheHitInputUsd: null,
      cacheMissInputUsd: null,
      outputUsd,
      tier,
    };
  }

  const cacheHitInputUsd = (cache.hit * rates.cacheHitInput) / unit;
  const cacheMissInputUsd = (cache.miss * rates.cacheMissInput) / unit;
  const total = cacheHitInputUsd + cacheMissInputUsd + outputUsd;
  return {
    exact: true,
    minimumUsd: total,
    maximumUsd: total,
    cacheHitInputUsd,
    cacheMissInputUsd,
    outputUsd,
    tier,
  };
}

export function metricsSnapshot(
  metrics: RequestMetrics,
  nowPerformanceMs: number,
  nowEpochMs: number,
): MetricsSnapshot {
  const end = metrics.endedAt ?? nowPerformanceMs;
  const durationMs = Math.max(0, end - metrics.startedAt);
  const ttftMs =
    metrics.firstTokenAt === null
      ? null
      : Math.max(0, metrics.firstTokenAt - metrics.startedAt);
  const completionTokens = metrics.usage?.completion_tokens;
  const averageTokensPerSecond =
    completionTokens !== undefined && durationMs > 0
      ? completionTokens / (durationMs / 1000)
      : null;
  const tier = pricingTierAt(
    requestEpochMs(metrics.startedAt, nowPerformanceMs, nowEpochMs),
  );
  return {
    durationMs,
    ttftMs,
    averageTokensPerSecond,
    cost: calculateCost(metrics.usage, tier, metrics.model),
  };
}

export function aggregateMetrics(
  metrics: RequestMetrics[],
  nowPerformanceMs: number,
  nowEpochMs: number,
): AggregateMetrics {
  if (metrics.length === 0) {
    return {
      wallTimeMs: 0,
      usage: null,
      usageCount: 0,
      totalCount: 0,
      isPartial: false,
      minimumCostUsd: null,
      maximumCostUsd: null,
      exactCost: false,
    };
  }

  const startedAt = Math.min(...metrics.map((item) => item.startedAt));
  const endedAt = Math.max(
    ...metrics.map((item) => item.endedAt ?? nowPerformanceMs),
  );
  const known = metrics.filter(
    (
      item,
    ): item is RequestMetrics & {
      usage: TokenUsage & {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    } => hasCoreUsage(item.usage),
  );
  const usage = known.length
    ? known.reduce<TokenUsage>(
        (total, item) => ({
          prompt_tokens:
            nonNegative(total.prompt_tokens) +
            nonNegative(item.usage.prompt_tokens),
          completion_tokens:
            nonNegative(total.completion_tokens) +
            nonNegative(item.usage.completion_tokens),
          total_tokens:
            nonNegative(total.total_tokens) +
            nonNegative(item.usage.total_tokens),
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
        {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      )
    : null;
  const costs = known.map(
    (item) => metricsSnapshot(item, nowPerformanceMs, nowEpochMs).cost!,
  );

  return {
    wallTimeMs: Math.max(0, endedAt - startedAt),
    usage,
    usageCount: known.length,
    totalCount: metrics.length,
    isPartial: known.length !== metrics.length,
    minimumCostUsd: costs.length
      ? costs.reduce((sum, cost) => sum + cost.minimumUsd, 0)
      : null,
    maximumCostUsd: costs.length
      ? costs.reduce((sum, cost) => sum + cost.maximumUsd, 0)
      : null,
    exactCost:
      costs.length === metrics.length && costs.every((cost) => cost.exact),
  };
}

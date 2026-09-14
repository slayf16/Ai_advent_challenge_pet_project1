import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const requestSource = await readFile(
  new URL('../lib/chat-request.ts', import.meta.url),
  'utf8',
);
const requestCompiled = ts.transpileModule(requestSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const requestUrl = `data:text/javascript;base64,${Buffer.from(requestCompiled).toString('base64')}`;
const source = (await readFile(
  new URL('../lib/chat-metrics.ts', import.meta.url),
  'utf8',
)).replace('./chat-request', requestUrl);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const metricsModule = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

const {
  aggregateMetrics,
  calculateCost,
  DEEPSEEK_V4_FLASH_PRICING,
  metricsSnapshot,
  normalizePricingSnapshot,
  pricingSnapshotForModel,
  pricingTierAt,
} = metricsModule;

test('usage without a saved price snapshot remains an unknown cost', () => {
  const snapshot = metricsSnapshot({ startedAt: 100, endedAt: 200, firstTokenAt: null, status: 'complete', usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 } }, 300, Date.now());
  assert.equal(snapshot.cost, null);
  const aggregate = aggregateMetrics([{ startedAt: 100, endedAt: 200, firstTokenAt: null, status: 'complete', usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 } }], 300, Date.now());
  assert.equal(aggregate.usageCount, 1);
  assert.equal(aggregate.costCount, 0);
  assert.equal(aggregate.isPartial, true);
});

test('aggregate speed uses only known completion and duration coverage', () => {
  const aggregate = aggregateMetrics([
    { startedAt: 0, firstTokenAt: null, endedAt: 1000, status: 'complete', usage: { prompt_tokens: 1, completion_tokens: 20, total_tokens: 21 } },
    { startedAt: 0, firstTokenAt: null, endedAt: null, status: 'cancelled', usage: { prompt_tokens: 1, completion_tokens: 999, total_tokens: 1000 } },
  ], 2_000, Date.now());
  assert.equal(aggregate.averageTokensPerSecond, 20);
  assert.equal(aggregate.speedCount, 1);
  assert.equal(aggregate.wallTimeMs, 1000, 'unknown terminal end must not grow with current clock');
});

test('partial usage keeps independent tokens and known output cost without inventing totals', () => {
  const snapshot = pricingSnapshotForModel('deepseek-v4-flash', 1_700_000_000_000);
  const aggregate = aggregateMetrics([
    { startedAt: 0, firstTokenAt: null, endedAt: 1000, status: 'complete', pricingSnapshot: snapshot, usage: { completion_tokens: 42 } },
    { startedAt: 0, firstTokenAt: null, endedAt: 1000, status: 'complete', pricingSnapshot: snapshot, usage: { prompt_tokens: 9 } },
  ], 1000, Date.now());
  assert.equal(aggregate.usage.completion_tokens, 42);
  assert.equal(aggregate.usage.prompt_tokens, 9);
  assert.equal(aggregate.usage.total_tokens, undefined, 'components from distinct physical calls never imply a total');
  assert.equal(aggregate.completionCount, 1);
  assert.equal(aggregate.promptCount, 1);
  assert.equal(aggregate.totalTokenCount, 0);
  assert.ok(aggregate.minimumCostUsd > 0, 'known output and input parts retain their known price');
  assert.equal(aggregate.isPartial, true);
});

test('pricing snapshot normalization rejects unsafe persisted values', () => {
  assert.equal(normalizePricingSnapshot({ model: 'not-a-model', tier: 'peak', currency: 'USD', unitTokens: 1_000_000, cacheHitInput: -50, cacheMissInput: 1, output: 1, verifiedAt: '2026-09-06', sourceUrl: 'https://example.com' }), undefined);
});

test('official V4 Flash rates and UTC peak windows are represented exactly', () => {
  assert.deepEqual(DEEPSEEK_V4_FLASH_PRICING.offPeak, {
    cacheHitInput: 0.007,
    cacheMissInput: 0.22,
    output: 0.66,
  });
  assert.deepEqual(DEEPSEEK_V4_FLASH_PRICING.peak, {
    cacheHitInput: 0.014,
    cacheMissInput: 0.44,
    output: 1.32,
  });
  assert.equal(pricingTierAt(Date.UTC(2026, 8, 4, 0, 59)), 'off-peak');
  assert.equal(pricingTierAt(Date.UTC(2026, 8, 4, 1, 0)), 'peak');
  assert.equal(pricingTierAt(Date.UTC(2026, 8, 4, 4, 0)), 'off-peak');
  assert.equal(pricingTierAt(Date.UTC(2026, 8, 4, 6, 0)), 'peak');
  assert.equal(pricingTierAt(Date.UTC(2026, 8, 4, 10, 0)), 'off-peak');
});

test('cost uses cache hit, cache miss and output token prices', () => {
  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
    prompt_cache_hit_tokens: 400,
    prompt_cache_miss_tokens: 600,
  };
  const offPeak = calculateCost(usage, 'off-peak');
  assert.equal(offPeak.exact, true);
  assert.ok(Math.abs(offPeak.minimumUsd - 0.0002668) < 1e-12);
  assert.equal(offPeak.minimumUsd, offPeak.maximumUsd);
  assert.equal(calculateCost(usage, 'peak').minimumUsd, offPeak.minimumUsd * 2);
});

test('missing cache counters produce an honest cost range and missing usage produces no cost', () => {
  const estimate = calculateCost(
    { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
    'off-peak',
  );
  assert.equal(estimate.exact, false);
  assert.ok(Math.abs(estimate.minimumUsd - 0.000139) < 1e-12);
  assert.ok(Math.abs(estimate.maximumUsd - 0.000352) < 1e-12);
  assert.equal(estimate.cacheHitInputUsd, null);
  const inconsistent = calculateCost(
    {
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_cache_hit_tokens: 400,
      prompt_cache_miss_tokens: 500,
    },
    'off-peak',
  );
  assert.equal(inconsistent.exact, false);
  const fractional = calculateCost(
    {
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_cache_hit_tokens: 400.5,
      prompt_cache_miss_tokens: 599.5,
    },
    'off-peak',
  );
  assert.equal(fractional.exact, false);
  assert.equal(calculateCost(null, 'off-peak'), null);
  assert.ok(calculateCost({ prompt_tokens: 10 }, 'off-peak'), 'known input has a partial cost range');
});

test('speed uses full request duration while TTFT remains a separate metric', () => {
  const snapshot = metricsSnapshot(
    {
      startedAt: 100,
      firstTokenAt: 1100,
      endedAt: 4100,
      status: 'complete',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 80,
        total_tokens: 90,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 10,
      },
    },
    5000,
    Date.UTC(2026, 8, 4, 12),
  );
  assert.equal(snapshot.durationMs, 4000);
  assert.equal(snapshot.ttftMs, 1000);
  assert.equal(snapshot.averageTokensPerSecond, 20);
});

test('aggregate uses wall time and marks totals partial when any usage is missing', () => {
  const result = aggregateMetrics(
    [
      {
        pricingSnapshot: pricingSnapshotForModel('deepseek-v4-flash', Date.UTC(2026, 8, 4, 12)),
        startedAt: 100,
        firstTokenAt: 200,
        endedAt: 500,
        status: 'complete',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_cache_hit_tokens: 4,
          prompt_cache_miss_tokens: 6,
        },
      },
      {
        startedAt: 150,
        firstTokenAt: null,
        endedAt: null,
        status: 'running',
        usage: null,
      },
    ],
    700,
    Date.UTC(2026, 8, 4, 12),
  );
  assert.equal(result.wallTimeMs, 600);
  assert.equal(result.usage.total_tokens, 15);
  assert.equal(result.usageCount, 1);
  assert.equal(result.totalCount, 2);
  assert.equal(result.isPartial, true);
  assert.equal(result.exactCost, false);
  assert.ok(result.minimumCostUsd > 0);
});

test('an aggregate with terminal requests but no usage remains explicitly unknown', () => {
  const result = aggregateMetrics(
    [
      {
        startedAt: 100,
        firstTokenAt: null,
        endedAt: 300,
        status: 'error',
        usage: null,
      },
    ],
    500,
    Date.UTC(2026, 8, 4, 12),
  );
  assert.equal(result.wallTimeMs, 200);
  assert.equal(result.usage, null);
  assert.equal(result.minimumCostUsd, null);
  assert.equal(result.maximumCostUsd, null);
  assert.equal(result.isPartial, true);
});

test('weekends remain off-peak and Pro uses its own tariff in mixed history', () => {
  assert.equal(pricingTierAt(Date.UTC(2026, 8, 5, 1)), 'off-peak');
  assert.equal(pricingTierAt(Date.UTC(2026, 8, 6, 6)), 'off-peak');
  const usage = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200,
    prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600 };
  const pro = calculateCost(usage, 'off-peak', 'deepseek-v4-pro');
  assert.ok(Math.abs(pro.minimumUsd - 0.0008008) < 1e-12);
  assert.equal(calculateCost(usage, 'peak', 'deepseek-v4-pro').minimumUsd, pro.minimumUsd * 2);
  const metrics = { startedAt: 0, endedAt: 100, firstTokenAt: 10, status: 'complete', usage };
  const result = aggregateMetrics([
    { ...metrics, model: 'deepseek-v4-flash', pricingSnapshot: pricingSnapshotForModel('deepseek-v4-flash', Date.UTC(2026, 8, 6, 12)) }, { ...metrics, model: 'deepseek-v4-pro', pricingSnapshot: pricingSnapshotForModel('deepseek-v4-pro', Date.UTC(2026, 8, 6, 12)) },
  ], 100, Date.UTC(2026, 8, 6, 12));
  assert.ok(Math.abs(result.minimumCostUsd - (0.0002668 + 0.0008008)) < 1e-12);
});

test('free Liquid is exactly zero without cache counters and mixed totals keep paid costs', () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 };
  const cost = calculateCost(usage, 'peak', 'liquid/lfm-2.5-2.6b:free');
  assert.equal(cost.exact, true);
  assert.equal(cost.minimumUsd, 0);
  assert.equal(cost.maximumUsd, 0);
  const metrics = { startedAt: 0, endedAt: 100, firstTokenAt: 10, status: 'complete', usage };
  const mixed = aggregateMetrics([{ ...metrics, model: 'liquid/lfm-2.5-2.6b:free', pricingSnapshot: pricingSnapshotForModel('liquid/lfm-2.5-2.6b:free', Date.UTC(2026, 8, 6, 12)) },
    { ...metrics, model: 'deepseek-v4-pro', pricingSnapshot: pricingSnapshotForModel('deepseek-v4-pro', Date.UTC(2026, 8, 6, 12)) }], 100, Date.UTC(2026, 8, 6, 12));
  assert.equal(mixed.minimumCostUsd, calculateCost(usage, 'off-peak', 'deepseek-v4-pro').minimumUsd);
  assert.equal(mixed.usage.total_tokens, 2400);
  assert.equal(calculateCost(null, 'off-peak', 'liquid/lfm-2.5-2.6b:free'), null);
});

test('mixed legacy performance and persisted epoch clocks use normalized wall time', () => {
  const nowPerformance = 500;
  const nowEpoch = 1_700_000_000_500;
  const result = aggregateMetrics([
    { startedAt: 100, endedAt: 300, firstTokenAt: null, usage: null, status: 'complete' },
    { startedAt: 1_700_000_000_200, endedAt: 1_700_000_000_400, firstTokenAt: null, usage: null, status: 'complete' },
  ], nowPerformance, nowEpoch);
  assert.equal(result.wallTimeMs, 300);
});

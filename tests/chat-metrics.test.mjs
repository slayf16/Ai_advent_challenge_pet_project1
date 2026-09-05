import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(
  new URL('../lib/chat-metrics.ts', import.meta.url),
  'utf8',
);
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
  pricingTierAt,
} = metricsModule;

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
  assert.equal(pricingTierAt(Date.UTC(2026, 8, 5, 0, 59)), 'off-peak');
  assert.equal(pricingTierAt(Date.UTC(2026, 8, 5, 1, 0)), 'peak');
  assert.equal(pricingTierAt(Date.UTC(2026, 8, 5, 4, 0)), 'off-peak');
  assert.equal(pricingTierAt(Date.UTC(2026, 8, 5, 6, 0)), 'peak');
  assert.equal(pricingTierAt(Date.UTC(2026, 8, 5, 10, 0)), 'off-peak');
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
  assert.equal(calculateCost({ prompt_tokens: 10 }, 'off-peak'), null);
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
    Date.UTC(2026, 8, 5, 12),
  );
  assert.equal(snapshot.durationMs, 4000);
  assert.equal(snapshot.ttftMs, 1000);
  assert.equal(snapshot.averageTokensPerSecond, 20);
});

test('aggregate uses wall time and marks totals partial when any usage is missing', () => {
  const result = aggregateMetrics(
    [
      {
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
    Date.UTC(2026, 8, 5, 12),
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
    Date.UTC(2026, 8, 5, 12),
  );
  assert.equal(result.wallTimeMs, 200);
  assert.equal(result.usage, null);
  assert.equal(result.minimumCostUsd, null);
  assert.equal(result.maximumCostUsd, null);
  assert.equal(result.isPartial, true);
});

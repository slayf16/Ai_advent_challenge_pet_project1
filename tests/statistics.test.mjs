import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../lib/statistics.ts', import.meta.url), 'utf8');
const request = await readFile(new URL('../lib/chat-request.ts', import.meta.url), 'utf8');
const requestUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(request, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64')}`;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source.replace('./chat-request', requestUrl), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64')}`;
const { createStatisticsSnapshot, removeStatisticsSnapshot } = await import(moduleUrl);

test('statistics snapshots are immutable and removal cannot mutate their source chat data', () => {
  const metrics = [{ requestId: 'r', startedAt: 1, firstTokenAt: null, endedAt: 2, status: 'complete', usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }];
  const snapshot = createStatisticsSnapshot({ chatId: 'chat', chatName: 'Chat', agentId: 'agent', agentName: 'Agent', model: 'deepseek-v4-flash', metrics }, 'snapshot', 100);
  metrics[0].usage.prompt_tokens = 999;
  assert.equal(snapshot.metrics[0].usage.prompt_tokens, 2);
  assert.deepEqual(removeStatisticsSnapshot([snapshot], 'snapshot'), []);
  assert.equal(metrics[0].usage.prompt_tokens, 999);
});

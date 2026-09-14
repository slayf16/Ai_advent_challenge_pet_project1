import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const compile = async (path, replacements = {}) => {
  let source = await readFile(new URL(path, import.meta.url), 'utf8');
  for (const [from, to] of Object.entries(replacements)) source = source.replace(from, to);
  return `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64')}`;
};
const requestUrl = await compile('../lib/chat-request.ts');
const metricsUrl = await compile('../lib/chat-metrics.ts', { './chat-request': requestUrl });
const reactUrl = 'data:text/javascript,export const useState=(v)=>[typeof v===%22function%22?v():v,()=>{}];export const useRef=(v)=>({current:v});export const useCallback=(v)=>v;export const useEffect=()=>{}';
const agentUrl = await compile('../lib/agent.ts', { './chat-request': requestUrl, './chat-stream': 'data:text/javascript,export const httpChatTransport={request(){throw new Error(%22transport%22)}};' });
const expertsUrl = await compile('../lib/experts.ts', { './chat-request': requestUrl });
const hookUrl = await compile('../hooks/use-chat.ts', { react: reactUrl, '@/lib/agent': agentUrl, '@/lib/chat-request': requestUrl, '@/lib/chat-metrics': metricsUrl, '@/lib/experts': expertsUrl });
const { summaryPlan, recoverSession } = await import(hookUrl);
const { aggregateMetrics, metricsSnapshot, pricingSnapshotForModel } = await import(metricsUrl);

test('exact five tail and long prefix stay packet-safe', () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({ id: String(i), role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(12000), ...(i % 2 ? { metrics: { status: 'complete' } } : {}) }));
  const plan = summaryPlan(messages, null);
  assert.equal(plan.batch.length, 35); assert.deepEqual(plan.batch.slice(0, 5).map((m) => m.id), ['0','1','2','3','4']); assert.deepEqual(summaryPlan(messages, { content: 'folded', coveredThroughMessageId: '34' }).raw.map((m) => m.id), ['35','36','37','38','39']);
  assert.ok(plan.batch.every((m) => m.content.length <= 12000));
});
test('strategy migration defaults to summary and none persists without deleting raw', () => {
  const base = { id:'c',title:'c',updatedAt:1,agent:{id:'a',name:'a',settings:{}},messages:[{id:'u',role:'user',content:'raw'}],runs:[] };
  assert.equal(recoverSession(base).contextStrategy, 'summary');
  assert.equal(recoverSession({ ...base, contextStrategy:'none' }).contextStrategy, 'none');
});
test('input metrics remain per physical request while aggregate keeps 11 plus 23', () => {
  const p = pricingSnapshotForModel('deepseek-v4-flash', 1700000000000);
  const a = aggregateMetrics([{startedAt:0,firstTokenAt:null,endedAt:1,status:'complete',pricingSnapshot:p,usage:{prompt_tokens:11,completion_tokens:0,total_tokens:11}},{startedAt:2,firstTokenAt:null,endedAt:3,status:'complete',pricingSnapshot:p,usage:{prompt_tokens:23,completion_tokens:0,total_tokens:23}}], 3, Date.now());
  assert.equal(a.usage.prompt_tokens,34); assert.equal(a.promptCount,2);
  assert.equal(metricsSnapshot({startedAt:0,firstTokenAt:null,endedAt:1000,status:'complete',usage:{completion_tokens:42}},1000,Date.now()).averageTokensPerSecond,42);
});

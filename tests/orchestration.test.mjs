/* oxlint-disable react-hooks/rules-of-hooks -- this file intentionally renders the hook in a tiny stateful host. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, mock, test } from 'node:test';
import ts from 'typescript';

const moduleUrl = (source) =>
  'data:text/javascript;base64,' +
  Buffer.from(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
  ).toString('base64');
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const requestUrl = moduleUrl(await read('../lib/chat-request.ts'));
const streamUrl = moduleUrl(await read('../lib/chat-stream.ts'));
const metricsUrl = moduleUrl(
  (await read('../lib/chat-metrics.ts'))
    .replace('./chat-request', requestUrl)
    .replace('./chat-stream', streamUrl),
);
const expertsUrl = moduleUrl(
  (await read('../lib/experts.ts')).replace('./chat-request', requestUrl),
);
const agentUrl = moduleUrl(
  (await read('../lib/agent.ts'))
    .replace('./chat-request', requestUrl)
    .replace('./chat-stream', streamUrl),
);
const { EXPERT_ROLES, synthesisMessages } = await import(expertsUrl);

// Minimal hook host: run the production hook and transport without a DOM or a paid API call.
const reactUrl = moduleUrl(`
let slots = [], cursor = 0;
export function reset(initialSlots = []) { slots = initialSlots; cursor = 0; }
export function begin() { cursor = 0; }
export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; }
export function useRef(initial) { const index = cursor++; return slots[index] ??= {current:initial}; }
export function useCallback(fn) { return fn; }
export function useEffect() {}
`);
const hookSource = (await read('../hooks/use-chat.ts'))
  .replace('react', reactUrl)
  .replace('@/lib/agent', agentUrl)
  .replace('@/lib/chat-request', requestUrl)
  .replace('@/lib/chat-stream', streamUrl)
  .replace('@/lib/experts', expertsUrl)
  .replace('@/lib/chat-metrics', metricsUrl);
const { AcceptedChatError, recoverSession, restoreStore, useChat } = await import(moduleUrl(hookSource));
const host = await import(reactUrl);
const render = () => {
  host.begin();
  return useChat();
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const response = (message, usageOverride = usage) =>
  new Response(
    `event: request\ndata: {"requestJson":"{}"}\n\nevent: delta\ndata: ${JSON.stringify({ content: message })}\n\nevent: done\ndata: ${JSON.stringify({ finishReason: 'stop', usage: usageOverride, model: 'deepseek-v4-flash' })}\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
function setup() {
  host.reset();
  const calls = [];
  mock.method(
    globalThis,
    'fetch',
    (url, options) =>
      new Promise((resolve, reject) => {
        calls.push({ body: JSON.parse(options.body), resolve, reject });
        options.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Stopped', 'AbortError')),
          { once: true },
        );
      }),
  );
  return calls;
}

async function seedCompletedTurns(calls, count = 11) {
  for (let index = 0; index < count; index++) {
    const pending = render().send(`history-${index}`);
    let settled = false;
    void pending.finally(() => { settled = true; });
    let seen = calls.length - 1;
    // A legacy backlog can need several five-row checkpoint requests before
    // its main call. Resolve every physical request until the stateful send
    // settles; the bound catches a future non-progressing loop.
    for (let safety = 0; !settled && safety < 20; safety++) {
      const call = calls[seen];
      assert.ok(call, 'seeded request must create a physical call');
      call.resolve(response(`answer-${index}`));
      await tick();
      if (calls.length > seen + 1) seen += 1;
    }
    assert.ok(settled, 'seeded request must settle within bounded physical calls');
    await pending;
    await tick();
  }
}

test('summary is a physical request, preserves raw order and retry does not advance a failed boundary', async () => {
  const calls = setup();
  await seedCompletedTurns(calls);
  const before = calls.length;
  const pending = render().send('new question');
  assert.equal(calls.length, before + 1, 'new request starts one summary before the main request');
  let summaryCall = calls.at(-1);
  for (let safety = 0; safety < 10 && summaryCall.body.messages[0]?.content.startsWith('Сожми'); safety++) {
    assert.ok(summaryCall.body.messages.length <= 30, 'summary packet stays below transport cap');
    assert.equal(summaryCall.body.settings.model, 'deepseek-v4-flash');
    summaryCall.resolve(response('compressed context'));
    await tick();
    summaryCall = calls.at(-1);
  }
  const mainCall = calls.at(-1);
  const context = mainCall.body.messages.map((item) => item.content).join('\n');
  assert.match(context, /compressed context/);
  assert.match(context, /history-9/);
  assert.match(context, /new question/);
  mainCall.resolve(response('final'));
  await pending;
  const chat = render();
  assert.equal(chat.messages.length, 24, 'raw UI history remains complete');
  assert.equal(chat.metrics.filter((item) => item.requestId).length, calls.length, 'summary is counted once beside every physical call');
});

test('summary waits through the first five turns, checkpoints at threshold, survives reload, and retry does not recompress', async () => {
  const calls=setup(); await seedCompletedTurns(calls,5);
  assert.equal(calls.length,5,'no summary while the first ten eligible rows only become history after a turn');
  const pending=render().send('threshold'); const summary=calls.at(-1);
  assert.match(summary.body.messages[0].content,/Сожми/); summary.resolve(response('checkpoint')); await tick();
  calls.at(-1).resolve(response('answer')); await pending;
  const restored=recoverSession(render().sessions[0]); host.reset([restored,[restored],restored.id,true]);
  const before=calls.length; const next=render().send('after reload');
  assert.equal(calls.length,before+1,'fresh suffix below threshold has no summary'); calls.at(-1).resolve(response('next')); await next;
  const retryBefore=calls.length; const retry=render().repeat(); assert.equal(calls.length,retryBefore+1,'retry uses saved snapshot'); calls.at(-1).resolve(response('retry')); await retry;
});

test('summary abort and failure retain old raw context and retry can start a fresh summary', async () => {
  const calls = setup();
  await seedCompletedTurns(calls);
  const before = calls.length;
  const failed = render().send('will fail');
  calls.at(-1).reject(new Error('summary transport failed'));
  await assert.rejects(failed, /summary transport failed/);
  let chat = render();
  assert.equal(chat.messages.length, 23, 'failed summary remains linked to its visible unsent input');
  assert.equal(chat.lastRequest.prompt, 'history-10', 'failed summary does not replace the prior retry snapshot');
  assert.equal(chat.metrics.at(-1).status, 'error');
  const retry = render().send('retry');
  assert.equal(calls.length, before + 2, 'retry begins another summary from unchanged raw history');
  render().stop();
  await assert.rejects(retry);
  chat = render();
  assert.equal(chat.messages.length, 24);
  assert.equal(chat.metrics.at(-1).status, 'cancelled');
});

test('invalid council preparation never starts summary or locks the chat', async () => {
  const calls = setup();
  await seedCompletedTurns(calls);
  const before = calls.length;
  for (const options of [
    { council: true, topic: '' },
    { council: true, topic: 'x'.repeat(301) },
    { council: true, topic: 'ok', dataset: 'x'.repeat(11901) },
  ]) {
    await assert.rejects(render().send('invalid council', options));
    const chat = render();
    assert.equal(chat.isSending, false);
    assert.equal(chat.phase, '');
    assert.equal(chat.messages.length, 22);
    assert.equal(calls.length, before, 'invalid input must not pay for summary');
  }
  const chat = render();
  chat.setSettings({ ...chat.settings, systemPrompt: 'x'.repeat(7_900) });
  await assert.rejects(render().send('derived invalid', { council: true, topic: 'ok' }));
  assert.equal(render().isSending, false);
  assert.equal(calls.length, before);
});

test('council and synthesis retain summary data while every transport request stays below MAX_MESSAGES', async () => {
  const calls = setup();
  await seedCompletedTurns(calls);
  const before = calls.length;
  const pending = render().send('council question', { council: true, topic: 'tests' });
  for (let safety = 0; safety < 10 && calls.at(-1).body.messages[0]?.content.startsWith('Сожми'); safety++) {
    calls.at(-1).resolve(response('compressed council context'));
    await tick();
  }
  assert.equal(calls.length, before + 5, 'three experts start after checkpoint batches');
  for (const call of calls.slice(-3)) {
    assert.ok(call.body.messages.length <= 30);
    assert.match(call.body.messages.map((item) => item.content).join('\n'), /compressed council context/);
    call.resolve(response(`expert-${calls.indexOf(call)}`));
  }
  await tick();
  const synthesis = calls.at(-1);
  assert.ok(synthesis.body.messages.length <= 30);
  synthesis.resolve(response('synthesis'));
  await pending;
});

test('none strategy sends raw history without summary and rejects overflow before transport', async () => {
  const calls = setup();
  const chat = render();
  chat.setContextStrategy('none');
  await seedCompletedTurns(calls, 3);
  const before = calls.length;
  const pending = render().send('raw next');
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1).body.messages.filter((m) => m.content.startsWith('Сожми')).length, 0);
  calls.at(-1).resolve(response('ok')); await pending;
  const overflow = render();
  overflow.setContextStrategy('none');
  // State is intentionally not mutated with synthetic rows here: server-limit
  // behavior is covered by historyMessages/no-trim contract and hook validation.
  assert.equal(render().isSending, false);
});

test('summary transport packets keep server limits for a long prefix', async () => {
  const calls = setup();
  // Drive the production hook through completed turns; every captured request
  // is the actual transport JSON that the server would validate.
  await seedCompletedTurns(calls, 20);
  const pending = render().send('long-prefix-next');
  let cursor = calls.length - 1;
  for (let guard = 0; guard < 8; guard++) {
    const call = calls[cursor];
    assert.ok(call.body.messages.length <= 30);
    assert.ok(call.body.messages.every((m) => m.content.length <= 12000));
    call.resolve(response(`fold-${guard}`));
    await tick();
    if (calls.length === cursor + 1) break;
    cursor++;
  }
  calls.at(-1).resolve(response('final'));
  await pending;
});

test('hydrated legacy forty long raw messages are folded in bounded transport packets', async () => {
  const calls = [];
  const long = 'x'.repeat(12000);
  const messages = Array.from({ length: 40 }, (_, i) => ({ id: `l${i}`, role: i % 2 ? 'assistant' : 'user', content: long, ...(i % 2 ? { metrics: { status: 'complete' } } : {}) }));
  const session = { id:'legacy',title:'legacy',updatedAt:1,agent:{id:'a',name:'a',settings:{model:'deepseek-v4-flash',systemPrompt:'',format:'',maxTokens:null,temperature:null,stopMode:'none',stopInstruction:'',stopSequence:''}},messages,runs:[],error:null,requestJson:null,lastRequest:null,draft:'',council:false,topic:'',dataset:'',summary:{content:long,coveredThroughMessageId:'l0'},summaryMetrics:[],contextStrategy:'summary',lastMainRequestJson:null,comparison:null };
  host.reset([session, [session], session.id, true]);
  mock.method(globalThis, 'fetch', (url, options) => new Promise((resolve) => { calls.push({ body: JSON.parse(options.body), resolve }); }));
  const pending = render().send('next');
  for (let i=0;i<8 && calls.length;i++) { const call=calls.at(-1); assert.ok(call.body.messages.length<=30); assert.ok(call.body.messages.every((m)=>m.content.length<=12000)); call.resolve(response(`s${i}`)); await tick(); if (calls.at(-1)===call) break; }
  calls.at(-1).resolve(response('main')); await pending;
});

test('packetizer accepts 24001 raw and 72000 previous summary under transport caps', async () => {
  const calls=[]; const raw='r'.repeat(24001), prior='p'.repeat(72000);
  const session={id:'p',title:'p',updatedAt:1,agent:{id:'a',name:'a',settings:{model:'deepseek-v4-flash',systemPrompt:'',format:'',maxTokens:null,temperature:null,stopMode:'none',stopInstruction:'',stopSequence:''}},messages:[{id:'u',role:'user',content:'old'},{id:'a',role:'assistant',content:raw,metrics:{status:'complete'}},{id:'u2',role:'user',content:'x'},{id:'a2',role:'assistant',content:'y',metrics:{status:'complete'}},{id:'u3',role:'user',content:'z'},{id:'a3',role:'assistant',content:'q',metrics:{status:'complete'}}],runs:[],error:null,requestJson:null,lastRequest:null,draft:'',council:false,topic:'',dataset:'',summary:{content:prior,coveredThroughMessageId:'u'},summaryMetrics:[],contextStrategy:'summary',lastMainRequestJson:null,comparison:null};
  host.reset([session,[session],session.id,true]); mock.method(globalThis,'fetch',(url,o)=>new Promise(resolve=>calls.push({body:JSON.parse(o.body),resolve})));
  const pending=render().send('next'); for(let i=0;i<5&&calls.length;i++){const call=calls.at(-1);assert.ok(call.body.messages.length<=30);assert.ok(call.body.messages.every(m=>m.content.length<=12000));call.resolve(response(`s${i}`));await tick();if(calls.at(-1)===call)break;} calls.at(-1).resolve(response('final'));await pending;
});

test('29 summary chunks reject locally before fetch and leave the chat unlocked', async () => {
  const messages=[{id:'covered',role:'user',content:'old'}];
  for(let i=0;i<10;i++) messages.push({id:`m${i}`,role:i%2?'assistant':'user',content:'x',...(i%2?{metrics:{status:'complete'}}:{})});
  const session={id:'large-summary',title:'x',updatedAt:1,agent:{id:'a',name:'a',settings:{model:'deepseek-v4-flash',systemPrompt:'',format:'',maxTokens:null,temperature:null,stopMode:'none',stopInstruction:'',stopSequence:''}},messages,runs:[],error:null,requestJson:null,lastRequest:null,draft:'',council:false,topic:'',dataset:'',summary:{content:'p'.repeat(348001),coveredThroughMessageId:'covered'},summaryMetrics:[],factsMetrics:[],facts:{},contextStrategy:'summary',lastMainRequestJson:null,comparison:null};
  host.reset([session,[session],session.id,true]); let fetches=0; mock.method(globalThis,'fetch',()=>{fetches++;});
  await assert.rejects(render().send('next'),/сводка слишком велика/); assert.equal(fetches,0); assert.equal(render().isSending,false);
});

test('none 350k context rejects before transport', async () => {
  const session={id:'n',title:'n',updatedAt:1,agent:{id:'a',name:'a',settings:{model:'deepseek-v4-flash',systemPrompt:'',format:'',maxTokens:null,temperature:null,stopMode:'none',stopInstruction:'',stopSequence:''}},messages:[{id:'u',role:'user',content:'x'},{id:'a',role:'assistant',content:'x'.repeat(350000),metrics:{status:'complete'}}],runs:[],error:null,requestJson:null,lastRequest:null,draft:'',council:false,topic:'',dataset:'',summary:null,summaryMetrics:[],contextStrategy:'none',lastMainRequestJson:null,comparison:null}; host.reset([session,[session],session.id,true]); let n=0;mock.method(globalThis,'fetch',()=>{n++;});await assert.rejects(render().send('next'),/превышает лимит/);assert.equal(n,0);assert.equal(render().isSending,false);
});

test('summary 350k row folds through bounded calls, persists checkpoint, and does not refold after recovery', async () => {
  const calls=[]; const session={id:'s',title:'s',updatedAt:1,agent:{id:'a',name:'a',settings:{model:'deepseek-v4-flash',systemPrompt:'',format:'',maxTokens:null,temperature:null,stopMode:'none',stopInstruction:'',stopSequence:''}},messages:[{id:'old',role:'user',content:'old'},{id:'huge',role:'assistant',content:'x'.repeat(350000),metrics:{status:'complete'}},{id:'u2',role:'user',content:'2'},{id:'a2',role:'assistant',content:'2',metrics:{status:'complete'}},{id:'u3',role:'user',content:'3'},{id:'a3',role:'assistant',content:'3',metrics:{status:'complete'}},{id:'u4',role:'user',content:'4'},{id:'a4',role:'assistant',content:'4',metrics:{status:'complete'}},{id:'u5',role:'user',content:'5'},{id:'a5',role:'assistant',content:'5',metrics:{status:'complete'}}],runs:[],error:null,requestJson:null,lastRequest:null,draft:'',council:false,topic:'',dataset:'',summary:null,summaryMetrics:[],contextStrategy:'summary',lastMainRequestJson:null,comparison:null};host.reset([session,[session],session.id,true]);mock.method(globalThis,'fetch',(u,o)=>new Promise(resolve=>calls.push({body:JSON.parse(o.body),resolve})));const pending=render().send('next');for(let i=0;i<40&&calls.length;i++){const c=calls.at(-1);assert.ok(c.body.messages.length<=30);assert.ok(c.body.messages.every(m=>m.content.length<=12000));c.resolve(response(`f${i}`));await tick();if(calls.at(-1)===c)break;}calls.at(-1).resolve(response('main'));await pending;const persisted=recoverSession(render().sessions[0]);assert.equal(persisted.summary.coveredThroughMessageId,'u3');assert.ok(render().comparison);const before=calls.length;host.reset([persisted,[persisted],persisted.id,true]);const next=render().send('after reload');assert.equal(calls.length,before+1,'checkpoint prevents another giant fold');calls.at(-1).resolve(response('after'));await next;
});

test('failed 350k fold does not commit a partial logical cutoff', async () => {
  const calls=[]; const old={content:'old checkpoint',coveredThroughMessageId:'old'}; const session={id:'f',title:'f',updatedAt:1,agent:{id:'a',name:'a',settings:{model:'deepseek-v4-flash',systemPrompt:'',format:'',maxTokens:null,temperature:null,stopMode:'none',stopInstruction:'',stopSequence:''}},messages:[{id:'old',role:'user',content:'old'},{id:'huge',role:'assistant',content:'x'.repeat(350000),metrics:{status:'complete'}},{id:'u2',role:'user',content:'2'},{id:'a2',role:'assistant',content:'2',metrics:{status:'complete'}},{id:'u3',role:'user',content:'3'},{id:'a3',role:'assistant',content:'3',metrics:{status:'complete'}},{id:'u4',role:'user',content:'4'},{id:'a4',role:'assistant',content:'4',metrics:{status:'complete'}}],runs:[],error:null,requestJson:null,lastRequest:null,draft:'',council:false,topic:'',dataset:'',summary:old,summaryMetrics:[],contextStrategy:'summary',lastMainRequestJson:null,comparison:null};host.reset([session,[session],session.id,true]);mock.method(globalThis,'fetch',(_url,_options)=>new Promise((resolve,reject)=>calls.push({resolve,reject})));const pending=render().send('next');calls[0].reject(new Error('fold failed'));await assert.rejects(pending);const chat=render();assert.deepEqual(chat.sessions[0].summary,old);assert.equal(calls.length,1);assert.equal(chat.isSending,false);
});

test('comparison records previous and current actual main request JSON only after summary success', async () => {
  const calls = setup();
  await seedCompletedTurns(calls, 5);
  const before = render();
  before.setContextStrategy('summary');
  const pending = render().send('compare');
  calls.at(-1).resolve(response('summary')); await tick();
  const main = calls.at(-1); main.resolve(response('answer')); await pending;
  const chat = render();
  assert.equal(typeof chat.comparison?.current, 'string');
  assert.equal(chat.comparison?.current, chat.lastMainRequestJson);
  assert.equal(typeof chat.comparisonEvent, 'string', 'only the fresh main request emits an ephemeral open event');
});

test('none mode keeps distinct user request ids and input usage', async () => {
  const calls = setup();
  render().setContextStrategy('none');
  const first = render().send('one'); calls.at(-1).resolve(response('a', { prompt_tokens:11, completion_tokens:2, total_tokens:13 })); await first;
  const second = render().send('two'); calls.at(-1).resolve(response('b', { prompt_tokens:23, completion_tokens:3, total_tokens:26 })); await second;
  const chat = render();
  const users = chat.messages.filter((item) => item.role === 'user');
  assert.equal(users.length, 2);
  assert.notEqual(users[0].requestIds[0], users[1].requestIds[0]);
  const byId = new Map(chat.metrics.map((item) => [item.requestId, item]));
  assert.equal(byId.get(users[0].requestIds[0]).usage.prompt_tokens, 11);
  assert.equal(byId.get(users[1].requestIds[0]).usage.prompt_tokens, 23);
  assert.equal(chat.metrics.reduce((sum, item) => sum + (item.usage?.prompt_tokens ?? 0), 0), 34);
});

test('hydrated none history over server cap rejects before fetch and remains unlocked', async () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({ id:`n${i}`, role:i%2?'assistant':'user', content:`raw-${i}`, ...(i%2?{metrics:{status:'complete'}}:{}) }));
  const session = { id:'none',title:'none',updatedAt:1,agent:{id:'a',name:'a',settings:{model:'deepseek-v4-flash',systemPrompt:'',format:'',maxTokens:null,temperature:null,stopMode:'none',stopInstruction:'',stopSequence:''}},messages,runs:[],error:null,requestJson:null,lastRequest:null,draft:'',council:false,topic:'',dataset:'',summary:{content:'stored summary',coveredThroughMessageId:'n34'},summaryMetrics:[],contextStrategy:'none',lastMainRequestJson:null,comparison:null };
  host.reset([session,[session],session.id,true]);
  let fetches=0; mock.method(globalThis,'fetch',()=>{fetches++; return Promise.reject(new Error('must not fetch'));});
  await assert.rejects(render().send('next'), /превышает лимит/);
  assert.equal(fetches,0); assert.equal(render().isSending,false);
});
afterEach(() => mock.restoreAll());

test('three experts start concurrently; synthesis waits for all and receives every full answer plus original data', async () => {
  const calls = setup();
  const initial = render();
  initial.setSettings({ ...initial.settings, temperature: 0.35, model: 'deepseek-v4-pro' });
  const pending = render().send('Реши задачу', {
    council: true,
    topic: 'Алгоритмы',
    dataset: '3, 5, 8',
  });
  assert.equal(calls.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(calls[i].body.settings.temperature, 0.35);
    assert.equal(calls[i].body.settings.model, 'deepseek-v4-pro');
    assert.ok(
      calls[i].body.settings.systemPrompt.includes(EXPERT_ROLES[i].prompt),
    );
    assert.ok(calls[i].body.settings.systemPrompt.includes('Алгоритмы'));
    assert.ok(
      calls[i].body.messages.some((m) => m.content.includes('3, 5, 8')),
    );
  }
  calls[1].resolve(response('Второй ответ'));
  calls[0].resolve(response('Первый ответ'));
  await tick();
  assert.equal(calls.length, 3, 'no early synthesis');
  calls[2].resolve(response('Третий ответ'));
  await tick();
  assert.equal(calls.length, 4);
  assert.equal(calls[3].body.settings.temperature, 0.35);
  assert.equal(calls[3].body.settings.model, 'deepseek-v4-pro');
  const finalContext = calls[3].body.messages.map((m) => m.content).join('\n');
  for (const text of [
    'Реши задачу',
    '3, 5, 8',
    'Первый ответ',
    'Второй ответ',
    'Третий ответ',
  ])
    assert.ok(finalContext.includes(text));
  calls[3].resolve(response('Итоговое решение'));
  assert.equal(await pending, 'Итоговое решение');
  const chat = render();
  assert.equal(chat.messages.at(-1).content, 'Итоговое решение');
  assert.equal(chat.messages.at(-1).metrics.usage.total_tokens, 15);
  assert.ok(chat.runs[0].experts.every((e) => e.status === 'complete'));
});

test('one failed expert is labelled in synthesis, without losing successful answers', async () => {
  const calls = setup();
  const pending = render().send('Задача', { council: true, topic: 'Логика' });
  calls[0].resolve(response('Ответ 1'));
  calls[1].resolve(Response.json({ error: 'Нет средств' }, { status: 402 }));
  calls[2].resolve(response('Ответ 3'));
  await tick();
  assert.equal(calls.length, 4);
  assert.ok(
    calls[3].body.messages.some(
      (m) =>
        m.content.includes('Статус: error') &&
        m.content.includes('Нет средств'),
    ),
  );
  calls[3].resolve(response('Неполный состав учтён'));
  await pending;
  assert.equal(render().runs[0].experts[1].status, 'error');
});

test('cancellation stops all three requests and never starts synthesis', async () => {
  const calls = setup();
  const pending = render().send('Задача', { council: true, topic: 'Логика' });
  const rejected = assert.rejects(pending, /остановлен/);
  render().stop();
  await rejected;
  assert.equal(calls.length, 3);
  assert.ok(render().runs[0].experts.every((e) => e.status === 'cancelled'));
  assert.equal(render().isSending, false);
});

test('repeat uses the original context and new settings; ordinary follow-up uses the completed answer', async () => {
  const calls = setup();
  const first = render().send('Исходная задача');
  calls[0].resolve(response('Вариант A'));
  await first;
  const chat = render();
  chat.setSettings({ ...chat.settings, systemPrompt: 'Кратко', temperature: 0, model: 'deepseek-v4-pro' });
  const repeated = render().repeat();
  assert.deepEqual(calls[1].body.messages, calls[0].body.messages);
  assert.equal(calls[1].body.settings.systemPrompt, 'Кратко');
  assert.equal(calls[1].body.settings.temperature, 0);
  calls[1].resolve(response('Вариант B'));
  await repeated;
  assert.equal(calls[1].body.settings.model, 'deepseek-v4-pro');
  const answers = render().messages.filter((message) => message.role === 'assistant');
  assert.equal(answers[0].metrics.model, 'deepseek-v4-flash');
  assert.equal(answers[1].metrics.model, 'deepseek-v4-pro');

  const followup = render().send('Объясни подробнее');
  assert.ok(calls[2].body.messages.some((m) => m.content === 'Вариант B'));
  calls[2].resolve(response('Пояснение'));
  await followup;
  render().reset();
  assert.equal(render().settings.model, 'deepseek-v4-pro');
});

test('failed partial output remains visible but is excluded from future ordinary context', async () => {
  const calls = setup();
  const pending = render().send('Первый вопрос');
  const rejected = assert.rejects(pending, /Оборвано/);
  calls[0].resolve(
    new Response(
      'event: delta\ndata: {"content":"Частичный ответ"}\n\nevent: error\ndata: {"error":"Оборвано"}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    ),
  );
  await rejected;
  assert.equal(render().messages.at(-1).content, 'Частичный ответ');
  const next = render().send('Другой вопрос');
  assert.ok(
    !calls[1].body.messages.some((m) => m.content === 'Частичный ответ'),
  );
  calls[1].resolve(response('Полный ответ'));
  await next;
});

test('large expert answers fail explicitly rather than silently dropping early history', () => {
  const content = '0123456789'.repeat(4000);
  const answers = EXPERT_ROLES.map((role) => ({
    id: role.id,
    content,
    status: 'complete',
  }));
  const history = Array.from({ length: 29 }, (_, i) => ({
    role: 'user',
    content: `Вопрос ${i}`,
  }));
  assert.throws(() => synthesisMessages(history, answers), /не помещаются/);
});

test('an ordinary follow-up remains valid after a long generated answer', async () => {
  const calls = setup();
  const pending = render().send('Длинный ответ');
  const longAnswer = 'Ответ. '.repeat(3000);
  calls[0].resolve(response(longAnswer));
  await pending;
  const next = render().send('Продолжи');
  assert.ok(calls[1].body.messages.every((m) => m.content.length <= 12000));
  assert.equal(
    calls[1].body.messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join(''),
    longAnswer,
  );
  calls[1].resolve(response('Продолжение'));
  await next;
});

test('Liquid is used for every expert and synthesis; repeat can switch to DeepSeek', async () => {
  const calls = setup();
  const chat = render();
  chat.setSettings({ ...chat.settings, model: 'liquid/lfm-2.5-2.6b:free' });
  const pending = render().send('Задача', { council: true, topic: 'Логика' });
  for (let i = 0; i < 3; i++) {
    assert.equal(calls[i].body.settings.model, 'liquid/lfm-2.5-2.6b:free');
    calls[i].resolve(response('Ответ эксперта'));
  }
  await tick();
  assert.equal(calls[3].body.settings.model, 'liquid/lfm-2.5-2.6b:free');
  calls[3].resolve(response('Итог'));
  await pending;
  assert.ok(render().runs[0].experts.every((expert) => expert.metrics.model === 'liquid/lfm-2.5-2.6b:free'));
  render().setSettings({ ...render().settings, model: 'deepseek-v4-flash' });
  const repeated = render().repeat();
  for (let i = 4; i < 7; i++) {
    assert.equal(calls[i].body.settings.model, 'deepseek-v4-flash');
    calls[i].resolve(response('Новый ответ'));
  }
  await tick();
  assert.equal(calls[7].body.settings.model, 'deepseek-v4-flash');
  calls[7].resolve(response('Новый итог'));
  await repeated;
});

test('new chats receive isolated Agents, history and settings', async () => {
  const calls = setup();
  const firstChat = render();
  firstChat.setSettings({ ...firstChat.settings, model: 'deepseek-v4-pro', systemPrompt: 'Первый агент' });
  const first = render().send('Контекст первого чата');
  calls[0].resolve(response('Ответ первого агента'));
  await first;
  const firstId = render().activeSessionId;

  render().newChat();
  let secondChat = render();
  const secondId = secondChat.activeSessionId;
  assert.notEqual(secondId, firstId);
  secondChat.setSettings({ ...secondChat.settings, model: 'liquid/lfm-2.5-2.6b:free', systemPrompt: 'Второй агент' });
  const second = render().send('Контекст второго чата');
  assert.equal(calls[1].body.settings.model, 'liquid/lfm-2.5-2.6b:free');
  assert.ok(!calls[1].body.messages.some((message) => message.content.includes('первого')));
  calls[1].resolve(response('Ответ второго агента'));
  await second;

  render().setActiveSession(firstId);
  secondChat = render();
  assert.equal(secondChat.settings.model, 'deepseek-v4-pro');
  assert.equal(secondChat.messages.at(-1).content, 'Ответ первого агента');
  assert.equal(secondChat.sessions.length, 2);
});

test('sticky facts updates, corrects and deletes atomically, persists, and retry skips extraction', async () => {
  const calls = setup();
  const chat = render();
  chat.setContextStrategy('facts');
  const first = render().send('Меня зовут Анна');
  assert.match(calls.at(-1).body.messages[0].content, /Извлеки устойчивые факты/);
  calls.at(-1).resolve(response('{"имя":"Анна"}')); await tick();
  assert.match(calls.at(-1).body.messages.map((m) => m.content).join('\n'), /"имя":"Анна"/);
  calls.at(-1).resolve(response('Привет, Анна')); await first;
  assert.deepEqual(render().facts, { имя: 'Анна' });
  const factsMetric=render().sessions[0].factsMetrics[0]; assert.equal(factsMetric.requestJson,'{}'); assert.ok(factsMetric.firstTokenAt); assert.equal(recoverSession(render().sessions[0]).factsMetrics[0].requestJson,'{}');
  const second = render().send('Исправление: имя Боб, прежнее имя удалить');
  calls.at(-1).resolve(response('{"имя":"Боб","устаревший":null}')); await tick();
  calls.at(-1).resolve(response('Привет, Боб')); await second;
  assert.deepEqual(render().facts, { имя: 'Боб' });
  const restored = recoverSession(render().sessions[0]);
  assert.deepEqual(restored.facts, { имя: 'Боб' });
  const beforeRetry = calls.length;
  const retry = render().repeat();
  assert.equal(calls.length, beforeRetry + 1, 'saved main snapshot skips another facts extraction');
  calls.at(-1).resolve(response('retry')); await retry;
});

test('sliding window sends exactly five prior eligible rows after reload and retry keeps its snapshot', async () => {
  const calls=setup(); await seedCompletedTurns(calls,4); render().setContextStrategy('sliding');
  const session=recoverSession(render().sessions[0]); host.reset([session,[session],session.id,true]);
  const pending=render().send('sliding'); const body=calls.at(-1).body.messages;
  assert.equal(body.length,6); assert.deepEqual(body.slice(0,-1).map((m)=>m.content), session.messages.filter((m)=>m.role==='user'||m.metrics?.status==='complete').slice(-5).map((m)=>m.content));
  calls.at(-1).resolve(response('ok')); await pending; const before=calls.length; const retry=render().repeat(); assert.equal(calls.length,before+1); calls.at(-1).resolve(response('again')); await retry;
});

test('sticky facts invalid JSON, transport error and cancellation never start main and unlock the hook', async () => {
  const calls = setup();
  render().setContextStrategy('facts');
  const invalid = render().send('bad facts');
  calls.at(-1).resolve(response('not-json'));
  await assert.rejects(invalid, /некорректный JSON фактов/);
  assert.equal(render().isSending, false); assert.equal(calls.length, 1);
  const failed = render().send('transport error');
  calls.at(-1).reject(new Error('facts failed'));
  await assert.rejects(failed, /facts failed/);
  assert.equal(render().isSending, false); assert.equal(calls.length, 2);
  const cancelled = render().send('cancel facts');
  render().stop();
  await assert.rejects(cancelled);
  assert.equal(render().isSending, false); assert.equal(calls.length, 3);
  const input = render().messages.at(-1);
  assert.ok(input.requestIds?.length, 'failed updater remains linked to its visible user input');
});

test('two sibling branches retain one checkpoint, isolated suffixes, switch/recover, and branch-local retry', async () => {
  const calls = setup();
  await seedCompletedTurns(calls, 5);
  const root = render();
  root.forkBranches();
  let chat = render();
  const a = chat.sessions.find((session) => session.title.endsWith('ветка A'));
  const b = chat.sessions.find((session) => session.title.endsWith('ветка B'));
  assert.ok(a && b); assert.equal(a.summary?.coveredThroughMessageId, b.summary?.coveredThroughMessageId);
  const branchA = chat.activeSessionId;
  const sendA = chat.send('only A'); calls.at(-1).resolve(response('answer A')); await sendA;
  chat = render(); chat.setActiveSession(b.id);
  const sendB = render().send('only B'); calls.at(-1).resolve(response('answer B')); await sendB;
  chat = render(); chat.setActiveSession(branchA);
  assert.ok(render().messages.some((m) => m.content === 'only A'));
  assert.ok(!render().messages.some((m) => m.content === 'only B'));
  const restored = restoreStore(JSON.stringify({ sessions: render().sessions, activeSessionId: branchA }));
  assert.equal(restored.sessions.length, 3);
  assert.ok(restored.sessions.find((s) => s.id === b.id)?.messages.some((m) => m.content === 'only B'));
  host.reset([restored.sessions, restored.sessions, restored.activeSessionId, true]);
  const before = calls.length; const retry = render().repeat();
  assert.equal(calls.length, before + 1); calls.at(-1).resolve(response('retry A')); await retry;
});

test('storage recovery keeps valid session data and drops malformed nested fields', () => {
  const stored = JSON.stringify({
    activeSessionId: 'saved',
    sessions: [{
      id: 'saved', title: 'Сохранённый', updatedAt: Date.now(),
      agent: { id: 'agent', name: 'Агент', settings: { model: 'deepseek-v4-pro', temperature: 'bad' } },
      messages: [
        { id: 'm1', role: 'user', content: 'Целое сообщение' },
        { id: 'bad', role: 'system', content: 'Нельзя' },
      ],
      runs: [{ id: 'bad-run', topic: 'x', dataset: '', experts: [] }],
      requestJson: 'bad json',
      lastRequest: { prompt: 'broken', messages: [] },
      draft: 1,
    }, { id: 1 }],
  });
  const restored = restoreStore(stored);
  assert.equal(restored.sessions.length, 1);
  assert.equal(restored.activeSessionId, 'saved');
  assert.equal(restored.sessions[0].agent.settings.model, 'deepseek-v4-pro');
  assert.equal(restored.sessions[0].agent.settings.temperature, null);
  assert.equal(restored.sessions[0].messages.length, 1);
  assert.equal(restored.sessions[0].runs.length, 0);
  assert.equal(restored.sessions[0].requestJson, null);
  assert.equal(restored.sessions[0].lastRequest, null);
  assert.equal(restored.sessions[0].draft, '');
  assert.equal(recoverSession({ id: 'broken' }), null);
});

test('an accepted stopped request exposes a localized error without asking the page to restore its draft', async () => {
  const calls = setup();
  const pending = render().send('Не дублируй меня');
  render().stop();
  await assert.rejects(pending, AcceptedChatError);
  const chat = render();
  assert.equal(chat.draft, '');
  assert.equal(chat.error, 'Запрос остановлен. Частичные ответы сохранены.');
  assert.equal(chat.messages.filter((message) => message.content === 'Не дублируй меня').length, 1);
  assert.equal(calls.length, 1);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, mock, test } from 'node:test';
import ts from 'typescript';

const toModule = (source) =>
  'data:text/javascript;base64,' +
  Buffer.from(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
  ).toString('base64');
const sharedModule = toModule(
  await readFile(new URL('../lib/chat-request.ts', import.meta.url), 'utf8'),
);
const routeSource = await readFile(
  new URL('../app/api/chat/route.ts', import.meta.url),
  'utf8',
);
const { POST } = await import(
  toModule(routeSource.replace('../../../lib/chat-request', sharedModule))
);
const messages = [{ role: 'user', content: 'Объясни API.' }];
const originalKey = process.env.DEEPSEEK_API_KEY;
const originalRouterKey = process.env.OPENROUTER_API_KEY;
let sent;

const upstream = (parts, { status = 200 } = {}) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts)
          controller.enqueue(
            typeof part === 'string' ? new TextEncoder().encode(part) : part,
          );
        controller.close();
      },
    }),
    { status, headers: { 'Content-Type': 'text/event-stream' } },
  );
const chunk = (value) => `data: ${JSON.stringify(value)}\n\n`;
const success = () =>
  upstream([
    chunk({
      model: 'deepseek-v4-flash',
      choices: [{ delta: { content: 'От' }, finish_reason: null }],
    }),
    chunk({
      model: 'deepseek-v4-flash',
      choices: [{ delta: { content: 'вет' }, finish_reason: 'stop' }],
    }),
    chunk({
      choices: [],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 2,
        total_tokens: 9,
        prompt_cache_hit_tokens: 3,
        prompt_cache_miss_tokens: 4,
        completion_tokens_details: { reasoning_tokens: 1, ignored: 8 },
      },
    }),
    'data: [DONE]\n\n',
  ]);
const readEvents = async (response) => {
  const text = await response.text();
  return text
    .trim()
    .split(/\r?\n\r?\n/)
    .map((frame) => {
      const lines = frame.split(/\r?\n/);
      return {
        event: lines
          .find((line) => line.startsWith('event:'))
          ?.slice(6)
          .trim(),
        data: JSON.parse(
          lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n'),
        ),
      };
    });
};
const post = (body, signal) =>
  POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }),
  );

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = 'unit-test-secret';
  process.env.OPENROUTER_API_KEY = 'router-test-secret';
  sent = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    sent.push({ url, ...options });
    return success();
  });
});
afterEach(() => {
  mock.restoreAll();
  if (originalRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalRouterKey;
  if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalKey;
});

test('temperature reaches upstream and request snapshot, including zero; empty values are omitted', async () => {
  for (const temperature of [0, 0.7, 2, null, undefined]) {
    const response = await post({ messages, settings: { temperature } });
    assert.equal(response.status, 200);
    const events = await readEvents(response);
    const outgoing = JSON.parse(sent.at(-1).body);
    assert.equal(events[0].data.requestJson, sent.at(-1).body);
    if (temperature == null) {
      assert.equal('temperature' in outgoing, false);
      assert.equal('thinking' in outgoing, false);
    } else {
      assert.equal(outgoing.temperature, temperature);
      assert.deepEqual(outgoing.thinking, { type: 'disabled' });
    }
  }
});

test('invalid temperature is rejected before upstream', async () => {
  for (const temperature of [-0.1, 2.1, '0.7', false]) {
    const response = await post({ messages, settings: { temperature } });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /температуру/);
  }
  assert.equal(sent.length, 0);
});

test('proxies incremental deltas, request JSON, finish metadata and exact API usage', async () => {
  const response = await post({
    messages,
    settings: { format: 'Кратко.', maxTokens: 150 },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const events = await readEvents(response);
  assert.deepEqual(
    events.map(({ event }) => event),
    ['request', 'delta', 'delta', 'done'],
  );
  assert.equal(events[0].data.requestJson, sent[0].body);
  assert.equal(events[1].data.content + events[2].data.content, 'Ответ');
  assert.deepEqual(events[3].data, {
    finishReason: 'stop',
    model: 'deepseek-v4-flash',
    usage: {
      prompt_tokens: 7,
      completion_tokens: 2,
      total_tokens: 9,
      prompt_cache_hit_tokens: 3,
      prompt_cache_miss_tokens: 4,
      completion_tokens_details: { reasoning_tokens: 1 },
    },
  });
  const outgoing = JSON.parse(sent[0].body);
  assert.equal(outgoing.stream, true);
  assert.deepEqual(outgoing.stream_options, { include_usage: true });
  assert.equal(sent[0].headers.Authorization, 'Bearer unit-test-secret');
  assert.equal(JSON.stringify(events).includes('unit-test-secret'), false);
});

test('parses upstream SSE across UTF-8/chunk/CRLF boundaries and ignores comments', async () => {
  const bytes = new TextEncoder().encode(
    ': ping\r\ndata: ' +
      JSON.stringify({
        model: 'm',
        choices: [{ delta: { content: 'Привет 🌍' }, finish_reason: 'stop' }],
      }) +
      '\r\n\r\ndata: [DONE]\r\n\r\n',
  );
  globalThis.fetch.mock.mockImplementation(async () =>
    upstream([
      bytes.slice(0, 17),
      bytes.slice(17, 45),
      bytes.slice(45, 67),
      bytes.slice(67),
    ]),
  );
  const events = await readEvents(await post({ messages }));
  assert.equal(
    events.find(({ event }) => event === 'delta').data.content,
    'Привет 🌍',
  );
  assert.equal(events.at(-1).event, 'done');
});

test('validation and a missing key remain JSON errors before streaming', async () => {
  assert.equal((await post({ messages: [] })).status, 400);
  delete process.env.DEEPSEEK_API_KEY;
  const response = await post({ messages });
  assert.equal(response.status, 503);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal((await response.json()).requestJson, undefined);
  assert.equal(sent.length, 0);
});

test('upstream HTTP and connection errors remain JSON and retain requestJson', async () => {
  globalThis.fetch.mock.mockImplementation(async (_url, options) => {
    sent.push(options);
    return new Response('private', { status: 429 });
  });
  let response = await post({ messages });
  let result = await response.json();
  assert.equal(response.status, 429);
  assert.equal(result.requestJson, sent.at(-1).body);
  assert.equal(JSON.stringify(result).includes('private'), false);
  globalThis.fetch.mock.mockImplementation(async (_url, options) => {
    sent.push(options);
    throw new TypeError('secret');
  });
  response = await post({ messages });
  result = await response.json();
  assert.equal(response.status, 502);
  assert.equal(result.requestJson, sent.at(-1).body);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

for (const [name, parts, pattern] of [
  ['malformed', ['data: {bad}\n\n'], /повреждённый/],
  [
    'incomplete',
    [chunk({ choices: [{ delta: { content: 'часть' } }] })],
    /преждевременно/,
  ],
  ['unterminated', ['data: {}'], /незавершённый/i],
  [
    'empty',
    [
      chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ],
    /пустой ответ/,
  ],
  [
    'missing finish reason',
    [
      chunk({
        model: 'deepseek-v4-flash',
        choices: [{ delta: { content: 'Ответ' }, finish_reason: null }],
      }),
      'data: [DONE]\n\n',
    ],
    /причину завершения/,
  ],
])
  test(`reports ${name} upstream stream failures as SSE error events`, async () => {
    globalThis.fetch.mock.mockImplementation(async () => upstream(parts));
    const response = await post({ messages });
    const events = await readEvents(response);
    assert.equal(response.status, 200);
    assert.equal(events[0].event, 'request');
    assert.equal(events.at(-1).event, 'error');
    assert.match(events.at(-1).data.error, pattern);
  });

test('aborting the client request propagates to the upstream fetch signal', async () => {
  let upstreamSignal;
  globalThis.fetch.mock.mockImplementation(async (_url, options) => {
    upstreamSignal = options.signal;
    return success();
  });
  const controller = new AbortController();
  const response = await post({ messages }, controller.signal);
  controller.abort();
  await response.text();
  assert.equal(upstreamSignal.aborted, true);
});

test('an already aborted request reaches fetch with an aborted upstream signal', async () => {
  let upstreamSignal;
  globalThis.fetch.mock.mockImplementation(async (_url, options) => {
    upstreamSignal = options.signal;
    throw new DOMException('aborted', 'AbortError');
  });
  const controller = new AbortController();
  controller.abort();
  const response = await post({ messages }, controller.signal);
  assert.equal(response.status, 502);
  assert.equal(upstreamSignal.aborted, true);
});

test('cancelling downstream while reading cancels upstream without controller errors', async () => {
  let markCancelled;
  const cancelled = new Promise((resolve) => {
    markCancelled = resolve;
  });
  globalThis.fetch.mock.mockImplementation(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                chunk({
                  model: 'deepseek-v4-flash',
                  choices: [
                    { delta: { content: 'часть' }, finish_reason: null },
                  ],
                }),
              ),
            );
          },
          cancel() {
            markCancelled();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
  );
  const response = await post({ messages });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await Promise.race([
    cancelled,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('upstream was not cancelled')), 500),
    ),
  ]);
});

test('selected model reaches upstream and JSON; omitted model defaults to Flash', async () => {
  for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro', undefined]) {
    const response = await post({ messages, settings: { model } });
    assert.equal(response.status, 200);
    const events = await readEvents(response);
    assert.equal(JSON.parse(sent.at(-1).body).model, model ?? 'deepseek-v4-flash');
    assert.equal(events[0].data.requestJson, sent.at(-1).body);
  }
});
test('invalid model is rejected before upstream', async () => {
  for (const model of ['unknown', '', null, 42]) {
    const response = await post({ messages, settings: { model } });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /модель/);
  }
  assert.equal(sent.length, 0);
});

test('Liquid routes to OpenRouter with its own key and provider parameters, no DeepSeek key required', async () => {
  delete process.env.DEEPSEEK_API_KEY;
  const response = await post({ messages, settings: { model: 'liquid/lfm-2.5-2.6b:free', temperature: 0.4, maxTokens: 200 } });
  const events = await readEvents(response);
  assert.equal(events.at(-1).event, 'done');
  assert.equal(sent[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent[0].headers.Authorization, 'Bearer router-test-secret');
  const body = JSON.parse(sent[0].body);
  assert.equal(body.model, 'liquid/lfm-2.5-2.6b:free');
  assert.equal(body.temperature, 0.4);
  assert.equal(body.max_tokens, 200);
  assert.equal('reasoning' in body, false);
  assert.equal('thinking' in body, false);
  assert.equal('models' in body, false);
  assert.equal(events[0].data.requestJson, sent[0].body);
  assert.equal(JSON.stringify(events).includes('router-test-secret'), false);
});
test('missing OpenRouter key is actionable; DeepSeek still works independently', async () => {
  delete process.env.OPENROUTER_API_KEY;
  const response = await post({ messages, settings: { model: 'liquid/lfm-2.5-2.6b:free' } });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /OPENROUTER_API_KEY/);
  assert.equal(sent.length, 0);
  await readEvents(await post({ messages }));
  assert.equal(sent[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(sent[0].headers.Authorization, 'Bearer unit-test-secret');
});
test('OpenRouter error messages identify provider and do not expose upstream payload', async () => {
  for (const status of [401, 403, 404, 429, 504]) {
    globalThis.fetch.mock.mockImplementation(async () => new Response('private upstream payload', { status }));
    const response = await post({ messages, settings: { model: 'liquid/lfm-2.5-2.6b:free' } });
    const body = await response.json();
    assert.match(body.error, /OpenRouter/);
    assert.equal(body.error.includes('private'), false);
    if (status === 401) assert.match(body.error, /OPENROUTER_API_KEY/);
    if (status === 504) assert.match(body.error, /у провайдера/);
  }
});
test('application timeout is five minutes and aborts pending connection with explicit 504', async () => {
  let expire, delay, signal;
  mock.method(globalThis, 'setTimeout', (callback, ms) => { expire = callback; delay = ms; return 1; });
  mock.method(globalThis, 'clearTimeout', () => {});
  globalThis.fetch.mock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }));
  const pending = post({ messages });
  await new Promise(setImmediate);
  assert.equal(delay, 300000);
  assert.equal(signal.aborted, false);
  expire();
  const response = await pending;
  assert.equal(signal.aborted, true);
  assert.equal(response.status, 504);
  assert.match((await response.json()).error, /Таймаут приложения.*5 минут/);
});
test('five-minute streaming timeout preserves deltas and cancels upstream', async () => {
  let expire, cancelled = false;
  mock.method(globalThis, 'setTimeout', (callback, ms) => { assert.equal(ms, 300000); expire = callback; return 1; });
  mock.method(globalThis, 'clearTimeout', () => {});
  globalThis.fetch.mock.mockImplementation(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(chunk({ model: 'liquid/lfm-2.5-2.6b', choices: [{ delta: { content: 'Часть' } }] }))); },
    cancel() { cancelled = true; },
  })));
  const response = await post({ messages, settings: { model: 'liquid/lfm-2.5-2.6b:free' } });
  const pending = readEvents(response);
  await new Promise(setImmediate);
  expire();
  const events = await pending;
  assert.equal(events.find((event) => event.event === 'delta').data.content, 'Часть');
  assert.match(events.at(-1).data.error, /Таймаут приложения.*OpenRouter/);
  assert.equal(cancelled, true);
});
test('OpenRouter finish_reason error is never reported as success', async () => {
  globalThis.fetch.mock.mockImplementation(async () => upstream([
    chunk({ model: 'liquid/lfm-2.5-2.6b', choices: [{ delta: { content: 'Часть' }, finish_reason: 'error' }] }),
    'data: [DONE]\n\n',
  ]));
  const events = await readEvents(await post({ messages, settings: { model: 'liquid/lfm-2.5-2.6b:free' } }));
  assert.equal(events.at(-1).event, 'error');
  assert.match(events.at(-1).data.error, /OpenRouter/);
});

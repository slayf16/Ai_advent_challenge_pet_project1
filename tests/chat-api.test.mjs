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
  sent = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    sent.push({ url, ...options });
    return success();
  });
});
afterEach(() => {
  mock.restoreAll();
  if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalKey;
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

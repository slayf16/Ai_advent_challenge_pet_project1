import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, mock, test } from 'node:test';
import ts from 'typescript';

const source = await readFile(
  new URL('../lib/chat-stream.ts', import.meta.url),
  'utf8',
);
const moduleUrl =
  'data:text/javascript;base64,' +
  Buffer.from(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
  ).toString('base64');
const { streamChat } = await import(moduleUrl);
const messages = [{ role: 'user', content: 'test' }];
const settings = {
  format: '',
  maxTokens: null,
  stopMode: 'none',
  stopInstruction: '',
  stopSequence: '',
};
const responseFrom = (parts, init = {}) =>
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
    {
      headers: { 'Content-Type': 'text/event-stream', ...init.headers },
      status: init.status,
    },
  );
afterEach(() => mock.restoreAll());

test('assembles split UTF-8/CRLF events and invokes progressive callbacks', async () => {
  const text =
    ': heartbeat\r\nevent: request\r\ndata: {"requestJson":"{\\"stream\\":true}"}\r\n\r\n' +
    'event: delta\r\ndata: {"content":"При"}\r\n\r\nevent: delta\r\ndata: {"content":"вет 🌍"}\r\n\r\n' +
    'event: done\r\ndata: {"finishReason":"stop","usage":{"total_tokens":3},"model":"m"}\r\n\r\n';
  const bytes = new TextEncoder().encode(text);
  mock.method(globalThis, 'fetch', async () =>
    responseFrom([
      bytes.slice(0, 41),
      bytes.slice(41, 112),
      bytes.slice(112, 151),
      bytes.slice(151),
    ]),
  );
  const requests = [],
    deltas = [],
    usages = [];
  const result = await streamChat(messages, settings, {
    onRequest: (x) => requests.push(x),
    onDelta: (x) => deltas.push(x),
    onUsage: (x) => usages.push(x),
  });
  assert.deepEqual(result, {
    message: 'Привет 🌍',
    finishReason: 'stop',
    usage: { total_tokens: 3 },
    model: 'm',
  });
  assert.deepEqual(deltas, ['При', 'вет 🌍']);
  assert.deepEqual(usages, [{ total_tokens: 3 }]);
  assert.deepEqual(requests, ['{"stream":true}']);
});

test('reads JSON error bodies and exposes requestJson before throwing', async () => {
  mock.method(globalThis, 'fetch', async () =>
    Response.json(
      { error: 'Нет доступа', requestJson: '{"x":1}' },
      { status: 401 },
    ),
  );
  let requestJson;
  await assert.rejects(
    streamChat(messages, settings, {
      onRequest: (x) => {
        requestJson = x;
      },
    }),
    /Нет доступа/,
  );
  assert.equal(requestJson, '{"x":1}');
});

test('keeps delivered deltas when a later SSE error arrives', async () => {
  mock.method(globalThis, 'fetch', async () =>
    responseFrom([
      'event: delta\ndata: {"content":"часть"}\n\n',
      'event: error\ndata: {"error":"обрыв"}\n\n',
    ]),
  );
  let partial = '';
  await assert.rejects(
    streamChat(messages, settings, {
      onDelta: (x) => {
        partial += x;
      },
    }),
    /обрыв/,
  );
  assert.equal(partial, 'часть');
});

test('rejects a delta sent after done', async () => {
  mock.method(globalThis, 'fetch', async () =>
    responseFrom([
      'event: delta\ndata: {"content":"готово"}\n\n',
      'event: done\ndata: {"finishReason":"stop","usage":null,"model":"m"}\n\n',
      'event: delta\ndata: {"content":"лишнее"}\n\n',
    ]),
  );
  await assert.rejects(
    streamChat(messages, settings, {}),
    /после события done/,
  );
});

for (const [name, body, pattern] of [
  ['malformed JSON', 'event: delta\ndata: {bad}\n\n', /повреждённое/],
  [
    'incomplete event',
    'event: delta\ndata: {"content":"x"}',
    /посреди события/,
  ],
  [
    'missing done',
    'event: delta\ndata: {"content":"x"}\n\n',
    /до события done/,
  ],
  [
    'empty answer',
    'event: done\ndata: {"finishReason":"stop","usage":null,"model":"m"}\n\n',
    /пустой ответ/,
  ],
])
  test(`rejects ${name}`, async () => {
    mock.method(globalThis, 'fetch', async () => responseFrom([body]));
    await assert.rejects(streamChat(messages, settings, {}), pattern);
  });

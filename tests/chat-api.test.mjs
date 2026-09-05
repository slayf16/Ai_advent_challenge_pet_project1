import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, mock, test } from 'node:test';
import ts from 'typescript';

// Load the real TypeScript handler without starting a server or adding a runner.
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
const { DEFAULT_SETTINGS } = await import(sharedModule);
const messages = [{ role: 'user', content: 'Объясни, что такое API.' }];
const originalKey = process.env.DEEPSEEK_API_KEY;
let sent;

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = 'unit-test-secret';
  sent = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    sent.push({ url, ...options });
    return Response.json({
      choices: [{ message: { content: 'Ответ' }, finish_reason: 'stop' }],
    });
  });
});

afterEach(() => {
  mock.restoreAll();
  if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalKey;
});

const post = (body) =>
  POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

test('instruction, length and exact outgoing JSON reach the API without exposing the key', async () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    format: 'Два предложения.',
    maxTokens: 150,
    stopMode: 'instruction',
    stopInstruction: 'Остановись после второго предложения.',
  };
  const response = await post({ messages, settings });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.requestJson, sent[0].body);
  assert.equal(sent[0].url, 'https://api.deepseek.com/chat/completions');
  const payload = JSON.parse(sent[0].body);
  assert.deepEqual(payload.messages.slice(1), messages);
  assert.ok(payload.messages[0].content.includes(settings.format));
  assert.ok(payload.messages[0].content.includes(settings.stopInstruction));
  assert.equal(payload.max_tokens, 150);
  assert.equal(payload.thinking.type, 'disabled');
  assert.equal('stop' in payload, false);
  assert.equal(sent[0].headers.Authorization, 'Bearer unit-test-secret');
  assert.equal(JSON.stringify(result).includes('unit-test-secret'), false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('sequence mode preserves the exact marker, omits the inactive instruction and strips untrusted message fields', async () => {
  const marker = ' [END]\n';
  const response = await post({
    messages: [{ ...messages[0], prefix: true, injected: 'ignored' }],
    settings: {
      ...DEFAULT_SETTINGS,
      stopMode: 'sequence',
      stopSequence: marker,
      stopInstruction: 'INACTIVE',
    },
  });
  assert.equal(response.status, 200);
  const payload = JSON.parse(sent[0].body);
  assert.deepEqual(payload.stop, [marker]);
  assert.deepEqual(payload.messages[1], messages[0]);
  assert.ok(payload.messages[0].content.includes(JSON.stringify(marker)));
  assert.equal(payload.messages[0].content.includes('INACTIVE'), false);
});

test('changing parameters leaves the same prompt and context intact', async () => {
  const context = [
    { role: 'user', content: 'Привет' },
    { role: 'assistant', content: 'Здравствуйте' },
    ...messages,
  ];
  await post({ messages: context, settings: DEFAULT_SETTINGS });
  await post({
    messages: context,
    settings: { ...DEFAULT_SETTINGS, maxTokens: 100, format: 'Одна строка.' },
  });
  assert.deepEqual(
    JSON.parse(sent[0].body).messages,
    JSON.parse(sent[1].body).messages.slice(1),
  );
  assert.notEqual(
    JSON.parse(sent[0].body).max_tokens,
    JSON.parse(sent[1].body).max_tokens,
  );
});

test('invalid settings never call DeepSeek', async () => {
  for (const settings of [
    null,
    [],
    'bad',
    { ...DEFAULT_SETTINGS, format: null },
    { ...DEFAULT_SETTINGS, format: 'x'.repeat(2001) },
    ...[0, -1, 4097, 1.5, '512', ''].map((maxTokens) => ({
      ...DEFAULT_SETTINGS,
      maxTokens,
    })),
    { ...DEFAULT_SETTINGS, stopMode: 'unknown' },
    { ...DEFAULT_SETTINGS, stopInstruction: null },
    { ...DEFAULT_SETTINGS, stopInstruction: 'x'.repeat(2001) },
    { ...DEFAULT_SETTINGS, stopMode: 'sequence', stopSequence: null },
    {
      ...DEFAULT_SETTINGS,
      stopMode: 'sequence',
      stopSequence: 'x'.repeat(201),
    },
  ]) {
    assert.equal((await post({ messages, settings })).status, 400);
  }
  assert.equal(sent.length, 0);
});

test('invalid history and malformed JSON never call DeepSeek', async () => {
  for (const history of [
    [],
    Array(31).fill(messages[0]),
    [{ role: 'system', content: 'bad' }],
    [{ role: 'assistant', content: 'bad' }],
    [{ role: 'user', content: ' ' }],
    [{ role: 'user', content: 'x'.repeat(12001) }],
  ]) {
    assert.equal((await post({ messages: history })).status, 400);
  }
  const bad = await POST(
    new Request('http://localhost/api/chat', { method: 'POST', body: '{' }),
  );
  assert.equal(bad.status, 400);
  assert.equal(sent.length, 0);
});

test('empty, omitted and whitespace-only settings send no custom conditions', async () => {
  for (const settings of [
    undefined,
    {},
    DEFAULT_SETTINGS,
    {
      ...DEFAULT_SETTINGS,
      format: ' \n ',
      stopMode: 'instruction',
      stopInstruction: '  ',
    },
    { ...DEFAULT_SETTINGS, stopMode: 'sequence', stopSequence: ' \n ' },
    {
      ...DEFAULT_SETTINGS,
      stopInstruction: 'INACTIVE',
      stopSequence: '[INACTIVE]',
    },
  ]) {
    const response = await post({ messages, settings });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.requestJson, sent.at(-1).body);
    assert.deepEqual(JSON.parse(result.requestJson), {
      model: 'deepseek-v4-flash',
      messages,
      stream: false,
    });
  }
});

test('each parameter can be supplied on its own and cleared independently', async () => {
  for (const settings of [
    { format: 'Одна строка.' },
    { maxTokens: 100 },
    { stopMode: 'instruction', stopInstruction: 'Заверши после определения.' },
    { stopMode: 'sequence', stopSequence: '[END]' },
  ]) {
    assert.equal((await post({ messages, settings })).status, 200);
    const payload = JSON.parse(sent.at(-1).body);
    const system = payload.messages[0].content;
    assert.equal(system.includes('Формат ответа:'), Boolean(settings.format));
    assert.equal(
      system.includes('Ограничение длины:'),
      settings.maxTokens !== undefined,
    );
    assert.equal(
      system.includes('Условие завершения:'),
      Boolean(settings.stopMode),
    );
    assert.equal(payload.max_tokens, settings.maxTokens);
    assert.deepEqual(
      payload.stop,
      settings.stopSequence ? [settings.stopSequence] : undefined,
    );
    assert.deepEqual(payload.messages.slice(1), messages);
  }
  for (const stopMode of ['instruction', 'sequence']) {
    assert.equal(
      (await post({ messages, settings: { format: 'Одна строка.', stopMode } }))
        .status,
      200,
    );
    const payload = JSON.parse(sent.at(-1).body);
    assert.equal(
      payload.messages[0].content.includes('Условие завершения:'),
      false,
    );
    assert.equal('stop' in payload, false);
    assert.equal('max_tokens' in payload, false);
  }
});

test('a missing key is never reported as a sent request', async () => {
  delete process.env.DEEPSEEK_API_KEY;
  const response = await post({ messages });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).requestJson, undefined);
  assert.equal(sent.length, 0);
});

test('upstream errors and network failures retain the attempted request JSON', async () => {
  for (const status of [401, 402, 429, 500]) {
    globalThis.fetch.mock.mockImplementation(async (_url, options) => {
      sent.push(options);
      return new Response('upstream private error', { status });
    });
    const response = await post({ messages });
    const result = await response.json();
    assert.equal(response.status, status === 500 ? 502 : status);
    assert.equal(result.requestJson, sent.at(-1).body);
    assert.equal(
      JSON.stringify(result).includes('upstream private error'),
      false,
    );
  }
  globalThis.fetch.mock.mockImplementation(async (_url, options) => {
    sent.push(options);
    throw new DOMException('timeout', 'TimeoutError');
  });
  const result = await (await post({ messages })).json();
  assert.equal(result.requestJson, sent.at(-1).body);
  assert.match(result.error, /вовремя/);
});

test('token truncation is returned for both partial and empty answers', async () => {
  for (const content of ['Частичный ответ', '']) {
    globalThis.fetch.mock.mockImplementation(async () =>
      Response.json({
        choices: [{ message: { content }, finish_reason: 'length' }],
      }),
    );
    const response = await post({ messages });
    const result = await response.json();
    assert.equal(response.status, content ? 200 : 502);
    assert.equal(result.finishReason, 'length');
    assert.ok(result.requestJson);
    if (!content) assert.match(result.error, /лимит/i);
  }
});

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
const expertsUrl = moduleUrl(
  (await read('../lib/experts.ts')).replace('./chat-request', requestUrl),
);
const streamUrl = moduleUrl(await read('../lib/chat-stream.ts'));
const { EXPERT_ROLES, synthesisMessages } = await import(expertsUrl);

// Minimal hook host: run the production hook and transport without a DOM or a paid API call.
const reactUrl = moduleUrl(`
let slots = [], cursor = 0;
export function reset() { slots = []; cursor = 0; }
export function begin() { cursor = 0; }
export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; }
export function useRef(initial) { const index = cursor++; return slots[index] ??= {current:initial}; }
export function useCallback(fn) { return fn; }
export function useEffect() {}
`);
const hookSource = (await read('../hooks/use-chat.ts'))
  .replace('react', reactUrl)
  .replace('@/lib/chat-request', requestUrl)
  .replace('@/lib/chat-stream', streamUrl)
  .replace('@/lib/experts', expertsUrl);
const { useChat } = await import(moduleUrl(hookSource));
const host = await import(reactUrl);
const render = () => {
  host.begin();
  return useChat();
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const response = (message) =>
  new Response(
    `event: request\ndata: {"requestJson":"{}"}\n\nevent: delta\ndata: ${JSON.stringify({ content: message })}\n\nevent: done\ndata: ${JSON.stringify({ finishReason: 'stop', usage, model: 'deepseek-v4-flash' })}\n\n`,
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
afterEach(() => mock.restoreAll());

test('three experts start concurrently; synthesis waits for all and receives every full answer plus original data', async () => {
  const calls = setup();
  const pending = render().send('Реши задачу', {
    council: true,
    topic: 'Алгоритмы',
    dataset: '3, 5, 8',
  });
  assert.equal(calls.length, 3);
  for (let i = 0; i < 3; i++) {
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
  let chat = render();
  chat.setSettings({ ...chat.settings, systemPrompt: 'Кратко' });
  const repeated = render().repeat();
  assert.deepEqual(calls[1].body.messages, calls[0].body.messages);
  assert.equal(calls[1].body.settings.systemPrompt, 'Кратко');
  calls[1].resolve(response('Вариант B'));
  await repeated;
  const followup = render().send('Объясни подробнее');
  assert.ok(calls[2].body.messages.some((m) => m.content === 'Вариант B'));
  calls[2].resolve(response('Пояснение'));
  await followup;
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

test('large expert answers are split losslessly into valid API messages while keeping the current question', () => {
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
  const output = synthesisMessages(history, answers);
  assert.ok(output.length <= 30);
  assert.ok(output.every((m) => m.content.length <= 12000));
  assert.ok(output.some((m) => m.content === 'Вопрос 28'));
  for (const role of EXPERT_ROLES) {
    const restored = output
      .filter((m) => m.content.startsWith(`Материал эксперта «${role.title}»`))
      .map((m) => m.content.split(/Часть \d+:\n/)[1])
      .join('');
    assert.equal(restored, content);
  }
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

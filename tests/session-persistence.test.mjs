import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const moduleUrl = (source) =>
  'data:text/javascript;base64,' +
  Buffer.from(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText).toString('base64');
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const requestUrl = moduleUrl(await read('../lib/chat-request.ts'));
const streamUrl = moduleUrl(await read('../lib/chat-stream.ts'));
const expertsUrl = moduleUrl(
  (await read('../lib/experts.ts')).replace('./chat-request', requestUrl),
);
const agentUrl = moduleUrl(
  (await read('../lib/agent.ts'))
    .replace('./chat-request', requestUrl)
    .replace('./chat-stream', streamUrl),
);
const reactUrl = moduleUrl(`
let slots = [], cursor = 0, effects = [];
export function reset() { slots = []; cursor = 0; effects = []; }
export function begin() { cursor = 0; }
export function flushEffects() { const pending = effects; effects = []; for (const effect of pending) effect(); }
export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; }
export function useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; }
export function useCallback(fn) { return fn; }
export function useEffect(effect) { effects.push(effect); }
`);
const hookSource = (await read('../hooks/use-chat.ts'))
  .replace('react', reactUrl)
  .replace('@/lib/agent', agentUrl)
  .replace('@/lib/chat-request', requestUrl)
  .replace('@/lib/experts', expertsUrl);
const { recoverSession, useChat } = await import(moduleUrl(hookSource));
const host = await import(reactUrl);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('first render does not read or overwrite localStorage before mount restoration', async () => {
  const writes = [];
  const saved = {
    activeSessionId: 'saved',
    sessions: [{
      id: 'saved', title: 'Точный', updatedAt: Date.now(),
      agent: { id: 'agent', name: 'Точный', settings: { model: 'deepseek-v4-pro' } },
      messages: [], runs: [], requestJson: null, lastRequest: null,
    }],
  };
  const previousWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: () => JSON.stringify(saved),
      setItem: (key, value) => writes.push({ key, value }),
    },
  };
  try {
    host.reset();
    host.begin();
    const initial = useChat();
    assert.equal(initial.sessions[0].title, 'Новый чат');
    assert.equal(writes.length, 0);

    host.flushEffects();
    assert.equal(writes.length, 0, 'the fallback must never overwrite storage before restore');
    await tick();
    host.begin();
    const restored = useChat();
    assert.equal(restored.sessions[0].title, 'Точный');
    host.flushEffects();
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(writes[0].value).sessions[0].title, 'Точный');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('restoration retains long outputs and turns an interrupted council run into cancelled experts', () => {
  const longOutput = 'длинный ответ '.repeat(1500);
  const metrics = (status) => ({
    model: 'deepseek-v4-flash', startedAt: 1, firstTokenAt: 2, endedAt: null, usage: null, status,
  });
  const recovered = recoverSession({
    id: 'saved', title: 'Сохранённый', updatedAt: 1,
    agent: { id: 'agent', name: 'Агент', settings: {} },
    messages: [{ id: 'answer', role: 'assistant', content: longOutput, metrics: metrics('complete') }],
    runs: [{
      id: 'run', topic: 'Тема', dataset: '',
      experts: [
        { id: 'armchair', content: longOutput, status: 'complete', metrics: metrics('complete'), requestJson: null },
        { id: 'practitioner', content: 'Частичный ответ', status: 'running', metrics: metrics('running'), requestJson: null },
        { id: 'analyst', content: '', status: 'running', metrics: metrics('running'), requestJson: null },
      ],
    }],
  });

  assert.ok(recovered);
  assert.equal(recovered.messages[0].content, longOutput);
  assert.equal(recovered.runs[0].experts[0].content, longOutput);
  assert.deepEqual(recovered.runs[0].experts.map((expert) => expert.status), ['complete', 'cancelled', 'cancelled']);
  assert.deepEqual(recovered.runs[0].experts.map((expert) => expert.metrics.status), ['complete', 'cancelled', 'cancelled']);
});

test('blocked localStorage restoration still completes the mount effect', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: () => { throw new DOMException('Blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('Blocked', 'SecurityError'); },
    },
  };
  try {
    host.reset();
    host.begin();
    useChat();
    assert.doesNotThrow(() => host.flushEffects());
    await tick();
    host.begin();
    const restored = useChat();
    assert.equal(restored.sessions.length, 1);
    assert.doesNotThrow(() => host.flushEffects());
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

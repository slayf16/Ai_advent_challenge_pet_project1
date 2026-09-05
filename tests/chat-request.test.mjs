import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(
  new URL('../lib/chat-request.ts', import.meta.url),
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
const {
  buildDeepSeekRequest,
  DEFAULT_SETTINGS,
  MAX_SYSTEM_PROMPT_LENGTH,
  settingsError,
} = await import(moduleUrl);

const messages = [{ role: 'user', content: 'Проверь текст.' }];

test('system prompt validation accepts 8,000 characters and rejects longer values', () => {
  assert.equal(
    settingsError({
      ...DEFAULT_SETTINGS,
      systemPrompt: 'x'.repeat(MAX_SYSTEM_PROMPT_LENGTH),
    }),
    null,
  );
  assert.match(
    settingsError({
      ...DEFAULT_SETTINGS,
      systemPrompt: 'x'.repeat(MAX_SYSTEM_PROMPT_LENGTH + 1),
    }),
    /8 000/,
  );
  assert.match(
    settingsError({ ...DEFAULT_SETTINGS, systemPrompt: null }),
    /Системный промпт/,
  );
});

test('empty settings omit the system message and enable usage streaming', () => {
  assert.deepEqual(buildDeepSeekRequest(messages, DEFAULT_SETTINGS), {
    model: 'deepseek-v4-flash',
    messages,
    stream: true,
    stream_options: { include_usage: true },
  });
});

test('system prompt is combined with existing response conditions', () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    systemPrompt: 'Ты строгий литературный редактор.',
    format: 'Верни два пункта.',
    maxTokens: 120,
    stopMode: 'sequence',
    stopSequence: '[END]',
  };
  const request = buildDeepSeekRequest(messages, settings);

  assert.deepEqual(request.messages.slice(1), messages);
  assert.ok(request.messages[0].content.includes(settings.systemPrompt));
  assert.ok(request.messages[0].content.includes(settings.format));
  assert.ok(request.messages[0].content.includes(JSON.stringify('[END]')));
  assert.equal(request.max_tokens, 120);
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.deepEqual(request.stop, ['[END]']);
  assert.equal(request.stream, true);
  assert.deepEqual(request.stream_options, { include_usage: true });
});

test('whitespace-only system prompt does not create a system message', () => {
  const request = buildDeepSeekRequest(messages, {
    ...DEFAULT_SETTINGS,
    systemPrompt: ' \n ',
  });
  assert.deepEqual(request.messages, messages);
});

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
const agentUrl = moduleUrl(
  (await read('../lib/agent.ts'))
    .replace('./chat-request', requestUrl)
    .replace('./chat-stream', streamUrl),
);
const { Agent } = await import(agentUrl);

test('Agent owns its settings and sends every request through the injected transport', async () => {
  const calls = [];
  const transport = {
    request: async (messages, settings, options) => {
      calls.push({ messages, settings, options });
      return { message: 'готово', finishReason: 'stop', usage: null, model: settings.model };
    },
  };
  const profile = {
    id: 'agent-1', name: 'Проверяющий',
    settings: { model: 'deepseek-v4-pro', systemPrompt: 'Проверяй факты', format: '', maxTokens: null, temperature: 0.2, stopMode: 'none', stopInstruction: '', stopSequence: '' },
  };
  const agent = new Agent(profile, transport);
  profile.settings.systemPrompt = 'наружная мутация';
  const result = await agent.request([{ role: 'user', content: 'Вопрос' }], { onDelta() {} });
  assert.equal(result.message, 'готово');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].settings.systemPrompt, 'Проверяй факты');
  assert.equal(agent.withSettings({ ...agent.settings, temperature: 0 }).toProfile().settings.temperature, 0);
});

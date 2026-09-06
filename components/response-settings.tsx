'use client';

import { RotateCcw, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import {
  DEFAULT_SETTINGS,
  MAX_SYSTEM_PROMPT_LENGTH,
  MAX_TOKENS,
  settingsError,
  type ResponseSettings,
} from '@/lib/chat-request';

type Props = {
  settings: ResponseSettings;
  onChange: (settings: ResponseSettings) => void;
  isSending: boolean;
  canRepeat: boolean;
  onRepeat: () => void;
  requestJson: string | null;
};

export function ResponseSettingsPanel({
  settings,
  onChange,
  isSending,
  canRepeat,
  onRepeat,
  requestJson,
}: Props) {
  const invalid = settingsError(settings);

  return (
    <aside
      className="min-w-0 space-y-4 lg:sticky lg:top-6 lg:self-start"
      aria-label="Параметры запроса"
    >
      <section
        className="rounded-2xl border border-white/10 bg-card/70 p-5"
        aria-labelledby="settings-title"
      >
        <h2
          id="settings-title"
          className="flex items-center gap-2 text-base font-semibold"
        >
          <SlidersHorizontal
            className="size-4 text-primary"
            aria-hidden="true"
          />
          Параметры ответа
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Все поля необязательны. Пустое поле не добавляет условий к ответу.
        </p>

        <fieldset
          disabled={isSending}
          className="mt-5 space-y-5 disabled:opacity-60"
        >
          <div className="space-y-2">
            <label
              htmlFor="system-prompt"
              className="block text-sm font-medium"
            >
              Системный промпт
            </label>
            <Textarea
              id="system-prompt"
              value={settings.systemPrompt}
              maxLength={MAX_SYSTEM_PROMPT_LENGTH}
              onChange={(event) =>
                onChange({ ...settings, systemPrompt: event.target.value })
              }
              className="min-h-32 resize-y text-sm leading-6"
              placeholder="Например: отвечай как опытный редактор технической документации…"
            />
            <p className="text-sm leading-5 text-muted-foreground">
              Задаёт роль, контекст и общие правила для модели. До 8 000
              символов.
            </p>
          </div>
          <div className="space-y-2">
            <label
              htmlFor="response-format"
              className="block text-sm font-medium"
            >
              Формат ответа
            </label>
            <Textarea
              id="response-format"
              value={settings.format}
              maxLength={2000}
              onChange={(event) =>
                onChange({ ...settings, format: event.target.value })
              }
              className="min-h-24 resize-y text-sm leading-6"
              placeholder="Например: три пункта, таблица или JSON с полями…"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="max-tokens" className="block text-sm font-medium">
              Максимум токенов
            </label>
            <Input
              id="max-tokens"
              type="number"
              min={1}
              max={MAX_TOKENS}
              step={1}
              value={
                Number.isNaN(settings.maxTokens)
                  ? ''
                  : (settings.maxTokens ?? '')
              }
              placeholder="По умолчанию DeepSeek"
              aria-describedby="tokens-hint"
              onChange={(event) =>
                onChange({
                  ...settings,
                  maxTokens:
                    event.target.value === '' && !event.target.validity.badInput
                      ? null
                      : event.target.valueAsNumber,
                })
              }
              className="h-10"
            />
            <p
              id="tokens-hint"
              className="text-sm leading-5 text-muted-foreground"
            >
              Пусто — лимит DeepSeek по умолчанию. Можно указать от 1 до 4 096
              токенов. Токен — часть текста, не слово.
            </p>
          </div>
          <div className="space-y-2">
            <label htmlFor="temperature" className="block text-sm font-medium">
              Температура
            </label>
            <Input
              id="temperature"
              type="number"
              min={0}
              max={2}
              step="any"
              value={Number.isNaN(settings.temperature) ? '' : (settings.temperature ?? '')}
              placeholder="По умолчанию DeepSeek"
              aria-describedby="temperature-hint"
              onChange={(event) =>
                onChange({
                  ...settings,
                  temperature:
                    event.target.value === '' && !event.target.validity.badInput
                      ? null
                      : event.target.valueAsNumber,
                })
              }
              className="h-10"
            />
            <p id="temperature-hint" className="text-sm leading-5 text-muted-foreground">
              От 0 до 2: ниже — более предсказуемые ответы, выше — более
              разнообразные. Пусто — настройка DeepSeek по умолчанию.
              При заданной температуре режим рассуждений отключается,
              чтобы модель учитывала её значение.
            </p>
          </div>
          <div className="space-y-2">
            <label htmlFor="stop-mode" className="block text-sm font-medium">
              Условие завершения
            </label>
            <NativeSelect
              id="stop-mode"
              value={settings.stopMode}
              className="w-full [&_select]:h-10"
              onChange={(event) =>
                onChange({
                  ...settings,
                  stopMode: event.target.value as ResponseSettings['stopMode'],
                })
              }
            >
              <NativeSelectOption value="none">Без условия</NativeSelectOption>
              <NativeSelectOption value="instruction">
                Явная инструкция
              </NativeSelectOption>
              <NativeSelectOption value="sequence">
                Стоп-строка (stop sequence)
              </NativeSelectOption>
            </NativeSelect>
          </div>
          {settings.stopMode === 'instruction' ? (
            <div className="space-y-2">
              <label
                htmlFor="stop-instruction"
                className="block text-sm font-medium"
              >
                Когда остановиться
              </label>
              <Textarea
                id="stop-instruction"
                value={settings.stopInstruction}
                maxLength={2000}
                onChange={(event) =>
                  onChange({ ...settings, stopInstruction: event.target.value })
                }
                className="min-h-24 resize-y text-sm leading-6"
                placeholder="Например: заверши ответ после третьего пункта"
              />
            </div>
          ) : settings.stopMode === 'sequence' ? (
            <div className="space-y-2">
              <label
                htmlFor="stop-sequence"
                className="block text-sm font-medium"
              >
                Стоп-строка
              </label>
              <Input
                id="stop-sequence"
                value={settings.stopSequence}
                maxLength={200}
                className="h-10 font-mono"
                placeholder="Например: [END]"
                aria-describedby="stop-hint"
                onChange={(event) =>
                  onChange({ ...settings, stopSequence: event.target.value })
                }
              />
              <p
                id="stop-hint"
                className="text-sm leading-5 text-muted-foreground"
              >
                Модель получит просьбу поставить этот маркер в конце. API
                остановится при его появлении; сам маркер в ответ не попадёт.
              </p>
            </div>
          ) : null}
        </fieldset>
        <Button
          type="button"
          variant="ghost"
          className="mt-3 h-10 w-full"
          disabled={isSending}
          onClick={() => onChange({ ...DEFAULT_SETTINGS })}
        >
          Очистить параметры
        </Button>
        {invalid && (
          <p role="alert" className="mt-4 text-sm text-red-200">
            {invalid}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          className="mt-5 h-10 w-full"
          disabled={isSending || !canRepeat || Boolean(invalid)}
          onClick={onRepeat}
        >
          <RotateCcw className="size-4" aria-hidden="true" />
          Повторить запрос
        </Button>
        <p className="mt-2 text-sm leading-5 text-muted-foreground">
          Тот же текст и контекст, текущие параметры. Предыдущий ответ останется
          в чате для сравнения.
        </p>
      </section>

      <section
        className="overflow-hidden rounded-2xl border border-white/10 bg-card/50"
        aria-labelledby="request-title"
      >
        <div className="border-b border-white/8 px-5 py-4">
          <h2 id="request-title" className="text-base font-semibold">
            JSON запроса к DeepSeek
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Тело последнего запроса. Появляется сразу после того, как сервер
            принял запрос.
          </p>
        </div>
        {requestJson ? (
          <Textarea
            readOnly
            aria-label="Отправленный JSON"
            value={JSON.stringify(JSON.parse(requestJson), null, 2)}
            className="min-h-72 max-h-96 resize-y rounded-none border-0 p-5 font-mono text-sm leading-6 text-foreground/85"
          />
        ) : (
          <output className="block p-5 text-sm leading-6 text-muted-foreground">
            {isSending
              ? 'Запрос отправлен. JSON появится, как только сервер его примет.'
              : 'Отправьте сообщение. Здесь появятся системная инструкция, история и параметры, переданные API.'}
          </output>
        )}
      </section>
    </aside>
  );
}

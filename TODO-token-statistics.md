# DeepChat — текущий статус, 14 сентября 2026

В этом development-этапе реализованы порционное summary, atomic giant checkpoint, Sliding Window, Sticky Facts и две sibling-ветки A/B. Реальные запросы к провайдерам, commit, push и deploy не выполнялись.

## Текущие проверки и доказательства

- `node --test tests/*.test.mjs`: **95/95**. Stateful hook/replaceable transport покрывает порог summary и порции по пять, failure/abort boundary, 24 001 raw, 72 000 previous summary, 350k giant persistence/recover/no-refold, `none` capacity и actual transport caps.
- `tests/orchestration.test.mjs`: giant success→recover→next send, middle failure; actual summary/main payloads; Facts update/correction/deletion/persistence/retry without extractor and invalid/error/cancel; sibling A/B switch/recover/retry with isolated suffix.
- `tests/session-persistence.test.mjs` покрывает requestIds после reload, independent partial usage и boundary; `tests/chat-metrics.test.mjs` — unknown timer/cache/reasoning coverage; `tests/statistics.test.mjs` — immutable statistics and 11+23=34 aggregate.
- TypeScript, oxlint и production build прошли. UI QA с mock origin ещё выполняется отдельно; реальный backend не использовался.

## Исторический журнал

### Follow-up, review и QA до текущих циклов

Исторические follow-up результаты сохранены без изменения: developer **85/85**, затем **89/89** mock/unit tests; отдельный mock-UI прогон подтвердил legacy input 11+23=34, persist `none`, summary modal/tail 5, удаление и reload. Независимое review позднее выявило giant-checkpoint P1; он закрыт текущей stateful giant regression. Эти записи отражают состояние до current 95/95 и не являются текущими claims.

Исторический UI прогон использовал только изолированный mock origin и шесть локальных `/api/chat` вызовов; реальный backend и пользовательские сохранённые чаты не использовались. Следующий UI QA cycle1 mock-origin также подтвердил Sliding, Facts и sibling A/B; он не заменяет реальный API тест.

Подтверждённое пользовательское историческое состояние публикации: `main` был ранее pushed как `d19efa51b807aa3ea93daf55e3b011299fd4a49f` («задание 9»). В текущих cycle1/cycle2 commit, push и deploy не выполнялись.

Обновлено оркестратором по результатам независимого review и реального API-теста. После review исполняемый код не менялся. Коммит/push/deploy не выполнялись.

## Исторические замечания, закрытые ранее

- [x] Контекст хранит raw-историю для UI и отдельный атомарный summary; 10 сообщений сжимаются выбранной моделью только перед следующим основным запросом. Повтор использует snapshot без пересжатия.
- [x] Добавлена `/statistics`: immutable localStorage-снимки чата/агента/модели, сравнение usage, стоимости и средней скорости с покрытием; удаление чата и снимка независимы.
- [x] Добавлено удаление одного чата с подтверждением, выбором соседнего и созданием нового Flash-чата при удалении последнего.
- [x] Council validation выполняется до summary: пустая/слишком длинная тема, данные и недопустимое сочетание role-настроек не создают платный запрос и не оставляют send state активным.
- [x] Aggregate statistics сохраняет независимые partial usage и стоимость известной части без вывода total из несовместимых данных.

- [x] **P2 request links after reload.** Закрыто `tests/session-persistence.test.mjs` (normal/retry IDs survive recovery) и `tests/statistics.test.mjs` (input 11+23=34).
- [x] **P2 expert stable IDs.** Закрыто `tests/orchestration.test.mjs`: expert physical metrics are linked once to the user and survive the completed run.
- [x] **P2 unknown aggregate timer.** Закрыто `tests/chat-metrics.test.mjs`: restored/unknown terminal time is not extended by offline wall time.
- [x] **P2 cache-only/reasoning-only usage.** Закрыто `tests/session-persistence.test.mjs` and `tests/chat-metrics.test.mjs`: independent usage fields survive recovery.
- [x] **Текст.** `app/page.tsx` uses «Расход за весь диалог».
- [x] **Покрытие.** Historical 66-test baseline is superseded by current 95-test suite.

## Подтверждено исправленным

- [x] Убраны приблизительные оценки текста и денежные ориентиры UTF8/4.
- [x] Обычный запрос и retry показывают вход API по явным связям до reload.
- [x] Completion-only и prompt-only usage сохраняются после restore; выходная цена считается из completion и снимка тарифа.
- [x] У ответа показываются выходные токены и разложение на ответ/рассуждения при достоверном reasoning.
- [x] Полная цена запроса присутствует в details при достаточных данных.
- [x] Покрытие токенов и тарифов объясняется раздельно.
- [x] Индивидуальная длительность восстановленного запроса при неизвестных/несовместимых временах не выдаётся за известное время.
- [x] Сумма API группы учитывает четыре физических вызова один раз: mock 10/5/15 на вызов → 40/20/60.
- [x] README metrics paragraph обновлён под статистику API.

## Реальный тест

Один POST /api/chat через реальный streamChat проекта. Запрос: «привет, подскажи пожалуйста какие типы ядерных реакторов бывают». Запрошена default deepseek-v4-flash, API вернул deepseek-flash. Успешный stop, 9.782 секунды.

- Вход49 + выход1891 = всего1940.
- Рассуждения860 входят в выход; остаток ответа1031.
- Cache hit0 / miss49.
- Расчётная цена по snapshot Flash: вход $0.00001078, выход $0.00124806, всего $0.00125884.
- UI не проверен: доступных браузеров нет. Live API проверен прямым вызовом localhost; повторного запроса не было.

Пути и строки относятся к проекту C:\Users\AMK29\Documents\Codex\2026-09-03\new-chat-3\outputs\deepseek-chat на момент review. Этот TODO отражает текущий результат и заменяет старый список четырёх пунктов.

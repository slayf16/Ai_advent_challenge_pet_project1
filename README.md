# Ai_advent_challenge_pet_project1

Простое веб-приложение для общения с DeepSeek. Интерфейс отправляет историю диалога во внутренний серверный маршрут, а тот обращается к DeepSeek API. API-ключ хранится только на сервере и не передаётся в браузер.

## Возможности

- диалог с моделью `deepseek-v4-flash`;
- отправка по Enter и перенос строки по Shift+Enter;
- отображение истории, процесса загрузки и понятных ошибок;
- создание нового диалога без перезагрузки страницы;
- адаптивный тёмный интерфейс;
- серверная проверка формата и размера сообщений;
- интеграция WebMCP-инструмента `send_deepseek_message` для поддерживаемых окружений.

## Стек

- TypeScript, React 19;
- vinext, Vite и React Server Components;
- Tailwind CSS 4 и shadcn/ui;
- Cloudflare Workers / Wrangler;
- DeepSeek Chat Completions API.

Требуется Node.js `22.13.0` или новее.

## Структура проекта

```text
app/
  api/chat/route.ts  # серверный прокси к DeepSeek API
  page.tsx           # клиентский чат, состояние и отправка сообщений
  layout.tsx         # корневой layout и метаданные страницы
  globals.css        # глобальные стили и тема
components/ui/       # переиспользуемые UI-компоненты
hooks/               # React-хуки
lib/utils.ts         # вспомогательные функции для UI
public/              # статические файлы
.openai/hosting.json # конфигурация хостинга Sites
.env.example         # пример переменной окружения без реального ключа
package.json         # зависимости и npm-команды
vite.config.ts       # конфигурация Vite, vinext и Cloudflare
tsconfig.json        # настройки TypeScript
```

Поток запроса:

```text
Браузер → POST /api/chat → DeepSeek API → /api/chat → браузер
```

Маршрут `app/api/chat/route.ts` добавляет системное сообщение, ограничивает историю 30 сообщениями и длину каждого сообщения 12 000 символами, устанавливает тайм-аут запроса и нормализует ошибки внешнего API.

## Локальный запуск

1. Клонируйте репозиторий и перейдите в него:

   ```bash
   git clone https://github.com/<ваш-логин>/Ai_advent_challenge_pet_project1.git
   cd Ai_advent_challenge_pet_project1
   ```

2. Установите зависимости:

   ```bash
   npm install
   ```

3. Создайте `.env.local` на основе примера:

   ```bash
   cp .env.example .env.local
   ```

   В Windows PowerShell используйте:

   ```powershell
   Copy-Item .env.example .env.local
   ```

4. Запишите в `.env.local` свой ключ DeepSeek:

   ```dotenv
   DEEPSEEK_API_KEY=your_real_deepseek_api_key
   ```

5. Запустите режим разработки:

   ```bash
   npm run dev
   ```

   Откройте адрес, указанный в терминале (обычно `http://localhost:3000`).

## Сборка и запуск production-версии

```bash
npm run build
npm start
```

Дополнительные команды:

```bash
npm run lint    # проверка кода
npm run format  # форматирование
```

## Безопасность

- Никогда не добавляйте настоящий API-ключ в исходный код, README, issue или commit.
- Не коммитьте `.env`, `.env.local` и другие `.env*`-файлы — они исключены через `.gitignore`.
- В репозитории должен оставаться только `.env.example` с фиктивным значением.
- При публикации задавайте `DEEPSEEK_API_KEY` как секрет или серверную переменную окружения на платформе хостинга.
- Если ключ случайно попал в Git, немедленно отзовите его в DeepSeek и создайте новый: удаления файла из последнего commit недостаточно.

## API приложения

`POST /api/chat` принимает JSON:

```json
{
  "messages": [
    { "role": "user", "content": "Привет!" }
  ]
}
```

Успешный ответ:

```json
{
  "message": "Ответ модели",
  "model": "deepseek-v4-flash"
}
```

Клиенту не требуется и не следует передавать `DEEPSEEK_API_KEY`: сервер читает его из переменной окружения и самостоятельно добавляет заголовок авторизации при запросе к `https://api.deepseek.com/chat/completions`.

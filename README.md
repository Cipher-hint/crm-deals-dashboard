# Дашборд сделок CRM

Встраиваемое приложение для Битрикс24 (платформа Вайбкод): аналитика по сделкам CRM.

## Что показывает

- сводку по стадиям воронки: количество и сумма;
- KPI: сумма открытых сделок, число выигранных за период, средний чек;
- последние 20 сделок;
- фильтр по дате создания (7 / 30 / 90 дней, всё время, произвольный диапазон).

Приложение читает CRM через VibeCode Entity API от лица владельца личного ключа. Отдельный логин пользователей не нужен.

## Живое приложение

- URL: https://app-bfeac934a09d.vibecode.bitrix24.tech
- Встраивание: пункт левого меню Битрикс24 **Дашборд сделок** (`LEFT_MENU`)
- Версия: 1.1.1 · разработчик [safekit.tech](https://safekit.tech) · поддержка support@safekit.tech
- Исходный код: https://github.com/Cipher-hint/crm-deals-dashboard

## Локальный запуск

```bash
cp .env.example .env
# впишите VIBE_API_KEY=vibe_api_…
npm install
npm start
```

Откройте `http://localhost:3000`.

## Деплой на VibeCode

1. Создайте galaxy-приложение: `POST /v1/infra/servers` с `name`, `source`, `runtime: node20`, `start: node server.js`.
2. Передайте ключ только в `env.VIBE_API_KEY` — не кладите его в архив.
3. Зарегистрируйте OAuth-приложение со скоупами `crm`, `user`, `placement` и опубликуйте с местом `LEFT_MENU`.
4. На каждый деплой передайте полный `env` заново (платформа не хранит секреты между выкладками).

История изменений: [CHANGELOG.md](CHANGELOG.md).

## Материалы для проверки

См. [DESCRIPTION.md](DESCRIPTION.md).

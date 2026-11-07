# Контракты данных и API

Единственный источник правды о форматах. Меняется только по договорённости команды, одним коммитом.

## 1. Conversation (как отдаёт API организаторов)
```json
{
  "conversation_id": "p1-ru-001",
  "channel": "agent chat",            // "agent chat" | "voice call"
  "language": "RU",                    // "RU" | "KZ" | "EN"
  "transcript": [
    { "timestamp": "00:02", "speaker": "operator", "text": "Здравствуйте!" }
  ],
  "audio_url": null                    // строка у звонков
}
```
- `speaker`: `client` | `operator` | `bot` | `system`
- `timestamp`: чаты — `MM:SS`; звонки — ISO 8601 с часовым поясом. Храним как есть.
- **Индекс реплики** = позиция в `transcript` (0-based). Используется как `msg_id` везде.
- Для звонков сервер добавляет вычисляемое поле `offset_sec` к каждой реплике
  (секунды от первой реплики) — для перемотки плеера. Исходный `timestamp` не трогаем.

Хранилище: `storage/db.json` (без SQLite). Источник: `GET {DATA_API_URL}?group_id=<id>` → `{ error, isSuccess, data: { dataset_group_id, total_records, records: [...] } }`.

## 2. Checklist (версия)
См. `config/checklist_v1.json`.
```json
{
  "id": "cqa-chat-v1",
  "name": "string",
  "version": 1,
  "rounding": 2,
  "max_total": 100,
  "first_response_threshold_sec": 180,
  "sections": [ { "id": "start", "title": "string" } ],
  "criteria": [
    {
      "id": "c04",
      "section": "safety",
      "title": "string",
      "type": "binary | scale | critical_flag",
      "weight": 20,                   // 0 у critical_flag
      "na_allowed": true,
      "yes_rule": "string",           // binary / critical_flag
      "na_rule": "string",            // если na_allowed
      "note": "string",               // опционально
      "scale": [ { "value": 20, "label": "string" } ]   // только scale, по убыванию
    }
  ]
}
```
Правила: `id` критерия стабилен между версиями; при замене критерия — новый `id`.
Сохранение = новая запись с `version + 1`.

## 3. LLM output (что возвращает модель — валидирует server/llm/evaluate.js)
```json
{
  "criteria": [
    {
      "criterion_id": "c01",
      "answer": "yes",                // binary/critical_flag: "yes" | "no" | "na"
      "scale_value": null,            // scale: одно из scale[].value или null при "na"
      "explanation": "Оператор поздоровался по-русски и представился в первой реплике.",
      "evidence_ids": [2],            // msg_id; для «нет» — где действие ожидалось
      "checked_range": null           // для «нет»: [from_id, to_id] проверенный участок
    }
  ]
}
```
Валидация: все `criterion_id` из чек-листа присутствуют ровно по разу; `na` только при `na_allowed`;
`scale_value` из шкалы; `evidence_ids` в пределах транскрипта; для `na` объяснение называет условие.
Невалидно → 1 ретрай с текстом ошибки → иначе статус `error`.
Для scale-критериев `answer` = `"na"` или `"scored"`.

## 4. Evaluation (хранится в БД, отдаётся фронтенду)
```json
{
  "evaluation_id": "ev_...",
  "conversation_id": "p1-ru-001",
  "checklist_id": "cqa-chat-v1",
  "checklist_version": 1,
  "model": "claude-sonnet-5-5",
  "created_at": "ISO",
  "status": "done",                    // "pending" | "done" | "error"
  "items": [
    {
      "criterion_id": "c04",
      "section": "safety",
      "title": "Корректная и полная консультация",
      "type": "scale",
      "answer": "scored",
      "scale_value": 15,
      "weight": 20,
      "effective_weight": 26.67,       // после перераспределения N/A
      "points": 20.0,                  // effective_weight * доля
      "explanation": "string",
      "evidence_ids": [7, 9],
      "checked_range": null,
      "overridden": false              // true, если изменено решением по апелляции
    }
  ],
  "sections": [ { "id": "safety", "points": 45.0, "max": 53.33 } ],
  "total": 87.33,                      // null, если нет применимых весовых критериев
  "critical_error": false,
  "original_total": 87.33,             // итог до апелляций
  "usage": { "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "latency_ms": 0 }
}
```

### Расчёт итога (server/scoring.js)
1. Применимые = весовые критерии (`weight > 0`), где `answer != "na"`.
2. Доля: binary `yes`=1, `no`=0; scale `scale_value / max(scale.value)`.
3. `W = Σ weight` применимых. Если `W = 0` → `total = null`.
4. `effective_weight = weight * 100 / W`; `points = effective_weight * доля`.
5. `total = round(Σ points, rounding)`.
6. `critical_error = (c08.answer == "yes")` — на `total` не влияет, показывается отдельно.
Пример: N/A у c03, c07 → W=75; 10+15+15+15+10.5 = 65.5 → 65.5/75·100 = **87.33**.

## 5. Appeal
```json
{
  "appeal_id": "ap_...",
  "evaluation_id": "ev_...",
  "criterion_id": "c05",
  "comment": "Оператор извинился в реплике 6",
  "evidence_ids": [6],                 // опционально, указал заявитель
  "status": "open",                    // "open" | "resolved"
  "created_at": "ISO",
  "decision": null
}
```
### Decision (решение проверяющего)
```json
{
  "action": "confirm",                 // "confirm" | "change"
  "new_answer": "yes",                 // при change
  "new_scale_value": null,             // при change для scale
  "reason": "string",                  // обязательно
  "decided_at": "ISO",
  "total_before": 80.0,
  "total_after": 95.0
}
```
При `change` сервер пересчитывает итог через `scoring.js`, ставит `overridden: true` у критерия.
Исходная оценка модели не удаляется (хранится в `evaluation_items_original`).

## 6. REST API (backend, префикс /api)
| Метод | Путь | Назначение |
|---|---|---|
| POST | `/datasets/load` | `{ group_id }` → тянет набор у организаторов, сохраняет диалоги |
| GET | `/conversations?group_id=&language=&channel=` | список (без транскриптов) + статус и итог последней оценки |
| GET | `/conversations/:id` | диалог с транскриптом (+ `offset_sec` для звонков) |
| GET | `/checklists` | все чек-листы, последние версии |
| GET | `/checklists/:id/versions/:v` | конкретная версия |
| POST | `/checklists` | сохранить (создаёт новую версию), тело — Checklist без `version` |
| POST | `/evaluations` | `{ conversation_id, checklist_id, checklist_version? }` → Evaluation |
| POST | `/evaluations/batch` | `{ group_id, checklist_id }` → `{ job_id }` |
| GET | `/evaluations/batch/:job_id` | `{ total, done, failed }` |
| GET | `/evaluations/:id` | Evaluation + апелляции |
| GET | `/conversations/:id/evaluations` | история оценок по версиям чек-листа |
| POST | `/appeals` | создать Appeal |
| GET | `/appeals?status=open` | очередь проверяющего (с фрагментом диалога и спорной оценкой) |
| POST | `/appeals/:id/decision` | Decision → обновлённая Evaluation |
| GET | `/audio?url=` | прокси аудио звонка (если CORS) |

Ошибки: `{ "error": "message" }` + HTTP 4xx/5xx.

## 7. Frontend события (Web Components)
- `cqa:evidence-click` `{ msg_id }` → `<cqa-transcript>` скроллит и подсвечивает; для звонка `<cqa-audio-player>` перематывает на `offset_sec`.
- `cqa:evaluation-updated` `{ evaluation }` → перерисовать карточку и список.
- `cqa:checklist-saved` `{ checklist_id, version }`.

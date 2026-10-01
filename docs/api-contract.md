# Контракт API (api-gateway ↔ frontend)

Базовый префикс REST: `/api`. WebSocket: `/ws/live?token=<JWT>`.
Аутентификация: `Authorization: Bearer <JWT>`. Роли: `dispatcher` (диспетчер) и `admin` (админ: настройки индекса и оптимизатора).
Примеры реальных сообщений лежат в `docs/samples/*.json`.

## Время
`sim_time` — модельные секунды от старта сценария. Время суток = `start_clock` (из `/api/station`, например `"06:00"`) + `sim_time`.
Модель идёт быстрее реального времени (`time_scale`, по умолчанию 20: 1 с реальная = 20 с модельных).

## WebSocket `/ws/live`
Сервер → клиент:

| type | когда | содержимое |
|---|---|---|
| `hello` | сразу после подключения | `station` (как `GET /api/station`), `index_config`, `planner_config`, `time_scale`, `user` |
| `frame` | каждый тик (2 Гц; в режиме стресса чаще) | `seq`, `emitted_at` (мс, время генерации события в симуляторе), `state` (снимок мира ИИ), `index`, `compare` {baseline, ai}: {kpi, index}, `link` (статусы сервисов) |
| `plan` | при каждом новом плане | `plan` (см. ниже) |
| `variants` | после инцидента | `incident`, `variants[]` (каждый как `plan`), `applied` (id применённого) |
| `events` | при новых событиях | `events[]`: {t, type, text, world, train?, track?, loco?, severity?} |
| `ping` | раз в 5 с | — клиент отвечает `{"type":"pong"}` |

После reconnect сервер снова присылает `hello`, последний `plan`, последние `variants` и полный `frame`.

### state (снимок мира)
- `trains[]`: `id, cat (pass|freight_transit|freight_local), length_m, side_in, side_out (W|E), status, reason, reason_text, track, pos_m (до входного сигнала), speed_kmh, planned_arr, planned_dep, eta, entered_at, service_done_at, ready_at, departed_at, loco, crew, regulated, advisory_kmh, stopped_at_signal, delay_s, res_wait_s`
  - `status`: `approaching` (на подходе), `held` (удержан на предыдущей станции), `at_signal` (стоит у входного сигнала), `entering` (приём), `on_track` (на пути), `departing`, `departed`, `rerouted`
- `upcoming[]`: поезда графика, которые ещё не вышли на подход (`status: scheduled`)
- `tracks[]`: `id, status (free|occupied|closed|reserve), train, closed_until`
- `ladders[]`: занятые стрелочные улицы `id, busy_until, train`
- `locos[]` / `crews[]`: `id, status, train, until`
- `kpi`: `throughput_ratio, departed_1h, due_1h, avg_deviation_min, utilization, occupied_tracks, open_tracks, conflicts, blocked_now, avg_resource_wait_min, locos_idle, locos_total, crews_idle, queue_len, avg_entry_wait_min, signal_stops_1h, total_departed`

### index
`value` (0–100), `grade` (A–E), `category` {id: norm|warning|critical, name, color, reason}, `factors[]` {id, name, weight, score, points, loss, why, description}, `top[]` (5 факторов с наибольшей потерей баллов).

### plan
`version, sim_time, variant, variant_name, assignments{train_id: {track, entry_at?, dep_at, loco?, loco_at?, crew?, crew_at?, loco_missing?}}, solver {engine: cp-sat|greedy, status, objective, time_ms}, projected_kpi, projected_index, conflicts[] {type, severity, text, resolved, resolution}, recommendations[] {id, severity: critical|high|medium|info, kind, title, text, action|null}, total_ms`

## REST
| Метод | Путь | Роль | Описание |
|---|---|---|---|
| POST | `/api/auth/login` | — | `{username, password}` → `{token, role, username}` |
| GET | `/api/station` | любой | схема станции |
| GET | `/api/state` | любой | последний `frame` |
| GET | `/api/plan` | любой | текущий план |
| GET | `/api/plan/variants` | любой | последние варианты |
| POST | `/api/plan/apply` | dispatcher | `{variant}` применить вариант |
| POST | `/api/incidents` | dispatcher | `{type: close_track|delay|loco_failure, track?, train?, minutes?, duration_min?, loco?}` |
| POST | `/api/incidents/stress` | dispatcher | несколько сбоев одновременно + поток событий ×10 на 30 с |
| POST | `/api/actions` | dispatcher | `{type: open_track|reroute|add_loco|add_crew, ...}` — принять рекомендацию |
| GET | `/api/history/timeline?minutes=15` | любой | `{points: [{ts, sim_time, index_ai, index_baseline, queue_ai, queue_baseline}]}` |
| GET | `/api/history/frame?ts=<ms>` | любой | ближайший сохранённый `frame` (+ `plan`) для перемотки |
| GET | `/api/index` | любой | индекс мира ИИ |
| GET/PUT | `/api/config/index` | GET любой, PUT admin | веса и пороги индекса |
| GET/PUT | `/api/config/planner` | GET любой, PUT admin | параметры оптимизатора |
| POST | `/api/sim/speed` | admin | `{time_scale}` |
| GET | `/api/reports/summary.csv?minutes=60` | любой | мини-отчёт CSV |
| GET | `/api/reports/summary.pdf?minutes=60` | любой | мини-отчёт PDF |
| GET | `/api/health` | — | статус сервиса и зависимостей |
| GET | `/metrics` | — | Prometheus |

Демо-пользователи (пароли из `.env`): `dispatcher / dispatcher`, `admin / admin`.

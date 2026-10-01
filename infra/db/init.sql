-- Схема хранилища истории (TimescaleDB). Применяется api при старте (идемпотентно).
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Полные кадры для «перемотки» (ретеншн 6 ч — кадры тяжёлые)
CREATE TABLE IF NOT EXISTS frames (
    ts        TIMESTAMPTZ NOT NULL,
    sim_time  INTEGER     NOT NULL,
    plan_version INTEGER,
    frame     JSONB       NOT NULL
);
SELECT create_hypertable('frames', 'ts', if_not_exists => TRUE, chunk_time_interval => INTERVAL '1 hour');
SELECT add_retention_policy('frames', INTERVAL '6 hours', if_not_exists => TRUE);

-- KPI и индекс обоих миров (ретеншн 72 ч)
CREATE TABLE IF NOT EXISTS kpi (
    ts        TIMESTAMPTZ NOT NULL,
    world     TEXT        NOT NULL,
    sim_time  INTEGER     NOT NULL,
    index_value REAL      NOT NULL,
    category  TEXT        NOT NULL,
    queue_len INTEGER,
    avg_entry_wait_min REAL,
    avg_deviation_min  REAL,
    throughput_ratio   REAL,
    utilization        REAL,
    conflicts          INTEGER,
    avg_resource_wait_min REAL,
    departed_1h        INTEGER
);
SELECT create_hypertable('kpi', 'ts', if_not_exists => TRUE, chunk_time_interval => INTERVAL '6 hours');
SELECT add_retention_policy('kpi', INTERVAL '72 hours', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS kpi_world_ts ON kpi (world, ts DESC);

CREATE TABLE IF NOT EXISTS events (
    ts       TIMESTAMPTZ NOT NULL,
    world    TEXT,
    sim_time INTEGER,
    type     TEXT,
    text     TEXT,
    payload  JSONB
);
SELECT create_hypertable('events', 'ts', if_not_exists => TRUE, chunk_time_interval => INTERVAL '6 hours');
SELECT add_retention_policy('events', INTERVAL '72 hours', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS plans (
    ts       TIMESTAMPTZ NOT NULL,
    version  INTEGER     NOT NULL,
    sim_time INTEGER,
    trigger  TEXT,
    engine   TEXT,
    solve_ms INTEGER,
    projected_index REAL,
    plan     JSONB       NOT NULL
);
SELECT create_hypertable('plans', 'ts', if_not_exists => TRUE, chunk_time_interval => INTERVAL '1 hour');
SELECT add_retention_policy('plans', INTERVAL '24 hours', if_not_exists => TRUE);

-- Настройки индекса и оптимизатора, изменённые через UI (поверх YAML-дефолтов)
CREATE TABLE IF NOT EXISTS config (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

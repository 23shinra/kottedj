# Единый образ для Python-сервисов (simulator, ingest, planner, api); сервис выбирается командой в compose.
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    CONFIG_DIR=/app/config DB_INIT_SQL=/app/infra/db/init.sql
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY services/requirements.txt services/requirements.txt
RUN pip install -r services/requirements.txt
COPY shared shared
RUN pip install ./shared
COPY services services
COPY config config
COPY infra/db infra/db
RUN useradd -r -u 10001 app && chown -R app /app
USER app

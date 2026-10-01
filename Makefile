.PHONY: up down logs ps test bench demo dev-venv fmt

up:            ## Поднять весь стенд (docker compose)
	@test -f .env || cp .env.example .env
	docker compose up -d --build
	@echo "Дашборд:  http://localhost:8080   (dispatcher/dispatcher, admin/admin)"
	@echo "Swagger:  http://localhost:8000/docs"
	@echo "Grafana:  http://localhost:3000"

down:
	docker compose down

logs:
	docker compose logs -f --tail 50 simulator ingest planner api

ps:
	docker compose ps

dev-venv:      ## Локальное окружение для тестов и бенчмарка (нужен uv)
	uv venv --python 3.11 .venv
	uv pip install --python .venv/bin/python -r services/requirements.txt pytest httpx

test:          ## Unit-тесты: допустимость плана, индекс, обработка потока, двойник
	.venv/bin/python -m pytest tests -q

bench:         ## Офлайн-сравнение FCFS и ИИ на 12 часах «час пик»
	.venv/bin/python bench/compare.py --hours 12 --replan-min 1 --time-limit 1.0 --json bench/results.json

demo:          ## Сквозной сценарий на живом стенде: сбой, варианты, стресс, история, отчёты
	.venv/bin/python scripts/demo_check.py

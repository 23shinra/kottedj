"""Сквозной тестовый сценарий на живом стенде (docker compose up):
вход → WebSocket → задержка кадров → сбой «закрытие пути» → варианты и время перепланирования →
применение варианта → стресс ×10 → история и отчёты.

    python scripts/demo_check.py [--base http://localhost:8000]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time

import httpx
import websockets


async def main(base: str) -> None:
    async with httpx.AsyncClient(base_url=base, timeout=30) as http:
        r = await http.post("/api/auth/login", json={"username": "dispatcher", "password": "dispatcher"})
        r.raise_for_status()
        token = r.json()["token"]
        h = {"Authorization": f"Bearer {token}"}
        r = await http.put("/api/config/index", json={}, headers=h)
        print(f"[доступ] dispatcher → PUT /config/index: {r.status_code} (ожидается 403)")

        ws_url = base.replace("http", "ws") + f"/ws/live?token={token}"
        async with websockets.connect(ws_url, max_size=2 ** 24) as ws:
            lat, kinds = [], {}
            t_end = time.time() + 5
            while time.time() < t_end:
                m = json.loads(await ws.recv())
                kinds[m["type"]] = kinds.get(m["type"], 0) + 1
                if m["type"] == "frame":
                    lat.append(time.time() * 1000 - m["emitted_at"])
                    frame = m
            print(f"[поток] сообщений: {kinds}; задержка событие→клиент: "
                  f"медиана {statistics.median(lat):.0f} мс, макс {max(lat):.0f} мс")
            ix = frame["index"]
            print(f"[индекс] ИИ {ix['value']} ({ix['grade']}, {ix['category']['name']}), "
                  f"FCFS {frame['compare'].get('baseline', {}).get('index', {}).get('value')}")

            track = next(t["id"] for t in frame["state"]["tracks"] if t["status"] == "occupied")
            t0 = time.time()
            await http.post("/api/incidents", json={"type": "close_track", "track": track, "duration_min": 40}, headers=h)
            variants = None
            while time.time() - t0 < 15:
                m = json.loads(await ws.recv())
                if m["type"] == "variants" and m.get("created_at", 0) > t0:
                    variants = m
                    break
            dt = (time.time() - t0) * 1000
            print(f"[сбой] путь {track} закрыт → варианты получены через {dt:.0f} мс (расчёт {variants['replan_ms']} мс)")
            for v in variants["variants"]:
                print(f"    {v['variant_name']:<28} индекс {v['projected_index']['value']:>5}  "
                      f"ожидание {v['projected_kpi']['avg_entry_wait_min']:>5} мин  решатель {v['solver']['time_ms']} мс"
                      + ("  ← применён" if v["variant"] == variants["applied"] else ""))
            other = next(v["variant"] for v in variants["variants"] if v["variant"] != variants["applied"])
            await http.post("/api/plan/apply", json={"variant": other}, headers=h)
            while True:
                m = json.loads(await ws.recv())
                if m["type"] == "plan" and m["plan"].get("trigger") == "manual":
                    print(f"[вариант] применён вручную: {m['plan']['variant_name']}")
                    break

            r = await http.post("/api/incidents/stress", headers=h)
            print(f"[стресс] внесено команд: {len(r.json()['commands'])}")
            lat, frames, t_end = [], 0, time.time() + 10
            while time.time() < t_end:
                m = json.loads(await ws.recv())
                if m["type"] == "frame":
                    frames += 1
                    lat.append(time.time() * 1000 - m["emitted_at"])
            print(f"[стресс] кадров за 10 с: {frames} ({frames / 10:.0f}/с), задержка медиана "
                  f"{statistics.median(lat):.0f} мс, p95 {sorted(lat)[int(len(lat) * .95)]:.0f} мс")

        r = await http.get("/api/history/timeline", params={"minutes": 15}, headers=h)
        pts = r.json()["points"]
        print(f"[история] точек за 15 мин: {len(pts)}")
        if pts:
            r = await http.get("/api/history/frame", params={"ts": pts[0]["ts"]}, headers=h)
            print(f"[перемотка] кадр на {pts[0]['ts']}: sim_time={r.json()['state']['sim_time']}")
        for fmt in ("csv", "pdf"):
            r = await http.get(f"/api/reports/summary.{fmt}", params={"minutes": 30}, headers=h)
            print(f"[отчёт] {fmt.upper()}: {r.status_code}, {len(r.content)} байт")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8000")
    asyncio.run(main(ap.parse_args().base))

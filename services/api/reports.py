"""Мини-отчёт за период: CSV и PDF (reportlab, кириллица через DejaVu)."""
from __future__ import annotations

import csv
import io
import os
import time
from typing import Any

from reportlab.graphics.charts.lineplots import LinePlot
from reportlab.graphics.shapes import Drawing, String
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from dstation.planner.analysis import fmt_clock

_FONT_CANDIDATES = [
    os.environ.get("PDF_FONT", ""),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
]
_FONT = "Helvetica"
for _p in _FONT_CANDIDATES:
    if _p and os.path.exists(_p):
        pdfmetrics.registerFont(TTFont("Body", _p))
        _FONT = "Body"
        break

KPI_ROWS = [
    ("Индекс эффективности", "index", "{:.1f}"),
    ("Очередь на подходе, поездов", "queue_len", "{:.0f}"),
    ("Среднее ожидание приёма, мин", "avg_entry_wait_min", "{:.1f}"),
    ("Отклонение от графика, мин", "avg_deviation_min", "{:.1f}"),
    ("Пропускная (факт/план)", "throughput_ratio", "{:.0%}"),
    ("Загрузка путей", "utilization", "{:.0%}"),
    ("Конфликты", "conflicts", "{:.0f}"),
    ("Ожидание ресурсов, мин", "avg_resource_wait_min", "{:.1f}"),
]


def _avg(rows: list[dict[str, Any]], world: str, key: str) -> float | None:
    vals = [r[key] for r in rows if r["world"] == world and r.get(key) is not None]
    return sum(vals) / len(vals) if vals else None


def summary(kpis: list[dict[str, Any]]) -> list[tuple[str, str, str, str]]:
    out = []
    for name, key, fmt in KPI_ROWS:
        b, a = _avg(kpis, "baseline", key), _avg(kpis, "ai", key)
        if b is None or a is None:
            continue
        delta = f"{(a - b) / b * 100:+.0f}%" if b else "—"
        out.append((name, fmt.format(b), fmt.format(a), delta))
    return out


def to_csv(kpis: list[dict[str, Any]], events: list[dict[str, Any]], clock: str, minutes: float) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["Цифровая станция — мини-отчёт", time.strftime("%Y-%m-%d %H:%M"), f"период {minutes:.0f} мин"])
    w.writerow([])
    w.writerow(["Показатель (среднее за период)", "Без ИИ (FCFS)", "С ИИ", "Δ"])
    for row in summary(kpis):
        w.writerow(row)
    w.writerow([])
    w.writerow(["ts", "время модели", "мир", "индекс", "категория", "очередь", "ожидание_мин", "отклонение_мин",
                "пропускная", "загрузка", "конфликты", "ожидание_ресурсов_мин"])
    for r in kpis:
        w.writerow([r["ts"], fmt_clock(r["sim_time"], clock), r["world"], r["index"], r["category"], r["queue_len"],
                    r["avg_entry_wait_min"], r["avg_deviation_min"], r["throughput_ratio"], r["utilization"],
                    r["conflicts"], r["avg_resource_wait_min"]])
    w.writerow([])
    w.writerow(["События (мир ИИ)"])
    w.writerow(["время модели", "тип", "описание"])
    for e in events:
        w.writerow([fmt_clock(e.get("t", 0), clock), e.get("type"), e.get("text")])
    return ("﻿" + buf.getvalue()).encode("utf-8")    # BOM — чтобы Excel открыл кириллицу


def _chart(kpis: list[dict[str, Any]]) -> Drawing:
    d = Drawing(170 * mm, 60 * mm)
    lp = LinePlot()
    lp.x, lp.y, lp.width, lp.height = 12 * mm, 8 * mm, 150 * mm, 45 * mm
    series = []
    for world in ("baseline", "ai"):
        pts = [(r["sim_time"] / 60, r["index"]) for r in kpis if r["world"] == world]
        step = max(1, len(pts) // 300)
        series.append(pts[::step] or [(0, 0)])
    lp.data = series
    lp.lines[0].strokeColor = colors.HexColor("#9aa4b2")
    lp.lines[1].strokeColor = colors.HexColor("#2f80ed")
    lp.lines[0].strokeWidth = lp.lines[1].strokeWidth = 1.5
    lp.yValueAxis.valueMin, lp.yValueAxis.valueMax = 0, 100
    lp.xValueAxis.labels.fontName = lp.yValueAxis.labels.fontName = _FONT
    lp.xValueAxis.labels.fontSize = lp.yValueAxis.labels.fontSize = 7
    d.add(lp)
    d.add(String(14 * mm, 56 * mm, "Индекс: серый — без ИИ (FCFS), синий — с ИИ; ось X — модельные минуты",
                 fontName=_FONT, fontSize=8, fillColor=colors.HexColor("#444444")))
    return d


def to_pdf(kpis: list[dict[str, Any]], events: list[dict[str, Any]], current: dict[str, Any] | None,
           plans: list[dict[str, Any]], clock: str, minutes: float) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm,
                            bottomMargin=15 * mm, title="Цифровая станция — отчёт")
    h1 = ParagraphStyle("h1", fontName=_FONT, fontSize=16, leading=20, spaceAfter=6)
    h2 = ParagraphStyle("h2", fontName=_FONT, fontSize=12, leading=16, spaceBefore=8, spaceAfter=4)
    body = ParagraphStyle("b", fontName=_FONT, fontSize=9, leading=12)
    st: list[Any] = [Paragraph("Цифровая станция — мини-отчёт диспетчера", h1),
                     Paragraph(f"Сформирован {time.strftime('%Y-%m-%d %H:%M')}, период: последние {minutes:.0f} мин", body)]
    if current:
        ix = current["index"]
        st.append(Paragraph(f"Текущий индекс станции: <b>{ix['value']:.0f}</b> ({ix['grade']}, {ix['category']['name']}). "
                            f"{ix['category'].get('reason', '')}", body))
    st.append(Paragraph("Сравнение: реактивный диспетчер (FCFS) и ИИ-планировщик", h2))
    rows = [["Показатель (среднее)", "Без ИИ", "С ИИ", "Δ"]] + [list(r) for r in summary(kpis)]
    t = Table(rows, colWidths=[85 * mm, 30 * mm, 30 * mm, 25 * mm])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), _FONT), ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1b2a41")), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#c8ced8")), ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f2f5f9")]),
    ]))
    st += [t, Spacer(1, 4 * mm), _chart(kpis)]
    if current:
        st.append(Paragraph("Факторы индекса (потерянные баллы)", h2))
        frows = [["Фактор", "Вес", "Оценка", "Баллы", "Потеря", "Причина"]]
        for f in current["index"]["factors"]:
            frows.append([f["name"], f"{f['weight']:.0%}", f"{f['score']:.2f}", f"{f['points']:.1f}", f"{f['loss']:.1f}",
                          Paragraph(f["why"], body)])
        ft = Table(frows, colWidths=[40 * mm, 14 * mm, 16 * mm, 14 * mm, 16 * mm, 80 * mm])
        ft.setStyle(TableStyle([("FONTNAME", (0, 0), (-1, -1), _FONT), ("FONTSIZE", (0, 0), (-1, -1), 8),
                                ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#c8ced8")),
                                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8edf3")),
                                ("VALIGN", (0, 0), (-1, -1), "TOP")]))
        st.append(ft)
    if plans:
        ms = [p["time_ms"] for p in plans if p.get("time_ms") is not None]
        inc = [p for p in plans if p.get("trigger") in ("incident", "manual")]
        st.append(Paragraph("Планировщик", h2))
        st.append(Paragraph(f"Построено планов: {len(plans)}, из них по сбоям: {len(inc)}. "
                            f"Время решения: среднее {sum(ms) / max(1, len(ms)):.0f} мс, максимум {max(ms or [0])} мс.", body))
    inc_events = [e for e in events if e.get("type") in ("incident", "action")]
    st.append(Paragraph("Нештатные ситуации и действия диспетчера", h2))
    erows = [["Время", "Тип", "Описание"]] + [
        [fmt_clock(e.get("t", 0), clock), "сбой" if e["type"] == "incident" else "действие", Paragraph(e.get("text", ""), body)]
        for e in inc_events[-40:]] or [["—", "—", "нет событий"]]
    et = Table(erows, colWidths=[18 * mm, 20 * mm, 140 * mm])
    et.setStyle(TableStyle([("FONTNAME", (0, 0), (-1, -1), _FONT), ("FONTSIZE", (0, 0), (-1, -1), 8),
                            ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#c8ced8")),
                            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8edf3"))]))
    st.append(et)
    doc.build(st)
    return buf.getvalue()

"""Загрузка YAML-конфигурации. Каталог задаётся переменной CONFIG_DIR."""
from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any

import yaml

_DEFAULT_DIR = Path(__file__).resolve().parents[2] / "config"


def config_dir() -> Path:
    return Path(os.environ.get("CONFIG_DIR", _DEFAULT_DIR))


def load_yaml(name: str) -> dict[str, Any]:
    path = config_dir() / name
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def deep_merge(base: dict[str, Any], override: dict[str, Any] | None) -> dict[str, Any]:
    """Рекурсивно накладывает override на base (оверрайды из БД поверх YAML-дефолтов)."""
    out = copy.deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def load_station() -> dict[str, Any]:
    return load_yaml("station.yaml")


def load_index_config() -> dict[str, Any]:
    return load_yaml("index.yaml")


def load_planner_config() -> dict[str, Any]:
    return load_yaml("planner.yaml")


def load_scenario(name: str | None = None) -> dict[str, Any]:
    name = name or os.environ.get("SCENARIO", "overload")
    return load_yaml(f"scenarios/{name}.yaml")

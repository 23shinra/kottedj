"""Базовая аутентификация (JWT) и ролевой доступ: dispatcher — работа с планом, admin — ещё и настройки."""
from __future__ import annotations

import hmac
import os
import time
from typing import Any

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

ROLES = {"dispatcher": 1, "admin": 2}
_bearer = HTTPBearer(auto_error=False)


def _secret() -> str:
    s = os.environ.get("JWT_SECRET")
    if not s:
        s = "dev-only-secret-change-me"
    return s


def users() -> dict[str, tuple[str, str]]:
    """Пользователи из переменных окружения (секреты не хранятся в репозитории)."""
    return {
        os.environ.get("DISPATCHER_USER", "dispatcher"): (os.environ.get("DISPATCHER_PASSWORD", "dispatcher"), "dispatcher"),
        os.environ.get("ADMIN_USER", "admin"): (os.environ.get("ADMIN_PASSWORD", "admin"), "admin"),
    }


def login(username: str, password: str) -> dict[str, Any] | None:
    u = users().get(username)
    if not u or not hmac.compare_digest(u[0], password):
        return None
    ttl = int(os.environ.get("JWT_TTL_S", 12 * 3600))
    token = jwt.encode({"sub": username, "role": u[1], "exp": int(time.time()) + ttl}, _secret(), algorithm="HS256")
    return {"token": token, "role": u[1], "username": username}


def decode(token: str) -> dict[str, Any] | None:
    try:
        return jwt.decode(token, _secret(), algorithms=["HS256"])
    except jwt.PyJWTError:
        return None


def require(role: str = "dispatcher"):
    def dep(cred: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> dict[str, Any]:
        if cred is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Требуется вход", headers={"WWW-Authenticate": "Bearer"})
        claims = decode(cred.credentials)
        if not claims:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Сессия истекла", headers={"WWW-Authenticate": "Bearer"})
        if ROLES.get(claims.get("role"), 0) < ROLES[role]:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Недостаточно прав")
        return claims
    return dep

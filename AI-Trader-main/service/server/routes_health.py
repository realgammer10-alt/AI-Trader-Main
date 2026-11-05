"""Health and readiness endpoints."""

from __future__ import annotations

import logging
import time

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from cache import get_cache_status
from database import get_database_backend_name, get_database_status
from routes_shared import utc_now_iso_z

logger = logging.getLogger(__name__)
_PROCESS_STARTED_AT = time.monotonic()


def register_health_routes(app: FastAPI) -> None:
    @app.get("/api/health")
    async def api_health():
        checks: dict[str, dict] = {}
        database_started_at = time.monotonic()
        try:
            get_database_status()
            checks["database"] = {
                "status": "healthy",
                "backend": get_database_backend_name(),
                "latency_ms": round((time.monotonic() - database_started_at) * 1000, 2),
            }
        except Exception:
            logger.exception("Database readiness check failed")
            checks["database"] = {
                "status": "unhealthy",
                "backend": get_database_backend_name(),
                "latency_ms": round((time.monotonic() - database_started_at) * 1000, 2),
            }

        cache_started_at = time.monotonic()
        try:
            cache = get_cache_status()
            cache_available = not cache["enabled"] or cache["available"]
            checks["cache"] = {
                "status": "healthy" if cache_available else "degraded",
                "enabled": cache["enabled"],
                "configured": cache["configured"],
                "available": cache["available"],
                "latency_ms": round((time.monotonic() - cache_started_at) * 1000, 2),
            }
        except Exception:
            logger.exception("Cache readiness check failed")
            checks["cache"] = {
                "status": "degraded",
                "enabled": None,
                "configured": None,
                "available": False,
                "latency_ms": round((time.monotonic() - cache_started_at) * 1000, 2),
            }

        database_healthy = checks["database"]["status"] == "healthy"
        cache_healthy = checks["cache"]["status"] == "healthy"
        status = "unhealthy" if not database_healthy else "degraded" if not cache_healthy else "healthy"
        payload = {
            "status": status,
            "timestamp": utc_now_iso_z(),
            "uptime_seconds": int(time.monotonic() - _PROCESS_STARTED_AT),
            "checks": checks,
        }
        return JSONResponse(
            status_code=503 if not database_healthy else 200,
            content=payload,
        )

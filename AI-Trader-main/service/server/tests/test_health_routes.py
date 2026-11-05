import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient


SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from routes import create_app


class HealthRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(create_app())

    def test_readiness_reports_database_and_disabled_cache(self) -> None:
        with (
            patch("routes_health.get_database_status", return_value={"backend": "sqlite"}),
            patch("routes_health.get_database_backend_name", return_value="sqlite"),
            patch(
                "routes_health.get_cache_status",
                return_value={
                    "enabled": False,
                    "configured": False,
                    "available": False,
                },
            ),
        ):
            response = self.client.get("/api/health")

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["status"], "healthy")
        self.assertEqual(payload["checks"]["database"]["status"], "healthy")
        self.assertEqual(payload["checks"]["database"]["backend"], "sqlite")
        self.assertEqual(payload["checks"]["cache"]["status"], "healthy")
        self.assertGreaterEqual(payload["uptime_seconds"], 0)
        self.assertTrue(payload["timestamp"])

    def test_readiness_is_degraded_when_optional_cache_is_unavailable(self) -> None:
        with (
            patch("routes_health.get_database_status", return_value={"backend": "sqlite"}),
            patch("routes_health.get_database_backend_name", return_value="sqlite"),
            patch(
                "routes_health.get_cache_status",
                return_value={
                    "enabled": True,
                    "configured": True,
                    "available": False,
                },
            ),
        ):
            response = self.client.get("/api/health")

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["status"], "degraded")
        self.assertEqual(payload["checks"]["cache"]["status"], "degraded")

    def test_readiness_returns_service_unavailable_when_database_fails(self) -> None:
        with (
            patch("routes_health.get_database_status", side_effect=RuntimeError("database secret")),
            patch("routes_health.get_database_backend_name", return_value="sqlite"),
            patch(
                "routes_health.get_cache_status",
                return_value={
                    "enabled": False,
                    "configured": False,
                    "available": False,
                },
            ),
        ):
            response = self.client.get("/api/health")

        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["status"], "unhealthy")
        self.assertEqual(payload["checks"]["database"]["status"], "unhealthy")
        self.assertNotIn("database secret", response.text)

    def test_liveness_endpoint_remains_available(self) -> None:
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "ok")


if __name__ == "__main__":
    unittest.main()

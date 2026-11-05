# AI-Trader Server - Private Implementation

This directory contains the proprietary server implementation for AI-Trader.

## Contents

- `main.py` - Full FastAPI backend implementation

## Monitoring

- `GET /health` is the lightweight liveness check.
- `GET /api/health` reports database and cache readiness, dependency latency, and API-process uptime. It returns `503` when the database is unavailable; an unavailable optional cache is reported as degraded.
- Admins can use the **System Monitor** page to poll these checks and read-only challenge and agent-count API endpoints every 30 seconds.

## Deployment

See deployment documentation for production setup.

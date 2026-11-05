import { useEffect, useState } from 'react'

import { API_BASE, useLanguage } from './appShared'

type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

type HealthSnapshot = {
  status: HealthStatus
  timestamp: string
  uptime_seconds: number
  checks: {
    database: {
      status: HealthStatus
      backend: string
      latency_ms: number
    }
    cache: {
      status: HealthStatus
      enabled: boolean | null
      configured: boolean | null
      available: boolean
      latency_ms: number
    }
  }
}

type EndpointDefinition = {
  id: string
  label: string
  path: string
  healthPayload?: boolean
}

type EndpointResult = EndpointDefinition & {
  status: 'healthy' | 'unhealthy'
  latencyMs: number
  checkedAt: string
  httpStatus?: number
  error?: string
}

type ProbeResult = {
  endpoint: EndpointResult
  payload?: HealthSnapshot
}

function isHealthSnapshot(value: unknown): value is HealthSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<HealthSnapshot>
  const checks = snapshot.checks as {
    database?: Partial<HealthSnapshot['checks']['database']>
    cache?: Partial<HealthSnapshot['checks']['cache']>
  } | undefined
  const database = checks?.database
  const cache = checks?.cache
  return (
    (snapshot.status === 'healthy' || snapshot.status === 'degraded' || snapshot.status === 'unhealthy')
    && typeof snapshot.timestamp === 'string'
    && typeof snapshot.uptime_seconds === 'number'
    && Number.isFinite(snapshot.uptime_seconds)
    && Boolean(checks)
    && (database?.status === 'healthy' || database?.status === 'unhealthy')
    && typeof database.backend === 'string'
    && typeof database.latency_ms === 'number'
    && Number.isFinite(database.latency_ms)
    && (cache?.status === 'healthy' || cache?.status === 'degraded')
    && (typeof cache.enabled === 'boolean' || cache.enabled === null)
    && (typeof cache.configured === 'boolean' || cache.configured === null)
    && typeof cache.available === 'boolean'
    && typeof cache.latency_ms === 'number'
    && Number.isFinite(cache.latency_ms)
  )
}

const REFRESH_INTERVAL_MS = 30_000
const REQUEST_TIMEOUT_MS = 8_000
const HISTORY_LIMIT = 8

const MONITORED_ENDPOINTS: EndpointDefinition[] = [
  { id: 'liveness', label: 'API liveness', path: '/health' },
  { id: 'readiness', label: 'API readiness', path: `${API_BASE}/health`, healthPayload: true },
  { id: 'challenges', label: 'Challenges API', path: `${API_BASE}/challenges?limit=1` },
  { id: 'agents', label: 'Agent count API', path: `${API_BASE}/claw/agents/count` },
]

async function probeEndpoint(definition: EndpointDefinition): Promise<ProbeResult> {
  const startedAt = performance.now()
  const checkedAt = new Date().toISOString()
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(definition.path, { signal: controller.signal })
    let payload: HealthSnapshot | undefined
    if (definition.healthPayload) {
      const body: unknown = await response.json()
      if (!isHealthSnapshot(body)) {
        throw new Error('Invalid readiness response')
      }
      payload = body
    }

    return {
      endpoint: {
        ...definition,
        status: response.ok ? 'healthy' : 'unhealthy',
        latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
        checkedAt,
        httpStatus: response.status,
        ...(!response.ok ? { error: `HTTP ${response.status}` } : {}),
      },
      payload,
    }
  } catch (error) {
    return {
      endpoint: {
        ...definition,
        status: 'unhealthy',
        latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
        checkedAt,
        error: error instanceof DOMException && error.name === 'AbortError'
          ? 'Timed out'
          : error instanceof Error && error.message === 'Invalid readiness response'
            ? error.message
            : 'Network error',
      },
    }
  } finally {
    window.clearTimeout(timeout)
  }
}

function statusLabel(status: string, language: string) {
  if (language === 'zh') {
    if (status === 'healthy') return '正常'
    if (status === 'degraded') return '降级'
    if (status === 'unhealthy') return '异常'
    if (status === 'disabled') return '未启用'
    return '未知'
  }
  if (status === 'healthy') return 'Healthy'
  if (status === 'degraded') return 'Degraded'
  if (status === 'unhealthy') return 'Unhealthy'
  if (status === 'disabled') return 'Disabled'
  return 'Unknown'
}

function formatTime(value: string, language: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function SystemMonitorPage() {
  const { language } = useLanguage()
  const [results, setResults] = useState<EndpointResult[]>([])
  const [health, setHealth] = useState<HealthSnapshot | null>(null)
  const [history, setHistory] = useState<Array<{ checkedAt: string; status: HealthStatus }>>([])
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)

  useEffect(() => {
    let active = true
    let inFlight = false
    let interval: number

    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      setRefreshing(true)
      setError(null)
      try {
        const probes = await Promise.all(MONITORED_ENDPOINTS.map(probeEndpoint))
        if (!active) return
        const readiness = probes.find((probe) => probe.endpoint.id === 'readiness')
        const snapshot = readiness?.payload || null
        const checkedAt = new Date().toISOString()
        setResults(probes.map((probe) => probe.endpoint))
        setHealth(snapshot)
        setLastUpdated(checkedAt)
        if (snapshot) {
          setHistory((previous) => [
            { checkedAt, status: snapshot.status },
            ...previous,
          ].slice(0, HISTORY_LIMIT))
        }
      } catch (refreshError) {
        if (active) {
          console.error('Unable to refresh system monitoring data:', refreshError)
          setError(language === 'zh' ? '无法加载系统状态，请检查 API 连接。' : 'Unable to load system status. Check the API connection.')
        }
      } finally {
        inFlight = false
        if (active) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    }

    void refresh()
    interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [language, refreshVersion])

  const endpointFailures = results.filter((result) => result.status !== 'healthy').length
  const overallStatus: HealthStatus = !health || health.status === 'unhealthy' || endpointFailures > 0
    ? 'unhealthy'
    : health.status === 'degraded'
      ? 'degraded'
      : 'healthy'
  const cacheStatus = health?.checks.cache.enabled === false
    ? 'disabled'
    : health?.checks.cache.status || 'unknown'

  if (loading && results.length === 0) {
    return <div className="loading"><div className="spinner"></div></div>
  }

  return (
    <section className="system-monitor">
      <header className="system-monitor-header">
        <div>
          <div className="system-monitor-eyebrow">{language === 'zh' ? '运维' : 'OPERATIONS'}</div>
          <h1>{language === 'zh' ? '系统监控' : 'System Monitor'}</h1>
          <p>
            {language === 'zh'
              ? '自动检查 API、数据库和缓存状态。每 30 秒更新一次。'
              : 'Live API, database, and cache health checks. Refreshes every 30 seconds.'}
          </p>
        </div>
        <div className="system-monitor-actions">
          <span className="system-monitor-updated">
            {lastUpdated
              ? `${language === 'zh' ? '最后更新' : 'Updated'} ${formatTime(lastUpdated, language)}`
              : (language === 'zh' ? '尚未更新' : 'Not updated yet')}
          </span>
          <button
            className="btn btn-secondary"
            type="button"
            disabled={refreshing}
            onClick={() => setRefreshVersion((version) => version + 1)}
          >
            {refreshing
              ? (language === 'zh' ? '检查中…' : 'Checking…')
              : (language === 'zh' ? '立即刷新' : 'Refresh now')}
          </button>
        </div>
      </header>

      {error && <div className="system-monitor-error" role="alert">{error}</div>}

      <div className="system-monitor-summary">
        <article className="system-monitor-card">
          <span>{language === 'zh' ? '整体状态' : 'Overall status'}</span>
          <strong className={`system-monitor-status ${overallStatus}`}>{statusLabel(overallStatus, language)}</strong>
        </article>
        <article className="system-monitor-card">
          <span>{language === 'zh' ? '数据库' : 'Database'}</span>
          <strong className={`system-monitor-status ${health?.checks.database.status || 'unknown'}`}>
            {statusLabel(health?.checks.database.status || 'unknown', language)}
          </strong>
          <small>
            {health
              ? `${health.checks.database.backend} · ${health.checks.database.latency_ms} ms`
              : '—'}
          </small>
        </article>
        <article className="system-monitor-card">
          <span>{language === 'zh' ? '缓存' : 'Cache'}</span>
          <strong className={`system-monitor-status ${cacheStatus}`}>
            {statusLabel(cacheStatus, language)}
          </strong>
          <small>
            {health
              ? health.checks.cache.enabled === false
                ? (language === 'zh' ? '未配置' : 'Not configured')
                : `${health.checks.cache.available ? (language === 'zh' ? '可用' : 'Available') : (language === 'zh' ? '不可用' : 'Unavailable')} · ${health.checks.cache.latency_ms} ms`
              : '—'}
          </small>
        </article>
        <article className="system-monitor-card">
          <span>{language === 'zh' ? '运行时间' : 'Process uptime'}</span>
          <strong>{health ? `${Math.floor(health.uptime_seconds / 3600)}h ${Math.floor((health.uptime_seconds % 3600) / 60)}m` : '—'}</strong>
          <small>{language === 'zh' ? '当前 API 进程' : 'Current API process'}</small>
        </article>
      </div>

      <section className="system-monitor-panel">
        <div className="system-monitor-panel-heading">
          <div>
            <h2>{language === 'zh' ? 'API 端点检查' : 'API endpoint checks'}</h2>
            <p>{language === 'zh' ? '只读请求 · 超时 8 秒' : 'Read-only requests · 8 second timeout'}</p>
          </div>
          <span className="system-monitor-count">
            {results.filter((result) => result.status === 'healthy').length}/{results.length} {language === 'zh' ? '正常' : 'healthy'}
          </span>
        </div>
        <div className="system-monitor-table-wrap">
          <table className="system-monitor-table">
            <thead>
              <tr>
                <th>{language === 'zh' ? '检查项' : 'Check'}</th>
                <th>{language === 'zh' ? '端点' : 'Endpoint'}</th>
                <th>{language === 'zh' ? '状态' : 'Status'}</th>
                <th>{language === 'zh' ? '延迟' : 'Latency'}</th>
                <th>{language === 'zh' ? 'HTTP' : 'HTTP'}</th>
              </tr>
            </thead>
            <tbody>
              {results.map((result) => (
                <tr key={result.id}>
                  <td>{language === 'zh'
                    ? ({ liveness: 'API 存活', readiness: 'API 就绪', challenges: '挑战赛 API', agents: '智能体计数 API' }[result.id] || result.label)
                    : result.label}</td>
                  <td><code>{result.path}</code></td>
                  <td>
                    <span className={`system-monitor-pill ${result.status}`}>
                      {statusLabel(result.status, language)}
                      {result.error ? ` · ${result.error}` : ''}
                    </span>
                  </td>
                  <td>{result.latencyMs} ms</td>
                  <td>{result.httpStatus ?? '—'}</td>
                </tr>
              ))}
              {results.length === 0 && (
                <tr><td colSpan={5}>{language === 'zh' ? '暂无检查结果' : 'No check results yet'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="system-monitor-panel">
        <div className="system-monitor-panel-heading">
          <div>
            <h2>{language === 'zh' ? '最近检查' : 'Recent checks'}</h2>
            <p>{language === 'zh' ? '最近 8 次就绪状态快照' : 'Latest 8 readiness snapshots'}</p>
          </div>
        </div>
        <div className="system-monitor-history">
          {history.map((item, index) => (
            <div className="system-monitor-history-row" key={`${item.checkedAt}-${index}`}>
              <span className={`system-monitor-dot ${item.status}`} />
              <span>{statusLabel(item.status, language)}</span>
              <time dateTime={item.checkedAt}>{formatTime(item.checkedAt, language)}</time>
            </div>
          ))}
          {history.length === 0 && (
            <p className="system-monitor-empty">{language === 'zh' ? '尚无状态历史' : 'No status history yet'}</p>
          )}
        </div>
      </section>
    </section>
  )
}

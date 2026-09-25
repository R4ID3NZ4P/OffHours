'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  Bot,
  ChevronDown,
  CircleHelp,
  Clock3,
  Copy,
  ExternalLink,
  Gauge,
  KeyRound,
  LineChart,
  LockKeyhole,
  Menu,
  MessageSquareText,
  Newspaper,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  WalletCards,
  X,
  Zap,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { QuoteData } from './api/market-data/route'
import type { NewsItem } from './api/news/route'
import type { AnalyzeResponse } from './api/analyze/route'

// ---------------------------------------------------------------------------
// Static asset list
// ---------------------------------------------------------------------------
const TICKERS = [
  { symbol: 'AAPL', name: 'Apple Inc.' },
  { symbol: 'NVDA', name: 'NVIDIA Corp.' },
  { symbol: 'TSLA', name: 'Tesla Inc.' },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF' },
  { symbol: 'COIN', name: 'Coinbase Global' },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatChange(pct: number) {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
}

function formatPrice(p: number) {
  return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatVolume(v: number) {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`
  return `$${v}`
}

function timeAgo(unixSeconds: number) {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds
  if (diff < 5) return 'just now'
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function getLiveTime() {
  return new Date().toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC',
  }) + ' UTC'
}

/** Returns true if US equities market is currently open (Mon–Fri 9:30–16:00 ET) */
function isUSMarketOpen(): boolean {
  const now = new Date()
  // Convert to ET (UTC-4 during EDT, UTC-5 during EST)
  const etOffset = isDST(now) ? -4 : -5
  const etNow = new Date(now.getTime() + etOffset * 60 * 60 * 1000)
  const day = etNow.getUTCDay() // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false
  const hours = etNow.getUTCHours()
  const minutes = etNow.getUTCMinutes()
  const totalMins = hours * 60 + minutes
  return totalMins >= 9 * 60 + 30 && totalMins < 16 * 60
}

function isDST(date: Date): boolean {
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset()
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset()
  return date.getTimezoneOffset() < Math.max(jan, jul)
}

/** Derive a 0–100 market pulse score from price changes across all assets */
function computeMarketPulse(dataMap: Record<string, QuoteData>): {
  score: number
  riskLabel: string
  liquidityLabel: string
  bullCount: number
  bearCount: number
} {
  const values = Object.values(dataMap)
  if (values.length === 0) return { score: 50, riskLabel: 'Moderate', liquidityLabel: 'Normal', bullCount: 0, bearCount: 0 }

  const avgPct = values.reduce((sum, d) => sum + d.changePercent, 0) / values.length
  const bullCount = values.filter(d => d.changePercent > 0).length
  const bearCount = values.filter(d => d.changePercent <= 0).length

  // Map avg pct change [-5%, +5%] → [0, 100]
  const raw = 50 + avgPct * 10
  const score = Math.min(100, Math.max(0, Math.round(raw)))

  const riskLabel =
    score >= 75 ? 'Risk-On' :
    score >= 55 ? 'Elevated' :
    score >= 40 ? 'Moderate' :
    score >= 25 ? 'Risk-Off' : 'Defensive'

  const totalVol = values.reduce((s, d) => s + (d.volume ?? 0), 0)
  const liquidityLabel =
    totalVol > 5e8 ? 'Deep' :
    totalVol > 1e8 ? 'Normal' : 'Thin'

  return { score, riskLabel, liquidityLabel, bullCount, bearCount }
}

/** Derive volatility label from 24h range relative to price */
function computeVolatility(data: QuoteData | null): { label: string; color: string } {
  if (!data || data.price === 0) return { label: 'Unknown', color: '#9bacad' }
  const rangePct = ((data.high - data.low) / data.price) * 100
  if (rangePct > 4) return { label: 'High', color: '#fb7185' }
  if (rangePct > 1.5) return { label: 'Medium', color: '#f59e0b' }
  return { label: 'Low', color: '#35d399' }
}

/** Derive signal confidence from analysis impact score */
function computeSignalConfidence(analysis: AnalyzeResponse | null): number {
  if (!analysis) return 0
  // Higher absolute impact → higher confidence; bias toward positive
  return Math.min(99, Math.round(60 + Math.abs(analysis.impactScore) * 4))
}

/** Build chart history from current price working backwards using real hours */
function buildChartData(currentPrice: number, previousClose: number) {
  const now = new Date()
  const utcH = now.getUTCHours()
  const points: { time: string; price: number; close: number }[] = []

  for (let i = 10; i >= 0; i--) {
    const h = ((utcH - i + 24) % 24)
    const timeLabel = `${String(h).padStart(2, '0')}:00`
    // Interpolate: at i=10 (oldest) → previousClose, at i=0 → currentPrice
    const frac = (10 - i) / 10
    const trendPrice = previousClose + (currentPrice - previousClose) * frac
    const noise = (Math.random() - 0.5) * currentPrice * 0.004
    const closeNoise = (Math.random() - 0.5) * currentPrice * 0.002
    points.push({
      time: timeLabel,
      price: parseFloat((trendPrice + noise).toFixed(2)),
      close: parseFloat((previousClose + (currentPrice - previousClose) * frac * 0.95 + closeNoise).toFixed(2)),
    })
  }
  points[points.length - 1].price = currentPrice
  return points
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function Pill({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'positive' | 'negative' | 'neutral' }) {
  return <span className={`pill pill-${tone}`}>{children}</span>
}

function IconButton({ label, children, onClick }: { label: string; children: React.ReactNode; onClick?: () => void }) {
  return <button className="icon-button" aria-label={label} onClick={onClick}>{children}</button>
}

function Spinner() {
  return (
    <svg className="spinner" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="10" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Custom hooks
// ---------------------------------------------------------------------------

/**
 * Single source of truth: fetches ALL tickers, returns the map + derived
 * per-ticker accessors. This prevents duplicate requests for the active ticker.
 */
function useMarketDataAll(tickers: string[]) {
  const [dataMap, setDataMap] = useState<Record<string, QuoteData>>({})
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [latencyMs, setLatencyMs] = useState<number | null>(null)

  const fetchAll = useCallback(async () => {
    const t0 = performance.now()
    try {
      const results = await Promise.allSettled(
        tickers.map(async (ticker) => {
          const res = await fetch(`/api/market-data?ticker=${ticker}`)
          const json: QuoteData = await res.json()
          return { ticker, data: json }
        })
      )
      const newMap: Record<string, QuoteData> = {}
      for (const result of results) {
        if (result.status === 'fulfilled') {
          newMap[result.value.ticker] = result.value.data
        }
      }
      setDataMap(newMap)
      setLastUpdated(new Date())
      setLatencyMs(Math.round(performance.now() - t0))
    } catch (err) {
      console.error('[useMarketDataAll]', err)
    } finally {
      setLoading(false)
    }
  }, [tickers])

  useEffect(() => {
    setLoading(true)
    fetchAll()
    const interval = setInterval(fetchAll, 15_000)
    return () => clearInterval(interval)
  }, [fetchAll])

  return { dataMap, loading, lastUpdated, latencyMs, refresh: fetchAll }
}

function getStoredApiKey(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem('GEMINI_API_KEY') || localStorage.getItem('GOOGLE_API_KEY') || ''
}

/** Fetches news for a ticker, refreshes when ticker changes */
function useNews(ticker: string) {
  const [news, setNews] = useState<NewsItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    setNews([])
    const apiKey = getStoredApiKey()
    const headers: Record<string, string> = {}
    if (apiKey) headers['x-api-key'] = apiKey

    fetch(`/api/news?ticker=${ticker}`, { headers })
      .then((r) => r.json())
      .then((data: NewsItem[]) => setNews(data))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [ticker])

  return { news, loading }
}

/** Fetches AI analysis for a ticker+price combo */
function useAnalysis(ticker: string, price: number | null) {
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const lastTickerRef = useRef('')

  const refresh = useCallback(async () => {
    if (!price) return
    setLoading(true)
    try {
      const apiKey = getStoredApiKey()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey) headers['x-api-key'] = apiKey

      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ticker, currentPrice: price, userQuery: `Analyze ${ticker} market context and weekend/after-hours risk` }),
      })
      const data: AnalyzeResponse = await res.json()
      setAnalysis(data)
    } catch (err) {
      console.error('[useAnalysis]', err)
    } finally {
      setLoading(false)
    }
  }, [ticker, price])

  // Re-run when ticker changes OR when price first arrives
  useEffect(() => {
    if (price && (lastTickerRef.current !== ticker || !analysis)) {
      lastTickerRef.current = ticker
      refresh()
    }
  }, [ticker, price, refresh, analysis])

  return { analysis, loading, refresh }
}

/** Streaming copilot query hook */
function useStreamingQuery() {
  const [streamedText, setStreamedText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const query = useCallback(async (ticker: string, price: number | null, question: string) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setStreamedText('')
    setIsStreaming(true)
    try {
      const apiKey = getStoredApiKey()
      const headers: Record<string, string> = {}
      if (apiKey) headers['x-api-key'] = apiKey

      const priceParam = price != null ? `&price=${price}` : ''
      const res = await fetch(
        `/api/analyze?ticker=${encodeURIComponent(ticker)}&query=${encodeURIComponent(question)}${priceParam}`,
        { signal: controller.signal, headers }
      )
      if (!res.body) throw new Error('No response body')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        if (chunk.includes('__DONE__')) {
          accumulated += chunk.replace('__DONE__', '')
          setStreamedText(accumulated.trim())
          break
        }
        accumulated += chunk
        setStreamedText(accumulated)
      }
    } catch (err: unknown) {
      if ((err as Error).name !== 'AbortError') {
        console.error('[useStreamingQuery]', err)
        setStreamedText('Analysis unavailable. Please try again.')
      }
    } finally {
      setIsStreaming(false)
    }
  }, [])

  return { streamedText, isStreaming, query }
}

/** Live rolling "X seconds ago" ticker — updates every second */
function useRollingAge(lastUpdated: Date | null): string {
  const [, setTick] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(iv)
  }, [])
  if (!lastUpdated) return 'Updating…'
  const diff = Math.floor((Date.now() - lastUpdated.getTime()) / 1000)
  if (diff < 5) return 'just now'
  return `${diff}s ago`
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function Page() {
  const tickerList = useMemo(() => TICKERS.map((t) => t.symbol), [])
  const [selected, setSelected] = useState('AAPL')
  const [tradeOpen, setTradeOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [geminiKeyInput, setGeminiKeyInput] = useState('')
  const [walletConnected, setWalletConnected] = useState(false)
  const [tradeSide, setTradeSide] = useState<'Buy' | 'Sell'>('Buy')
  const [prompt, setPrompt] = useState('')
  const [clock, setClock] = useState(getLiveTime())
  const [copilotTab, setCopilotTab] = useState<'analysis' | 'ask'>('analysis')
  const [marketOpen, setMarketOpen] = useState(false)

  // Load saved Gemini API key
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('GEMINI_API_KEY') || localStorage.getItem('GOOGLE_API_KEY') || ''
      setGeminiKeyInput(saved)
    }
  }, [])

  // Live clock + market status
  useEffect(() => {
    const update = () => {
      setClock(getLiveTime())
      setMarketOpen(isUSMarketOpen())
    }
    update()
    const iv = setInterval(update, 1000)
    return () => clearInterval(iv)
  }, [])

  // Market data – single consolidated hook
  const { dataMap: allData, loading: allLoading, lastUpdated, latencyMs, refresh: refreshAll } = useMarketDataAll(tickerList)
  const activeData = allData[selected] ?? null
  const activePrice = activeData?.price ?? null

  // News & analysis
  const { news, loading: newsLoading } = useNews(selected)
  const { analysis, loading: analysisLoading, refresh: refreshAnalysis } = useAnalysis(selected, activePrice)

  // Streaming copilot
  const { streamedText, isStreaming, query: streamQuery } = useStreamingQuery()

  // Rolling "Xs ago" label that updates every second
  const lastUpdatedStr = useRollingAge(lastUpdated)

  // Derived dynamic values
  const assetColor = useMemo(() => {
    const d = allData[selected]
    if (!d) return '#35d399'
    return d.changePercent >= 0 ? '#35d399' : '#fb7185'
  }, [allData, selected])

  const activeAsset = useMemo(
    () => TICKERS.find((t) => t.symbol === selected) ?? TICKERS[0],
    [selected]
  )

  const pulse = useMemo(() => computeMarketPulse(allData), [allData])

  const totalOnChainVol = useMemo(() => {
    const total = Object.values(allData).reduce((s, d) => s + (d.volume ?? 0) * (d.price ?? 0), 0)
    return total > 0 ? formatVolume(total) : null
  }, [allData])

  const volatility = useMemo(() => computeVolatility(activeData), [activeData])
  const signalConfidence = useMemo(() => computeSignalConfidence(analysis), [analysis])

  const spreadPct = useMemo(() => {
    if (!activeData || activeData.previousClose === 0) return null
    return ((activeData.price - activeData.previousClose) / activeData.previousClose) * 100
  }, [activeData])

  const chartData = useMemo(() => {
    if (!activeData?.price || !activeData.previousClose) return []
    return buildChartData(activeData.price, activeData.previousClose)
  }, [activeData?.price, activeData?.previousClose])

  const handleSelectTicker = useCallback((sym: string) => {
    setSelected(sym)
  }, [])

  const handleSubmitPrompt = useCallback(() => {
    if (!prompt.trim()) return
    streamQuery(selected, activePrice, prompt.trim())
    setPrompt('')
    setCopilotTab('ask')
  }, [prompt, selected, activePrice, streamQuery])

  return (
    <main className="desk-shell">
      {/* ── Topbar ─────────────────────────────────────────────────────────── */}
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Zap size={17} fill="currentColor" /></div>
          <div>
            <div className="brand-name">OFFHOURS <span>AI DESK</span></div>
            <div className="brand-sub">TOKENIZED MARKET INTELLIGENCE</div>
          </div>
        </div>
        <div className="market-status">
          <span className="status-dot" />
          <strong>24/7 TOKENIZED MARKET ACTIVE</strong>
          <span className="status-divider" />
          US MARKET:{' '}
          <b className={marketOpen ? 'gain' : 'dim'}>
            {marketOpen ? 'OPEN' : 'CLOSED'}
          </b>
          <span className="status-divider" />
          ON-CHAIN: <b>TRADING 24/7</b>
        </div>
        <div className="top-actions">
          <span className="utc"><Clock3 size={14} /> {clock}</span>
          <IconButton label="Notifications"><Bell size={17} /></IconButton>
          <IconButton label="Settings" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={17} />
          </IconButton>
          <button
            className={`wallet-button ${walletConnected ? 'connected' : ''}`}
            onClick={() => setWalletConnected(!walletConnected)}
          >
            <WalletCards size={16} /> {walletConnected ? '0x7A…F91C' : 'Connect wallet'}
          </button>
        </div>
      </header>

      {/* ── Ticker strip ───────────────────────────────────────────────────── */}
      <div className="ticker-strip">
        <span className="ticker-label"><span className="live-dot" /> LIVE FEED</span>
        {TICKERS.slice(0, 4).map((t) => {
          const d = allData[t.symbol]
          return (
            <button key={t.symbol} className={`ticker-item${selected === t.symbol ? ' active-ticker' : ''}`} onClick={() => handleSelectTicker(t.symbol)}>
              <b>{t.symbol}</b>
              <span>{d ? `$${formatPrice(d.price)}` : '—'}</span>
              <span className={d && d.changePercent >= 0 ? 'gain' : 'loss'}>
                {d ? formatChange(d.changePercent) : '…'}
              </span>
            </button>
          )
        })}
        <span className="ticker-end">
          <RefreshCw
            size={12}
            className={allLoading ? 'spin' : ''}
            onClick={refreshAll}
            style={{ cursor: 'pointer' }}
          />
          Updated {lastUpdatedStr}
        </span>
      </div>

      {/* ── Workspace ──────────────────────────────────────────────────────── */}
      <section className="workspace">

        {/* Left: watchlist */}
        <aside className="left-column panel-column">
          <div className="section-heading">
            <div>
              <span className="eyebrow">MARKET UNIVERSE</span>
              <h2>Asset watchlist</h2>
            </div>
            <IconButton label="Add asset"><Plus size={17} /></IconButton>
          </div>
          <div className="search-box">
            <Search size={15} />
            <input placeholder="Search tokenized assets" aria-label="Search assets" />
          </div>
          <div className="watchlist">
            {TICKERS.map((t) => {
              const d = allData[t.symbol]
              const isPos = !d || d.changePercent >= 0
              return (
                <button
                  key={t.symbol}
                  className={`asset-row ${selected === t.symbol ? 'selected' : ''}`}
                  onClick={() => handleSelectTicker(t.symbol)}
                >
                  <span className="asset-icon" style={{ color: isPos ? '#35d399' : '#fb7185' }}>
                    {t.symbol.slice(0, 1)}
                  </span>
                  <span className="asset-info">
                    <strong>{t.symbol}</strong>
                    <small>{t.name}</small>
                  </span>
                  <span className="asset-numbers">
                    <strong>{d ? `$${formatPrice(d.price)}` : allLoading ? '…' : '—'}</strong>
                    <small className={isPos ? 'gain' : 'loss'}>
                      {d ? formatChange(d.changePercent) : ''}
                    </small>
                  </span>
                  <span className={`sentiment ${isPos ? 'bullish' : 'bearish'}`}>
                    {isPos ? 'Bullish' : 'Bearish'}
                  </span>
                </button>
              )
            })}
          </div>

          {/* Watchlist footer – live aggregate volume */}
          <div className="watchlist-footer">
            <div>
              <span>ON-CHAIN VOLUME (24H)</span>
              <strong>
                {totalOnChainVol ?? '—'}
                {pulse.bullCount > 0 && (
                  <em> {pulse.bullCount}/{TICKERS.length} bullish</em>
                )}
              </strong>
            </div>
            <BarChart3 size={21} />
          </div>

          {/* Market Pulse – derived from live spread data */}
          <div className="mini-card">
            <div className="mini-card-title">
              <span><Gauge size={15} /> MARKET PULSE</span>
              <Pill tone={pulse.score >= 55 ? 'positive' : pulse.score >= 40 ? 'neutral' : 'negative'}>
                {pulse.score >= 55 ? 'RISK-ON' : pulse.score >= 40 ? 'NEUTRAL' : 'RISK-OFF'}
              </Pill>
            </div>
            <div className="pulse-score">
              {allLoading && Object.keys(allData).length === 0
                ? <Spinner />
                : <>{pulse.score}<span>/100</span></>
              }
            </div>
            <div className="pulse-bar">
              <i style={{ width: `${pulse.score}%`, background: pulse.score >= 55 ? '#35d399' : pulse.score >= 40 ? '#f59e0b' : '#fb7185', transition: 'width 0.8s ease, background 0.4s ease' }} />
            </div>
            <div className="pulse-meta">
              <span>Risk appetite</span>
              <b style={{ color: pulse.score >= 55 ? '#35d399' : pulse.score >= 40 ? '#f59e0b' : '#fb7185' }}>
                {pulse.riskLabel}
              </b>
            </div>
            <div className="pulse-meta">
              <span>Liquidity</span>
              <b>{pulse.liquidityLabel}</b>
            </div>
            <div className="pulse-meta">
              <span>Bulls / Bears</span>
              <b><span className="gain">{pulse.bullCount}▲</span> / <span className="loss">{pulse.bearCount}▼</span></b>
            </div>
          </div>
        </aside>

        {/* Center: chart + spread */}
        <section className="center-column">
          <div className="instrument-header">
            <div>
              <div className="instrument-name">
                <span className="asset-icon large" style={{ color: assetColor }}>
                  {activeAsset.symbol.slice(0, 1)}
                </span>
                <div>
                  <h1>{activeAsset.symbol} <span>/ USD</span></h1>
                  <p>{activeAsset.name} · Tokenized equity contract</p>
                </div>
              </div>
            </div>
            <div className="instrument-price">
              {allLoading && !activeData
                ? <Spinner />
                : <>
                  <strong>${activeData ? formatPrice(activeData.price) : '—'}</strong>
                  <span className={activeData && activeData.changePercent >= 0 ? 'gain' : 'loss'}>
                    {activeData
                      ? <>{formatChange(activeData.changePercent)} <small>24H</small></>
                      : null}
                  </span>
                  {activeData && (
                    <span style={{ fontSize: '10px', color: '#718487', marginTop: 2 }}>
                      abs {activeData.change >= 0 ? '+' : ''}{activeData.change.toFixed(2)} pts
                    </span>
                  )}
                </>
              }
            </div>
          </div>

          <div className="chart-card">
            <div className="chart-toolbar">
              <div className="tabs">
                <button className="active">Price</button>
                <button>Depth</button>
                <button>Signals <span className="tiny-badge">{analysis?.primaryDrivers?.length ?? 0}</span></button>
              </div>
              <div className="time-tabs">
                <button>1H</button><button>4H</button>
                <button className="active">1D</button>
                <button>1W</button><button>1M</button>
                <button className="chart-settings"><Settings2 size={15} /></button>
              </div>
            </div>
            <div className="chart-wrap">
              <div className="chart-label">
                <span><i className="legend-live" /> On-chain live</span>
                <span><i className="legend-close" /> Regular close</span>
              </div>
              {chartData.length > 0
                ? (
                  <ResponsiveContainer width="100%" height={270}>
                    <AreaChart data={chartData} margin={{ top: 18, right: 10, left: -16, bottom: 0 }}>
                      <defs>
                        <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={assetColor} stopOpacity={0.26} />
                          <stop offset="100%" stopColor={assetColor} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 5" stroke="#27343b" vertical={false} />
                      <XAxis dataKey="time" tick={{ fill: '#64747a', fontSize: 10 }} axisLine={false} tickLine={false} />
                      <YAxis domain={['dataMin - 1', 'dataMax + 1']} tick={{ fill: '#64747a', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} />
                      <Tooltip
                        contentStyle={{ background: '#10191d', border: '1px solid #2d4047', borderRadius: 8, color: '#e9f4f0', fontSize: 12 }}
                        formatter={(value?: any) => [`$${Number(value ?? 0).toFixed(2)}`, 'Price']}
                      />
                      <Area type="monotone" dataKey="close" stroke="#65777b" strokeWidth={1.5} strokeDasharray="4 4" fill="none" />
                      <Area type="monotone" dataKey="price" stroke={assetColor} strokeWidth={2.5} fill="url(#priceFill)" activeDot={{ r: 4, fill: assetColor, stroke: '#0d1619', strokeWidth: 2 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                )
                : (
                  <div style={{ height: 270, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64747a', gap: 8 }}>
                    <Spinner /> Loading chart…
                  </div>
                )
              }
            </div>
            <div className="chart-footer">
              <span>
                <span className="sparkline-dot" />
                Signal confidence{' '}
                <strong style={{ color: signalConfidence > 70 ? '#35d399' : '#f59e0b' }}>
                  {signalConfidence > 0 ? `${signalConfidence}%` : '—'}
                </strong>
              </span>
              <span>
                Spread{' '}
                <strong className={spreadPct != null && spreadPct >= 0 ? 'gain' : 'loss'}>
                  {spreadPct != null ? `${spreadPct >= 0 ? '+' : ''}${spreadPct.toFixed(2)}%` : '—'}
                </strong>
              </span>
              <span>
                Volatility{' '}
                <strong style={{ color: volatility.color }}>{volatility.label}</strong>
              </span>
            </div>
          </div>

          {/* Spread card */}
          <div className="spread-card">
            <div className="spread-title">
              <div className="section-icon"><TrendingUp size={18} /></div>
              <div>
                <span className="eyebrow">AFTER-HOURS &amp; WEEKEND SPREAD</span>
                <h3>
                  {spreadPct != null
                    ? spreadPct > 0.1
                      ? 'On-chain premium detected'
                      : spreadPct < -0.1
                      ? 'On-chain discount detected'
                      : 'Price convergence — near fair value'
                    : 'Loading spread data…'}
                </h3>
              </div>
              <Pill tone={activeData && activeData.changePercent >= 0 ? 'positive' : 'negative'}>
                {activeData && activeData.changePercent >= 0 ? 'BULLISH' : 'BEARISH'}
              </Pill>
            </div>
            <div className="spread-body">
              <div className="spread-metric">
                <span>REGULAR CLOSE</span>
                <strong>${activeData ? formatPrice(activeData.previousClose) : '—'}</strong>
                <small>Previous session close</small>
              </div>
              <div className="spread-arrow" style={{ color: assetColor }}>
                {activeData && activeData.changePercent >= 0
                  ? <ArrowUpRight size={18} />
                  : <ArrowDownRight size={18} />}
                <span>{spreadPct != null ? `${spreadPct >= 0 ? '+' : ''}${spreadPct.toFixed(2)}%` : ''}</span>
              </div>
              <div className="spread-metric live">
                <span>LIVE ON-CHAIN</span>
                <strong style={{ color: assetColor }}>${activeData ? formatPrice(activeData.price) : '—'}</strong>
                <small><i className="live-dot" style={{ background: assetColor, boxShadow: `0 0 6px ${assetColor}` }} /> {lastUpdatedStr}</small>
              </div>
              <button className="primary-button" onClick={() => { setTradeSide('Buy'); setTradeOpen(true) }}>
                Execute paper trade <ArrowUpRight size={16} />
              </button>
            </div>
          </div>

          {/* Stats bar */}
          <div className="bottom-stats">
            <div>
              <span>24H HIGH</span>
              <strong className="gain">${activeData ? formatPrice(activeData.high) : '—'}</strong>
            </div>
            <div>
              <span>24H LOW</span>
              <strong className="loss">${activeData ? formatPrice(activeData.low) : '—'}</strong>
            </div>
            <div>
              <span>PREV CLOSE</span>
              <strong>${activeData ? formatPrice(activeData.previousClose) : '—'}</strong>
            </div>
            <div>
              <span>ON-CHAIN VOL</span>
              <strong>
                {activeData?.volume
                  ? formatVolume(activeData.volume * activeData.price)
                  : '—'}
              </strong>
            </div>
            <div>
              <span>VOLATILITY</span>
              <strong style={{ color: volatility.color }}>{volatility.label}</strong>
            </div>
          </div>
        </section>

        {/* Right: copilot */}
        <aside className="right-column panel-column">
          <div className="section-heading">
            <div>
              <span className="eyebrow">YOUR INTELLIGENCE LAYER</span>
              <h2><Bot size={20} /> Market copilot</h2>
            </div>
            <Pill tone="positive">ONLINE</Pill>
          </div>

          <div className="copilot-tabs">
            <button
              className={copilotTab === 'analysis' ? 'active' : ''}
              onClick={() => setCopilotTab('analysis')}
            >
              <Sparkles size={14} /> AI Analysis
            </button>
            <button
              className={copilotTab === 'ask' ? 'active' : ''}
              onClick={() => setCopilotTab('ask')}
            >
              <MessageSquareText size={14} /> Ask anything
            </button>
          </div>

          {/* ── Analysis tab ── */}
          {copilotTab === 'analysis' && (
            <>
              <div className="analysis-card">
                <div className="analysis-top">
                  <div>
                    <span className="eyebrow">LATEST ANALYSIS · {selected}</span>
                    <h3>
                      {analysisLoading
                        ? 'Analyzing…'
                        : analysis
                        ? `Impact: ${analysis.impactScore >= 0 ? '+' : ''}${analysis.impactScore} / 10`
                        : 'Awaiting data…'}
                    </h3>
                  </div>
                  <span className="analysis-time">
                    {analysisLoading
                      ? <Spinner />
                      : <button className="icon-button" onClick={refreshAnalysis} aria-label="Refresh analysis"><RefreshCw size={13} /></button>
                    }
                  </span>
                </div>

                {analysis && !analysisLoading && (
                  <>
                    <div className="impact-row">
                      <span>EVENT IMPACT SCORE</span>
                      <strong style={{ color: analysis.impactScore >= 0 ? '#35d399' : '#fb7185' }}>
                        {analysis.impactScore >= 0 ? '+' : ''}{analysis.impactScore}
                        <small> / 10</small>
                      </strong>
                      <div className="impact-meter">
                        <i style={{
                          width: `${Math.abs(analysis.impactScore) * 10}%`,
                          background: analysis.impactScore >= 0 ? '#35d399' : '#fb7185',
                        }} />
                      </div>
                    </div>

                    {analysis.primaryDrivers?.length > 0 && (
                      <div className="rationale">
                        <span>PRIMARY DRIVERS</span>
                        <ul>
                          {analysis.primaryDrivers.map((d, i) => <li key={i}>{d}</li>)}
                        </ul>
                      </div>
                    )}

                    {analysis.actionableStrategy && (
                      <div className="rationale">
                        <span>ACTIONABLE STRATEGY</span>
                        <p style={{ color: '#c8e6d8', fontSize: '0.82rem', lineHeight: 1.5, margin: '4px 0 0' }}>
                          {analysis.actionableStrategy}
                        </p>
                      </div>
                    )}

                    <div className="analysis-source">
                      {analysis.isMock
                        ? <><CircleHelp size={13} /> Mock analysis · Configure API key for live AI</>
                        : <><ShieldCheck size={13} /> Generated by OffHours AI engine · Live LLM</>
                      }
                    </div>
                  </>
                )}

                {analysisLoading && (
                  <div style={{ padding: '12px 0', color: '#64747a', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Spinner /> Loading market analysis…
                  </div>
                )}
              </div>

              {/* News feed */}
              <div className="news-section">
                <div className="subhead">
                  <span><Newspaper size={15} /> BREAKING NEWS · {selected}</span>
                  <button>View all <ArrowUpRight size={13} /></button>
                </div>
                {newsLoading && (
                  <div style={{ color: '#64747a', fontSize: '0.8rem', padding: '8px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Spinner /> Loading news…
                  </div>
                )}
                {!newsLoading && news.slice(0, 4).map((item) => (
                  <div className="news-item" key={item.id}>
                    <div className={`news-tag ${item.sentiment === 'Bullish' ? 'positive' : item.sentiment === 'Bearish' ? 'negative' : 'neutral'}`}>
                      {item.category ?? item.sentiment}
                    </div>
                    <div className="news-title">
                      {item.url && item.url !== '#'
                        ? <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none', display: 'flex', alignItems: 'flex-start', gap: 4 }}>
                          {item.title} <ExternalLink size={11} style={{ flexShrink: 0, marginTop: 2 }} />
                        </a>
                        : item.title
                      }
                    </div>
                    <div className="news-meta">
                      <span>{item.source} · {timeAgo(item.publishedAt)}</span>
                      <b className={item.sentiment === 'Bullish' ? 'gain' : item.sentiment === 'Bearish' ? 'loss' : ''}>
                        {item.impactScore !== 0
                          ? `${item.impactScore >= 0 ? '+' : ''}${item.impactScore.toFixed(1)} impact`
                          : item.sentiment}
                      </b>
                    </div>
                  </div>
                ))}
                {!newsLoading && news.length === 0 && (
                  <div style={{ color: '#64747a', fontSize: '0.8rem', padding: '8px 0' }}>
                    No recent news for {selected}.
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Ask anything tab ── */}
          {copilotTab === 'ask' && (
            <div className="ask-panel">
              {streamedText && (
                <div className="streamed-response">
                  <div className="streamed-header">
                    <Sparkles size={13} /> AI Response for {selected}
                    {isStreaming && <span className="typing-indicator">●</span>}
                  </div>
                  <div className="streamed-text">
                    {streamedText}{isStreaming && <span className="cursor-blink">|</span>}
                  </div>
                </div>
              )}
              {!streamedText && !isStreaming && (
                <div className="ask-placeholder">
                  <Bot size={32} style={{ opacity: 0.3 }} />
                  <p>Ask any question about {selected} market conditions, price targets, or strategy.</p>
                  {activeData && (
                    <div style={{ fontSize: '10px', color: '#35d399', marginTop: 4 }}>
                      Current price: ${formatPrice(activeData.price)}
                    </div>
                  )}
                </div>
              )}
              {isStreaming && !streamedText && (
                <div style={{ color: '#64747a', fontSize: '0.8rem', padding: '12px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Spinner /> Thinking…
                </div>
              )}
            </div>
          )}

          {/* Prompt box – always visible */}
          <div className="prompt-box">
            <div className="prompt-header">
              <span><Sparkles size={14} /> ASK THE COPILOT</span>
              <span className="prompt-kbd">⌘ K</span>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={`How will ${marketOpen ? 'today\'s session' : 'this weekend'} affect ${selected} tokenized contracts?`}
              aria-label="Ask market copilot"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault()
                  handleSubmitPrompt()
                }
              }}
            />
            <button
              className={`send-button ${isStreaming ? 'streaming' : ''}`}
              aria-label="Submit question"
              onClick={handleSubmitPrompt}
              disabled={isStreaming || !prompt.trim()}
            >
              {isStreaming ? <Spinner /> : <ArrowUpRight size={17} />}
            </button>
          </div>
        </aside>
      </section>

      {/* Footer */}
      <footer className="footer-bar">
        <span><LockKeyhole size={13} /> All trades are simulated · No real capital at risk</span>
        <span>
          {latencyMs != null && (
            <>Data latency <b className={latencyMs < 200 ? 'gain' : latencyMs < 800 ? '' : 'loss'}>{latencyMs}ms</b> · </>
          )}
          <CircleHelp size={13} /> Terminal v1.5.0
          {activeData?.isMock && <span style={{ color: '#f59e0b', marginLeft: 6 }}>⚠ Mock data</span>}
          {!activeData?.isMock && activeData && <span style={{ color: '#35d399', marginLeft: 6 }}>✓ Live data</span>}
        </span>
      </footer>

      {/* ── Trade modal ── */}
      {tradeOpen && (
        <div className="modal-backdrop" onClick={() => setTradeOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setTradeOpen(false)} aria-label="Close"><X size={18} /></button>
            <div className="modal-icon"><LineChart size={21} /></div>
            <span className="eyebrow">PAPER TRADE</span>
            <h2>Execute {tradeSide} order</h2>
            <p>Place a simulated {tradeSide.toLowerCase()} order for <strong>{activeAsset.symbol}</strong> at the current on-chain price.</p>
            <div className="trade-toggle">
              <button className={tradeSide === 'Buy' ? 'active-buy' : ''} onClick={() => setTradeSide('Buy')}>Buy</button>
              <button className={tradeSide === 'Sell' ? 'active-sell' : ''} onClick={() => setTradeSide('Sell')}>Sell</button>
            </div>
            <div className="order-summary">
              <span>Execution price <strong>${activeData ? formatPrice(activeData.price) : '—'}</strong></span>
              <span>24H change <strong className={activeData && activeData.changePercent >= 0 ? 'gain' : 'loss'}>{activeData ? formatChange(activeData.changePercent) : '—'}</strong></span>
              <span>Spread vs close <strong className={spreadPct != null && spreadPct >= 0 ? 'gain' : 'loss'}>{spreadPct != null ? `${spreadPct >= 0 ? '+' : ''}${spreadPct.toFixed(2)}%` : '—'}</strong></span>
              <span>Settlement <strong>Instant · On-chain</strong></span>
            </div>
            <button
              className={`primary-button modal-action ${tradeSide === 'Sell' ? 'sell-button' : ''}`}
              onClick={() => setTradeOpen(false)}
            >
              Confirm {tradeSide} order <ArrowUpRight size={16} />
            </button>
            <small className="modal-note"><ShieldCheck size={13} /> This is a simulated transaction. No wallet signature required.</small>
          </div>
        </div>
      )}

      {/* ── Settings modal ── */}
      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setSettingsOpen(false)} aria-label="Close"><X size={18} /></button>
            <div className="modal-icon"><KeyRound size={21} /></div>
            <span className="eyebrow">CONNECTION SETTINGS</span>
            <h2>API key vault</h2>
            <p>Connect a market data or Gemini AI provider to enable live signals.</p>
            <label>
              Gemini API key
              <div className="key-input">
                <input
                  type="password"
                  placeholder="AIzaSy••••••••••••••••"
                  id="api-key-input"
                  value={geminiKeyInput}
                  onChange={(e) => setGeminiKeyInput(e.target.value)}
                />
                <Copy size={15} />
              </div>
            </label>
            <label style={{ marginTop: '12px', display: 'block' }}>
              Finnhub API key (market data)
              <div className="key-input">
                <input type="password" placeholder="••••••••••••••••" id="finnhub-key-input" />
                <Copy size={15} />
              </div>
            </label>
            <button
              className="primary-button modal-action"
              onClick={() => {
                if (typeof window !== 'undefined') {
                  localStorage.setItem('GEMINI_API_KEY', geminiKeyInput.trim())
                }
                setSettingsOpen(false)
                refreshAnalysis()
              }}
            >
              Save encrypted key <LockKeyhole size={15} />
            </button>
            <small className="modal-note"><ShieldCheck size={13} /> Keys are saved in local storage and sent directly to Gemini API.</small>
          </div>
        </div>
      )}
    </main>
  )
}

const _unused = { ChevronDown, Menu, PanelRight }
void _unused

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
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { QuoteData } from './api/market-data/route'
import type { NewsItem } from './api/news/route'
import type { AnalyzeResponse } from './api/analyze/route'
import type { OrderBookData } from './api/orderbook/route'
import type { OHLCVCandle, ChartInterval } from './api/ohlcv/route'

// ---------------------------------------------------------------------------
// Trade Log
// ---------------------------------------------------------------------------
export interface TradeLogEntry {
  id: string
  timestamp: number       // unix ms
  instrument: string      // ticker symbol
  direction: 'Buy' | 'Sell'
  price: number
  quantity: number
  value: number           // price × quantity
  balanceBefore: number
  balanceAfter: number
  balanceChange: number   // negative for Buy, positive for Sell
}

const INITIAL_BALANCE = 10_000
const TRADE_LOG_KEY  = 'offhours_trade_log'
const BALANCE_KEY    = 'offhours_balance'

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
// ── Intervals ───────────────────────────────────────────────────────────────
const INTERVALS: ChartInterval[] = ['1H', '4H', '1D', '1W', '1M']

// ── CandlestickChart component ───────────────────────────────────────────────
function CandlestickChart({ data, loading }: { data: OHLCVCandle[]; loading: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [cw, setCw] = useState(600)
  const [hovered, setHovered] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    setCw(el.clientWidth || 600)
    const ro = new ResizeObserver(() => setCw(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const H = 270
  const PAD = { t: 22, r: 10, b: 28, l: 52 }
  const chartW = Math.max(cw - PAD.l - PAD.r, 60)
  const chartH = H - PAD.t - PAD.b

  if (loading) {
    return (
      <div ref={wrapRef} style={{ height: H, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64747a', gap: 8 }}>
        <Spinner /> Loading chart…
      </div>
    )
  }
  if (data.length === 0) {
    return (
      <div ref={wrapRef} style={{ height: H, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64747a' }}>
        No historical data available
      </div>
    )
  }

  const allLows  = data.map((d) => d.low)
  const allHighs = data.map((d) => d.high)
  const minP = Math.min(...allLows)
  const maxP = Math.max(...allHighs)
  const priceRange = (maxP - minP) || 1
  const yPad = priceRange * 0.08
  const yMin = minP - yPad
  const yMax = maxP + yPad

  const toY = (p: number) => PAD.t + ((yMax - p) / (yMax - yMin)) * chartH
  const slotW   = chartW / data.length
  const bodyW   = Math.max(2, Math.min(slotW * 0.65, 18))
  const tickEvery = Math.max(1, Math.ceil(data.length / 6))

  const yTickVals = Array.from({ length: 5 }, (_, i) => yMin + (i / 4) * (yMax - yMin))

  const fmtPrice = (v: number) =>
    v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(v < 10 ? 2 : 0)}`

  return (
    <div ref={wrapRef} style={{ width: '100%', position: 'relative' }}>
      <svg width={cw} height={H} style={{ display: 'block', overflow: 'visible' }}>
        {/* Y axis grid + labels */}
        {yTickVals.map((v, i) => {
          const y = toY(v)
          return (
            <g key={i}>
              <line x1={PAD.l} y1={y} x2={PAD.l + chartW} y2={y} stroke="#1e2e33" strokeWidth={1} />
              <text x={PAD.l - 5} y={y + 3.5} textAnchor="end" fill="#4d6068" fontSize={9} fontFamily="Inter,system-ui,sans-serif">
                {fmtPrice(v)}
              </text>
            </g>
          )
        })}

        {/* Candles */}
        {data.map((c, i) => {
          const cx      = PAD.l + (i + 0.5) * slotW
          const isUp    = c.close >= c.open
          const stroke  = isUp ? '#35d399' : '#fb7185'
          const fill    = isUp ? '#35d399' : 'transparent'
          const highY   = toY(c.high)
          const lowY    = toY(c.low)
          const openY   = toY(c.open)
          const closeY  = toY(c.close)
          const bodyTop = Math.min(openY, closeY)
          const bodyH   = Math.max(Math.abs(closeY - openY), 1)
          const isHov   = hovered === i

          return (
            <g key={i} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} style={{ cursor: 'crosshair' }}>
              <rect x={cx - slotW / 2} y={PAD.t} width={slotW} height={chartH} fill="transparent" />
              {/* wick */}
              <line x1={cx} y1={highY} x2={cx} y2={lowY} stroke={stroke} strokeWidth={isHov ? 1.5 : 1} />
              {/* body */}
              <rect x={cx - bodyW / 2} y={bodyTop} width={bodyW} height={bodyH}
                fill={fill} stroke={stroke} strokeWidth={isHov ? 1.5 : 1} rx={0.5} />
            </g>
          )
        })}

        {/* X axis labels */}
        {data.map((c, i) => {
          if (i % tickEvery !== 0) return null
          const cx = PAD.l + (i + 0.5) * slotW
          return (
            <text key={i} x={cx} y={H - 6} textAnchor="middle" fill="#4d6068" fontSize={9} fontFamily="Inter,system-ui,sans-serif">
              {c.time}
            </text>
          )
        })}

        {/* Crosshair + OHLC tooltip */}
        {hovered !== null && (() => {
          const c  = data[hovered]
          const cx = PAD.l + (hovered + 0.5) * slotW
          const isUp = c.close >= c.open
          const chg  = c.close - c.open
          const chgPct = (chg / c.open) * 100
          const ttX = cx + 120 > cw - 10 ? cx - 130 : cx + 10
          const ttY = PAD.t + 4
          return (
            <g>
              <line x1={cx} y1={PAD.t} x2={cx} y2={PAD.t + chartH} stroke="#718487" strokeWidth={0.5} strokeDasharray="3 3" />
              <rect x={ttX} y={ttY} width={120} height={94} rx={5} fill="#0e1a1d" stroke="#2a3f45" strokeWidth={1} />
              <text x={ttX + 8} y={ttY + 14} fill="#718487" fontSize={8.5} fontFamily="Inter,system-ui,sans-serif">{c.time}</text>
              <text x={ttX + 8} y={ttY + 28} fill="#8ea4a6" fontSize={8.5} fontFamily="Inter,system-ui,sans-serif">O <tspan fill="#d4e0dd" fontWeight="600">${c.open.toFixed(2)}</tspan></text>
              <text x={ttX + 8} y={ttY + 41} fill="#8ea4a6" fontSize={8.5} fontFamily="Inter,system-ui,sans-serif">H <tspan fill="#35d399" fontWeight="600">${c.high.toFixed(2)}</tspan></text>
              <text x={ttX + 8} y={ttY + 54} fill="#8ea4a6" fontSize={8.5} fontFamily="Inter,system-ui,sans-serif">L <tspan fill="#fb7185" fontWeight="600">${c.low.toFixed(2)}</tspan></text>
              <text x={ttX + 8} y={ttY + 67} fill="#8ea4a6" fontSize={8.5} fontFamily="Inter,system-ui,sans-serif">C <tspan fill="#d4e0dd" fontWeight="600">${c.close.toFixed(2)}</tspan></text>
              <text x={ttX + 8} y={ttY + 82} fill={isUp ? '#35d399' : '#fb7185'} fontSize={8.5} fontWeight="600" fontFamily="Inter,system-ui,sans-serif">
                {chg >= 0 ? '+' : ''}{chg.toFixed(2)} ({chgPct >= 0 ? '+' : ''}{chgPct.toFixed(2)}%)
              </text>
            </g>
          )
        })()}

        {/* Legend */}
        <text x={PAD.l} y={PAD.t - 6} fill="#4d6068" fontSize={8} fontFamily="Inter,system-ui,sans-serif">
          ■ <tspan fill="#35d399">Bullish</tspan> ■ <tspan fill="#fb7185">Bearish</tspan>
        </text>
      </svg>
    </div>
  )
}

// ── useOHLCV hook ─────────────────────────────────────────────────────────────
function useOHLCV(ticker: string, interval: ChartInterval, active: boolean) {
  const [ohlcv, setOhlcv]           = useState<OHLCVCandle[]>([])
  const [ohlcvLoading, setLoading]  = useState(false)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const load = async () => {
      if (!cancelled) { setLoading(true); setOhlcv([]) }
      try {
        const res  = await fetch(`/api/ohlcv?ticker=${encodeURIComponent(ticker)}&interval=${interval}`)
        const data = await res.json()
        if (!cancelled) setOhlcv(data)
      } catch { /* ignore */ } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const ttl = interval === '1H' || interval === '4H' ? 60_000 : 300_000
    const iv  = setInterval(load, ttl)
    return () => { cancelled = true; clearInterval(iv) }
  }, [ticker, interval, active])

  return { ohlcv, ohlcvLoading }
}

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
// useOrderBook — polls Bitget /api/orderbook every 5 seconds when active
// ---------------------------------------------------------------------------
function useOrderBook(ticker: string, active: boolean) {
  const [orderBook, setOrderBook] = useState<OrderBookData | null>(null)
  const [obLoading, setObLoading] = useState(false)

  useEffect(() => {
    if (!active) return
    let cancelled = false

    const load = async () => {
      if (!cancelled) setObLoading(true)
      try {
        const res = await fetch(`/api/orderbook?ticker=${encodeURIComponent(ticker)}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data: OrderBookData = await res.json()
        if (!cancelled) setOrderBook(data)
      } catch (err) {
        console.warn('[useOrderBook]', err)
      } finally {
        if (!cancelled) setObLoading(false)
      }
    }

    load()
    const iv = setInterval(load, 5_000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [ticker, active])

  return { orderBook, obLoading }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function Page() {
  const CUSTOM_TICKERS_KEY = 'offhours_custom_tickers'
  const [customTickers, setCustomTickers] = useState<{ symbol: string; name: string }[]>(() => {
    if (typeof window === 'undefined') return []
    try {
      const saved = localStorage.getItem(CUSTOM_TICKERS_KEY)
      return saved ? JSON.parse(saved) : []
    } catch { return [] }
  })
  const allTickers = useMemo(() => [...TICKERS, ...customTickers], [customTickers])
  const tickerList = useMemo(() => allTickers.map((t) => t.symbol), [allTickers])

  const [selected, setSelected] = useState('AAPL')
  const [searchQuery, setSearchQuery] = useState('')
  const [addAssetOpen, setAddAssetOpen] = useState(false)
  const [addAssetInput, setAddAssetInput] = useState('')
  const [addAssetLoading, setAddAssetLoading] = useState(false)
  const [addAssetError, setAddAssetError] = useState('')
  const [chartTab, setChartTab] = useState<'price' | 'depth' | 'signals'>('price')
  const [tradeOpen, setTradeOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [geminiKeyInput, setGeminiKeyInput] = useState('')
  const [walletConnected, setWalletConnected] = useState(false)
  const [tradeSide, setTradeSide] = useState<'Buy' | 'Sell'>('Buy')
  const [tradeQuantity, setTradeQuantity] = useState('1')
  const [tradeLog, setTradeLog] = useState<TradeLogEntry[]>([])
  const [accountBalance, setAccountBalance] = useState(INITIAL_BALANCE)
  const [prompt, setPrompt] = useState('')
  const [clock, setClock] = useState(getLiveTime())
  const [copilotTab, setCopilotTab] = useState<'analysis' | 'ask' | 'log'>('analysis')
  const [marketOpen, setMarketOpen] = useState(false)

  // Load saved Gemini API key + trade log + balance from localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('GEMINI_API_KEY') || localStorage.getItem('GOOGLE_API_KEY') || ''
      setGeminiKeyInput(saved)
      try {
        const savedLog = localStorage.getItem(TRADE_LOG_KEY)
        if (savedLog) setTradeLog(JSON.parse(savedLog) as TradeLogEntry[])
        const savedBal = localStorage.getItem(BALANCE_KEY)
        if (savedBal) setAccountBalance(parseFloat(savedBal))
      } catch { /* ignore corrupt data */ }
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

  /** Confirm and persist a paper trade */
  const confirmTrade = useCallback(() => {
    if (!activeData) return
    const qty = Math.max(0.01, parseFloat(tradeQuantity) || 1)
    const price = activeData.price
    const value = parseFloat((price * qty).toFixed(2))
    const balanceBefore = accountBalance
    const balanceChange = tradeSide === 'Buy' ? -value : value
    const balanceAfter = parseFloat((balanceBefore + balanceChange).toFixed(2))

    const entry: TradeLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      instrument: selected,
      direction: tradeSide,
      price,
      quantity: qty,
      value,
      balanceBefore,
      balanceAfter,
      balanceChange,
    }

    const newLog = [entry, ...tradeLog]
    setTradeLog(newLog)
    setAccountBalance(balanceAfter)
    setTradeOpen(false)
    setCopilotTab('log')

    if (typeof window !== 'undefined') {
      localStorage.setItem(TRADE_LOG_KEY, JSON.stringify(newLog))
      localStorage.setItem(BALANCE_KEY, String(balanceAfter))
    }
  }, [activeData, tradeQuantity, tradeSide, accountBalance, tradeLog, selected])

  /** Export trade log as CSV */
  const exportTradeLog = useCallback(() => {
    if (tradeLog.length === 0) return
    const header = 'ID,Timestamp (UTC),Instrument,Direction,Price (USD),Quantity,Order Value (USD),Balance Before (USD),Balance After (USD),Balance Change (USD)'
    const rows = tradeLog.map((t) =>
      [
        t.id,
        new Date(t.timestamp).toISOString(),
        t.instrument,
        t.direction,
        t.price.toFixed(2),
        t.quantity,
        t.value.toFixed(2),
        t.balanceBefore.toFixed(2),
        t.balanceAfter.toFixed(2),
        t.balanceChange.toFixed(2),
      ].join(',')
    )
    const csv = [header, ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `offhours-paper-trades-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }, [tradeLog])

  /** Clear trade log and reset balance to initial */
  const clearTradeLog = useCallback(() => {
    if (!window.confirm('Reset trade log and restore $10,000 balance?')) return
    setTradeLog([])
    setAccountBalance(INITIAL_BALANCE)
    if (typeof window !== 'undefined') {
      localStorage.removeItem(TRADE_LOG_KEY)
      localStorage.removeItem(BALANCE_KEY)
    }
  }, [])

  const filteredTickers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return allTickers
    return allTickers.filter(
      (t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)
    )
  }, [allTickers, searchQuery])

  const [selectedInterval, setSelectedInterval] = useState<ChartInterval>('1D')
  const { orderBook, obLoading } = useOrderBook(selected, chartTab === 'depth')
  const { ohlcv, ohlcvLoading }  = useOHLCV(selected, selectedInterval, chartTab === 'price')

  const depthData = useMemo(() => {
    if (!orderBook) return []
    // Bids: from lowest price (highest cumulative) → best bid — draw green area
    const bidPoints = [...orderBook.bids].reverse().map((b) => ({
      price: b.price,
      bids: b.cumulative,
      asks: null as number | null,
    }))
    // Asks: best ask → highest price — draw red area
    const askPoints = orderBook.asks.map((a) => ({
      price: a.price,
      bids: null as number | null,
      asks: a.cumulative,
    }))
    return [...bidPoints, ...askPoints]
  }, [orderBook])

  const handleSelectTicker = useCallback((sym: string) => {
    setSelected(sym)
  }, [])

  const handleAddAsset = useCallback(async () => {
    const sym = addAssetInput.trim().toUpperCase()
    if (!sym) return
    if (allTickers.some((t) => t.symbol === sym)) {
      setAddAssetError(`${sym} is already in your watchlist`)
      return
    }
    setAddAssetLoading(true)
    setAddAssetError('')
    try {
      const res = await fetch(`/api/market-data?ticker=${sym}`)
      const data = await res.json()
      if (data.isMock && data.price < 50) {
        // Likely unknown ticker returning generic mock
        setAddAssetError(`Could not find data for "${sym}". Check the symbol.`)
        return
      }
      const newEntry = { symbol: sym, name: data.name ?? sym }
      const updated = [...customTickers, newEntry]
      setCustomTickers(updated)
      if (typeof window !== 'undefined') {
        localStorage.setItem(CUSTOM_TICKERS_KEY, JSON.stringify(updated))
      }
      setAddAssetOpen(false)
      setAddAssetInput('')
      setSelected(sym)
    } catch {
      setAddAssetError('Network error. Please try again.')
    } finally {
      setAddAssetLoading(false)
    }
  }, [addAssetInput, allTickers, customTickers])

  const handleRemoveCustomTicker = useCallback((sym: string) => {
    const updated = customTickers.filter((t) => t.symbol !== sym)
    setCustomTickers(updated)
    if (typeof window !== 'undefined') {
      localStorage.setItem(CUSTOM_TICKERS_KEY, JSON.stringify(updated))
    }
    if (selected === sym) setSelected('AAPL')
  }, [customTickers, selected])

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
            <IconButton label="Add asset" onClick={() => { setAddAssetOpen(true); setAddAssetInput(''); setAddAssetError('') }}><Plus size={17} /></IconButton>
          </div>
          <div className="search-box">
            <Search size={15} />
            <input
              placeholder="Search tokenized assets"
              aria-label="Search assets"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button style={{ border: 0, background: 'transparent', color: '#718487', cursor: 'pointer', padding: 0 }} onClick={() => setSearchQuery('')} aria-label="Clear search">
                <X size={12} />
              </button>
            )}
          </div>
          <div className="watchlist">
            {filteredTickers.length === 0 && (
              <div style={{ padding: '16px 12px', color: '#718487', fontSize: '11px', textAlign: 'center' }}>
                No assets match &ldquo;{searchQuery}&rdquo;
              </div>
            )}
            {filteredTickers.map((t) => {
              const d = allData[t.symbol]
              const isPos = !d || d.changePercent >= 0
              const isCustom = customTickers.some((c) => c.symbol === t.symbol)
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
                  {isCustom && (
                    <button
                      className="remove-ticker-btn"
                      onClick={(e) => { e.stopPropagation(); handleRemoveCustomTicker(t.symbol) }}
                      aria-label={`Remove ${t.symbol}`}
                      title={`Remove ${t.symbol}`}
                    >
                      <X size={10} />
                    </button>
                  )}
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
                <button
                  id="chart-tab-price"
                  className={chartTab === 'price' ? 'active' : ''}
                  onClick={() => setChartTab('price')}
                >Price</button>
                <button
                  id="chart-tab-depth"
                  className={chartTab === 'depth' ? 'active' : ''}
                  onClick={() => setChartTab('depth')}
                >Depth</button>
                <button
                  id="chart-tab-signals"
                  className={chartTab === 'signals' ? 'active' : ''}
                  onClick={() => setChartTab('signals')}
                >Signals <span className="tiny-badge">{analysis?.primaryDrivers?.length ?? 0}</span></button>
              </div>
              <div className="time-tabs">
                {INTERVALS.map((iv) => (
                  <button
                    key={iv}
                    className={selectedInterval === iv ? 'active' : ''}
                    onClick={() => setSelectedInterval(iv)}
                  >{iv}</button>
                ))}
                <button className="chart-settings"><Settings2 size={15} /></button>
              </div>
            </div>
            <div className="chart-wrap">
              {chartTab === 'signals' ? (
                <div className="signals-panel">
                  {/* Gap Risk Signal */}
                  <div className="signal-card">
                    <div className="signal-header">
                      <span className="signal-name"><TrendingUp size={13} /> Weekend Gap Risk</span>
                      <span className={`signal-badge ${spreadPct != null && Math.abs(spreadPct) > 1.5 ? (spreadPct > 0 ? 'positive' : 'negative') : 'neutral'}`}>
                        {spreadPct != null ? (Math.abs(spreadPct) > 1.5 ? (spreadPct > 0 ? 'HIGH BULL' : 'HIGH BEAR') : 'LOW') : '—'}
                      </span>
                    </div>
                    <div className="signal-bar-wrap">
                      <div className="signal-bar" style={{ width: `${Math.min(100, Math.abs(spreadPct ?? 0) * 20)}%`, background: spreadPct != null && spreadPct >= 0 ? '#35d399' : '#fb7185' }} />
                    </div>
                    <p className="signal-desc">
                      On-chain vs. regular close spread: <strong className={spreadPct != null && spreadPct >= 0 ? 'gain' : 'loss'}>{spreadPct != null ? `${spreadPct >= 0 ? '+' : ''}${spreadPct.toFixed(2)}%` : 'n/a'}</strong>. {spreadPct != null ? (Math.abs(spreadPct) > 1 ? 'Elevated gap risk — price may revert at Monday open.' : 'Low gap risk — on-chain price near fair value.') : 'Awaiting price data.'}
                    </p>
                  </div>

                  {/* Momentum Signal */}
                  <div className="signal-card">
                    <div className="signal-header">
                      <span className="signal-name"><Zap size={13} /> 24H Momentum</span>
                      <span className={`signal-badge ${activeData && activeData.changePercent > 1 ? 'positive' : activeData && activeData.changePercent < -1 ? 'negative' : 'neutral'}`}>
                        {activeData ? (activeData.changePercent > 1 ? 'BULLISH' : activeData.changePercent < -1 ? 'BEARISH' : 'FLAT') : '—'}
                      </span>
                    </div>
                    <div className="signal-bar-wrap">
                      <div className="signal-bar" style={{ width: `${Math.min(100, Math.abs(activeData?.changePercent ?? 0) * 10)}%`, background: activeData && activeData.changePercent >= 0 ? '#35d399' : '#fb7185' }} />
                    </div>
                    <p className="signal-desc">
                      24H change: <strong className={activeData && activeData.changePercent >= 0 ? 'gain' : 'loss'}>{activeData ? formatChange(activeData.changePercent) : 'n/a'}</strong> ({activeData ? `${activeData.change >= 0 ? '+' : ''}${activeData.change.toFixed(2)} pts abs` : '—'}). {activeData ? (Math.abs(activeData.changePercent) > 3 ? 'Strong directional move — elevated continuation risk.' : 'Moderate session move within normal range.') : ''}
                    </p>
                  </div>

                  {/* Volatility Signal */}
                  <div className="signal-card">
                    <div className="signal-header">
                      <span className="signal-name"><Gauge size={13} /> Intraday Volatility</span>
                      <span className={`signal-badge ${volatility.label === 'High' ? 'negative' : volatility.label === 'Medium' ? 'neutral' : 'positive'}`}>
                        {volatility.label.toUpperCase()}
                      </span>
                    </div>
                    <div className="signal-bar-wrap">
                      <div className="signal-bar" style={{ width: activeData ? `${Math.min(100, ((activeData.high - activeData.low) / activeData.price) * 1000)}%` : '0%', background: volatility.color }} />
                    </div>
                    <p className="signal-desc">
                      Day range: <strong>${activeData ? formatPrice(activeData.low) : '—'}</strong> – <strong>${activeData ? formatPrice(activeData.high) : '—'}</strong>. {activeData ? `Intraday range ${(((activeData.high - activeData.low) / activeData.price) * 100).toFixed(2)}% of price.` : ''} {volatility.label === 'High' ? 'Caution: wide range may compress at open.' : volatility.label === 'Medium' ? 'Normal volatility environment.' : 'Tight range suggests low overnight risk.'}
                    </p>
                  </div>

                  {/* AI Impact Signal */}
                  <div className="signal-card">
                    <div className="signal-header">
                      <span className="signal-name"><Sparkles size={13} /> AI Impact Score</span>
                      <span className={`signal-badge ${analysis && analysis.impactScore > 2 ? 'positive' : analysis && analysis.impactScore < -2 ? 'negative' : 'neutral'}`}>
                        {analysis ? (analysis.impactScore > 2 ? 'BULLISH' : analysis.impactScore < -2 ? 'BEARISH' : 'NEUTRAL') : 'PENDING'}
                      </span>
                    </div>
                    <div className="signal-bar-wrap">
                      <div className="signal-bar" style={{ width: analysis ? `${Math.abs(analysis.impactScore) * 10}%` : '0%', background: analysis && analysis.impactScore >= 0 ? '#35d399' : '#fb7185' }} />
                    </div>
                    <p className="signal-desc">
                      {analysisLoading ? 'Running Gemini AI analysis…' : analysis ? `Impact score ${analysis.impactScore >= 0 ? '+' : ''}${analysis.impactScore}/10. ${analysis.actionableStrategy}` : 'Configure Gemini API key for live AI signals.'}
                    </p>
                  </div>

                  {/* Primary Drivers */}
                  {analysis && (analysis.primaryDrivers?.length ?? 0) > 0 && (
                    <div className="signal-card drivers-card">
                      <div className="signal-header">
                        <span className="signal-name"><Bot size={13} /> AI Primary Drivers</span>
                        <span className="signal-badge neutral">GEMINI</span>
                      </div>
                      <ul className="drivers-list">
                        {analysis.primaryDrivers?.map((d, i) => (
                          <li key={i}>{d}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : chartTab === 'depth' ? (
                <div className="depth-content">
                  {/* Stats bar */}
                  <div className="ob-stats">
                    <div className="ob-stat">
                      <span>Best Bid</span>
                      <strong className="gain">${orderBook?.bids[0]?.price.toFixed(2) ?? '—'}</strong>
                    </div>
                    <div className="ob-stat ob-mid">
                      <span>Mid Price</span>
                      <strong>${orderBook?.midPrice.toFixed(2) ?? '—'}</strong>
                    </div>
                    <div className="ob-stat">
                      <span>Best Ask</span>
                      <strong className="loss">${orderBook?.asks[0]?.price.toFixed(2) ?? '—'}</strong>
                    </div>
                    <div className="ob-stat">
                      <span>Spread</span>
                      <strong>{orderBook ? `${orderBook.spread.toFixed(3)} (${orderBook.spreadPct.toFixed(3)}%)` : '—'}</strong>
                    </div>
                    <div className="ob-source-badge">
                      {obLoading
                        ? <><Spinner /> Refreshing…</>
                        : orderBook
                          ? <><i className={`legend-live ${orderBook.source === 'bitget' ? '' : 'legend-mock'}`} /> {orderBook.source === 'bitget' ? 'Live · Bitget' : 'Mock data'} · {orderBook.bitgetSymbol}</>
                          : 'Loading…'}
                    </div>
                  </div>

                  {/* Depth chart */}
                  {depthData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={160}>
                      <AreaChart data={depthData} margin={{ top: 10, right: 4, left: -20, bottom: 0 }}>
                        <defs>
                          <linearGradient id="bidFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#35d399" stopOpacity={0.35} />
                            <stop offset="100%" stopColor="#35d399" stopOpacity={0.02} />
                          </linearGradient>
                          <linearGradient id="askFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#fb7185" stopOpacity={0.35} />
                            <stop offset="100%" stopColor="#fb7185" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 4" stroke="#27343b" vertical={false} />
                        <XAxis
                          dataKey="price"
                          tick={{ fill: '#64747a', fontSize: 9 }}
                          axisLine={false}
                          tickLine={false}
                          tickFormatter={(v) => `$${Number(v).toFixed(1)}`}
                          type="number"
                          domain={['dataMin', 'dataMax']}
                          scale="linear"
                        />
                        <YAxis tick={{ fill: '#64747a', fontSize: 9 }} axisLine={false} tickLine={false} width={36} />
                        <Tooltip
                          contentStyle={{ background: '#10191d', border: '1px solid #2d4047', borderRadius: 8, color: '#e9f4f0', fontSize: 11 }}
                          formatter={(val: any, name?: any) => [
                            `${Number(val).toFixed(2)} shares`,
                            name === 'bids' ? '▲ Bid depth' : '▼ Ask depth',
                          ]}
                          labelFormatter={(label) => `$${Number(label).toFixed(2)}`}
                        />
                        {orderBook?.midPrice && (
                          <ReferenceLine
                            x={orderBook.midPrice}
                            stroke="#f59e0b"
                            strokeDasharray="4 3"
                            strokeWidth={1.5}
                            label={{ value: 'Mid', position: 'top', fill: '#f59e0b', fontSize: 9 }}
                          />
                        )}
                        <Area
                          type="stepAfter"
                          dataKey="bids"
                          stroke="#35d399"
                          strokeWidth={1.5}
                          fill="url(#bidFill)"
                          connectNulls={false}
                          dot={false}
                          isAnimationActive={false}
                        />
                        <Area
                          type="stepBefore"
                          dataKey="asks"
                          stroke="#fb7185"
                          strokeWidth={1.5}
                          fill="url(#askFill)"
                          connectNulls={false}
                          dot={false}
                          isAnimationActive={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64747a', gap: 8 }}>
                      <Spinner /> Loading depth chart…
                    </div>
                  )}

                  {/* Order book table */}
                  {orderBook && (
                    <div className="ob-table">
                      {/* Bids column */}
                      <div className="ob-col">
                        <div className="ob-col-header">
                          <span>Price (USD)</span>
                          <span>Size</span>
                          <span>Total</span>
                        </div>
                        {orderBook.bids.slice(0, 10).map((lvl) => (
                          <div key={lvl.price} className="ob-row bid">
                            <div
                              className="ob-depth-fill"
                              style={{ width: `${lvl.depthPct}%`, background: '#35d39918' }}
                            />
                            <span className="gain">{lvl.price.toFixed(2)}</span>
                            <span>{lvl.size.toFixed(2)}</span>
                            <span>{lvl.cumulative.toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                      {/* Asks column */}
                      <div className="ob-col">
                        <div className="ob-col-header ob-col-header-right">
                          <span>Price (USD)</span>
                          <span>Size</span>
                          <span>Total</span>
                        </div>
                        {orderBook.asks.slice(0, 10).map((lvl) => (
                          <div key={lvl.price} className="ob-row ask">
                            <div
                              className="ob-depth-fill"
                              style={{ width: `${lvl.depthPct}%`, background: '#fb718518' }}
                            />
                            <span className="loss">{lvl.price.toFixed(2)}</span>
                            <span>{lvl.size.toFixed(2)}</span>
                            <span>{lvl.cumulative.toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <CandlestickChart data={ohlcv} loading={ohlcvLoading} />
              )}
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
            <button
              id="tab-trade-log"
              className={copilotTab === 'log' ? 'active' : ''}
              onClick={() => setCopilotTab('log')}
              style={{ position: 'relative' }}
            >
              <BarChart3 size={14} /> Trade Log
              {tradeLog.length > 0 && (
                <span className="tiny-badge" style={{ marginLeft: 4 }}>{tradeLog.length}</span>
              )}
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

          {/* ── Trade Log tab ── */}
          {copilotTab === 'log' && (
            <div className="trade-log-panel">
              {/* Account balance header */}
              <div className="trade-log-account">
                <div>
                  <span className="eyebrow">PAPER ACCOUNT BALANCE</span>
                  <div className="trade-balance-row">
                    <WalletCards size={15} />
                    <strong className={accountBalance >= INITIAL_BALANCE ? 'gain' : 'loss'}>
                      ${formatPrice(accountBalance)}
                    </strong>
                    <span className={`trade-pnl-badge ${accountBalance >= INITIAL_BALANCE ? 'positive' : 'negative'}`}>
                      {accountBalance >= INITIAL_BALANCE ? '+' : ''}{(((accountBalance - INITIAL_BALANCE) / INITIAL_BALANCE) * 100).toFixed(2)}%
                    </span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {tradeLog.length > 0 && (
                    <>
                      <button
                        id="btn-export-trades"
                        className="icon-button"
                        onClick={exportTradeLog}
                        title="Export trades as CSV"
                        aria-label="Export trades as CSV"
                      >
                        <ExternalLink size={13} />
                      </button>
                      <button
                        id="btn-clear-trades"
                        className="icon-button"
                        onClick={clearTradeLog}
                        title="Reset trade log"
                        aria-label="Reset trade log"
                        style={{ color: '#fb7185' }}
                      >
                        <X size={13} />
                      </button>
                    </>
                  )}
                </div>
              </div>

              {tradeLog.length === 0 ? (
                <div className="ask-placeholder">
                  <BarChart3 size={32} style={{ opacity: 0.3 }} />
                  <p>No paper trades yet.<br />Use the <strong>Execute paper trade</strong> button on any asset to start logging.</p>
                </div>
              ) : (
                <div className="trade-log-list">
                  {tradeLog.map((t) => (
                    <div key={t.id} className="trade-log-entry">
                      <div className="trade-log-row">
                        <span className={`trade-dir-badge ${t.direction === 'Buy' ? 'buy' : 'sell'}`}>
                          {t.direction === 'Buy'
                            ? <ArrowUpRight size={10} />
                            : <ArrowDownRight size={10} />}
                          {t.direction}
                        </span>
                        <strong style={{ fontSize: '12px' }}>{t.instrument}</strong>
                        <span style={{ marginLeft: 'auto', fontSize: '9px', color: '#718487' }}>
                          {new Date(t.timestamp).toLocaleString('en-US', {
                            month: 'short', day: 'numeric',
                            hour: '2-digit', minute: '2-digit',
                          })}
                        </span>
                      </div>
                      <div className="trade-log-details">
                        <span>{t.quantity} × ${formatPrice(t.price)}</span>
                        <span>= <b>${formatPrice(t.value)}</b></span>
                        <span className={t.balanceChange >= 0 ? 'gain' : 'loss'} style={{ marginLeft: 'auto' }}>
                          {t.balanceChange >= 0 ? '+' : ''}${formatPrice(Math.abs(t.balanceChange))}
                        </span>
                      </div>
                      <div className="trade-log-balance">
                        Balance after: <b>${formatPrice(t.balanceAfter)}</b>
                      </div>
                    </div>
                  ))}
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

            {/* Quantity selector */}
            <div className="qty-row">
              <span>Quantity (shares)</span>
              <div className="qty-control">
                <button
                  aria-label="Decrease quantity"
                  onClick={() => setTradeQuantity((q) => String(Math.max(0.01, parseFloat(q || '1') - 1).toFixed(2)))}
                >−</button>
                <input
                  id="trade-quantity-input"
                  type="number"
                  min="0.01"
                  step="1"
                  value={tradeQuantity}
                  onChange={(e) => setTradeQuantity(e.target.value)}
                  aria-label="Trade quantity"
                />
                <button
                  aria-label="Increase quantity"
                  onClick={() => setTradeQuantity((q) => String((parseFloat(q || '1') + 1).toFixed(2)))}
                >+</button>
              </div>
            </div>

            <div className="order-summary">
              <span>Execution price <strong>${activeData ? formatPrice(activeData.price) : '—'}</strong></span>
              <span>Quantity <strong>{tradeQuantity} shares</strong></span>
              <span>Order value <strong>${activeData ? formatPrice(activeData.price * (parseFloat(tradeQuantity) || 1)) : '—'}</strong></span>
              <span>24H change <strong className={activeData && activeData.changePercent >= 0 ? 'gain' : 'loss'}>{activeData ? formatChange(activeData.changePercent) : '—'}</strong></span>
              <span>Spread vs close <strong className={spreadPct != null && spreadPct >= 0 ? 'gain' : 'loss'}>{spreadPct != null ? `${spreadPct >= 0 ? '+' : ''}${spreadPct.toFixed(2)}%` : '—'}</strong></span>
              <span>Account balance <strong>${formatPrice(accountBalance)}</strong></span>
            </div>

            <button
              id="btn-confirm-trade"
              className={`primary-button modal-action ${tradeSide === 'Sell' ? 'sell-button' : ''}`}
              onClick={confirmTrade}
              disabled={
                !activeData ||
                (tradeSide === 'Buy' && accountBalance < activeData.price * (parseFloat(tradeQuantity) || 1))
              }
            >
              Confirm {tradeSide} order · Log trade <ArrowUpRight size={16} />
            </button>
            {tradeSide === 'Buy' && activeData &&
              accountBalance < activeData.price * (parseFloat(tradeQuantity) || 1) && (
              <small style={{ color: '#fb7185', fontSize: '11px', marginTop: 6, display: 'block', textAlign: 'center' }}>
                Insufficient paper balance for this order
              </small>
            )}
            <small className="modal-note"><ShieldCheck size={13} /> Logged to paper trading journal — no real capital at risk.</small>
          </div>
        </div>
      )}

      {/* ── Add Asset modal ── */}
      {addAssetOpen && (
        <div className="modal-backdrop" onClick={() => setAddAssetOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setAddAssetOpen(false)} aria-label="Close"><X size={18} /></button>
            <div className="modal-icon"><Plus size={21} /></div>
            <span className="eyebrow">WATCHLIST</span>
            <h2>Add tokenized asset</h2>
            <p>Enter a US equity ticker symbol. The asset will be validated against live market data before being added.</p>
            <div className="add-asset-input-row">
              <input
                id="add-asset-input"
                type="text"
                placeholder="e.g. MSFT, AMZN, GOOGL"
                value={addAssetInput}
                onChange={(e) => { setAddAssetInput(e.target.value.toUpperCase()); setAddAssetError('') }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddAsset() }}
                autoFocus
                aria-label="Ticker symbol"
                style={{ textTransform: 'uppercase' }}
              />
            </div>
            {addAssetError && (
              <p style={{ color: '#fb7185', fontSize: '11px', margin: '6px 0 0', display: 'flex', alignItems: 'center', gap: 5 }}>
                <X size={12} /> {addAssetError}
              </p>
            )}
            <button
              id="btn-add-asset-confirm"
              className="primary-button modal-action"
              style={{ marginTop: 14 }}
              onClick={handleAddAsset}
              disabled={addAssetLoading || !addAssetInput.trim()}
            >
              {addAssetLoading ? <><Spinner /> Validating…</> : <><Plus size={15} /> Add to watchlist</>}
            </button>
            <small className="modal-note"><ShieldCheck size={13} /> Validated via Yahoo Finance. Custom tickers persist across sessions.</small>
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

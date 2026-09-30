/**
 * /api/ohlcv – Historical OHLCV candlestick data via Yahoo Finance v8 chart API.
 * Supports 1H, 4H, 1D, 1W, 1M intervals with smart caching.
 */

import { NextRequest } from 'next/server'

// ── Types ────────────────────────────────────────────────────────────────────

export interface OHLCVCandle {
  time: string       // human-readable label
  timestamp: number  // unix ms
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type ChartInterval = '1H' | '4H' | '1D' | '1W' | '1M'

// ── Interval config ───────────────────────────────────────────────────────────

const INTERVAL_CONFIG: Record<ChartInterval, { yahooInterval: string; range: string }> = {
  '1H':  { yahooInterval: '60m',  range: '5d'  },
  '4H':  { yahooInterval: '60m',  range: '20d' }, // fetch 1H then aggregate
  '1D':  { yahooInterval: '1d',   range: '3mo' },
  '1W':  { yahooInterval: '1wk',  range: '2y'  },
  '1M':  { yahooInterval: '1mo',  range: '5y'  },
}

// Cache TTL: shorter for intraday intervals
const CACHE_TTL: Record<ChartInterval, number> = {
  '1H':  60_000,   // 1 min
  '4H':  90_000,   // 1.5 min
  '1D':  300_000,  // 5 min
  '1W':  600_000,  // 10 min
  '1M':  900_000,  // 15 min
}

// ── Time formatter ────────────────────────────────────────────────────────────

function fmtTime(unixSec: number, interval: ChartInterval): string {
  const d = new Date(unixSec * 1000)
  switch (interval) {
    case '1H':
    case '4H':
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
             d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
    case '1D':
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    case '1W':
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    case '1M':
      return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
  }
}

// ── 4H aggregation: merge every 4 × 1H candles ───────────────────────────────

function aggregate4H(candles: OHLCVCandle[]): OHLCVCandle[] {
  const result: OHLCVCandle[] = []
  for (let i = 0; i < candles.length; i += 4) {
    const group = candles.slice(i, i + 4)
    if (group.length === 0) continue
    result.push({
      time:      group[0].time,
      timestamp: group[0].timestamp,
      open:      group[0].open,
      high:      Math.max(...group.map((c) => c.high)),
      low:       Math.min(...group.map((c) => c.low)),
      close:     group[group.length - 1].close,
      volume:    group.reduce((s, c) => s + c.volume, 0),
    })
  }
  return result
}

// ── Yahoo Finance fetch ───────────────────────────────────────────────────────

async function fetchOHLCV(ticker: string, interval: ChartInterval): Promise<OHLCVCandle[]> {
  const { yahooInterval, range } = INTERVAL_CONFIG[interval]
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
              `?interval=${yahooInterval}&range=${range}&includePrePost=false`

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    next: { revalidate: 0 },
  })
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`)

  const json = await res.json()
  const result = json?.chart?.result?.[0]
  if (!result) throw new Error('Yahoo Finance: no data')

  const timestamps: number[]   = result.timestamp ?? []
  const q = result.indicators?.quote?.[0] ?? {}
  const opens:   (number | null)[] = q.open   ?? []
  const highs:   (number | null)[] = q.high   ?? []
  const lows:    (number | null)[] = q.low    ?? []
  const closes:  (number | null)[] = q.close  ?? []
  const volumes: (number | null)[] = q.volume ?? []

  let candles: OHLCVCandle[] = timestamps
    .map((ts, i) => ({
      time:      fmtTime(ts, interval),
      timestamp: ts * 1000,
      open:      opens[i]   ?? 0,
      high:      highs[i]   ?? 0,
      low:       lows[i]    ?? 0,
      close:     closes[i]  ?? 0,
      volume:    volumes[i] ?? 0,
    }))
    // filter out null/zero candles (Yahoo sometimes returns gaps)
    .filter((c) => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)

  if (interval === '4H') candles = aggregate4H(candles)

  return candles
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const cache = new Map<string, { data: OHLCVCandle[]; expiresAt: number }>()

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const ticker   = (searchParams.get('ticker')   ?? 'AAPL').toUpperCase().trim()
  const interval = (searchParams.get('interval') ?? '1D') as ChartInterval

  const key = `${ticker}-${interval}`
  const hit = cache.get(key)
  if (hit && Date.now() < hit.expiresAt) {
    return Response.json(hit.data, { headers: { 'X-Cache': 'HIT' } })
  }

  try {
    const data = await fetchOHLCV(ticker, interval)
    cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL[interval] })
    return Response.json(data, { headers: { 'X-Cache': 'MISS' } })
  } catch (err) {
    console.warn(`[ohlcv] ${ticker} ${interval}:`, (err as Error).message)
    // Return cached stale data if available, else empty array
    const stale = cache.get(key)
    return Response.json(stale?.data ?? [], { headers: { 'X-Cache': 'STALE' } })
  }
}

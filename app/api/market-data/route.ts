import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface QuoteData {
  ticker: string
  price: number
  change: number       // absolute change
  changePercent: number
  high: number
  low: number
  previousClose: number
  volume?: number
  timestamp: number
  isCached?: boolean
  isMock?: boolean
}

// ---------------------------------------------------------------------------
// In-memory cache (persists across requests within a single server instance)
// ---------------------------------------------------------------------------
const priceCache = new Map<string, { data: QuoteData; expiresAt: number }>()
const CACHE_TTL_MS = 15_000  // 15 seconds

function getCached(ticker: string): QuoteData | null {
  const entry = priceCache.get(ticker)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) return null
  return { ...entry.data, isCached: true }
}

function setCache(ticker: string, data: QuoteData) {
  priceCache.set(ticker, { data, expiresAt: Date.now() + CACHE_TTL_MS })
}

// ---------------------------------------------------------------------------
// Mock data (last resort)
// ---------------------------------------------------------------------------
const MOCK_PRICES: Record<string, Omit<QuoteData, 'ticker' | 'timestamp' | 'isMock'>> = {
  AAPL:  { price: 228.48, change: 2.84, changePercent: 1.26, high: 230.12, low: 221.84, previousClose: 225.64 },
  NVDA:  { price: 141.92, change: 7.02, changePercent: 5.20, high: 143.55, low: 133.10, previousClose: 134.90 },
  TSLA:  { price: 342.76, change: -5.62, changePercent: -1.62, high: 351.22, low: 338.40, previousClose: 348.38 },
  SPY:   { price: 594.21, change: 3.73, changePercent: 0.63, high: 596.80, low: 589.00, previousClose: 590.48 },
  COIN:  { price: 318.64, change: -10.82, changePercent: -3.28, high: 334.50, low: 315.20, previousClose: 329.46 },
  MSFT:  { price: 415.32, change: 2.15, changePercent: 0.52, high: 418.00, low: 410.50, previousClose: 413.17 },
  AMZN:  { price: 192.47, change: -1.23, changePercent: -0.64, high: 195.00, low: 191.30, previousClose: 193.70 },
  GOOGL: { price: 175.84, change: 1.94, changePercent: 1.11, high: 177.20, low: 173.60, previousClose: 173.90 },
  META:  { price: 588.30, change: 8.40, changePercent: 1.45, high: 592.00, low: 579.10, previousClose: 579.90 },
  BRK:   { price: 487.12, change: 1.22, changePercent: 0.25, high: 489.00, low: 484.50, previousClose: 485.90 },
}

function getMockQuote(ticker: string): QuoteData {
  const base = MOCK_PRICES[ticker] ?? {
    price: 100 + (ticker.charCodeAt(0) % 50),
    change: (ticker.charCodeAt(1) % 10) - 5,
    changePercent: (ticker.charCodeAt(1) % 10) - 5,
    high: 110 + (ticker.charCodeAt(0) % 50),
    low: 90 + (ticker.charCodeAt(0) % 50),
    previousClose: 95 + (ticker.charCodeAt(0) % 50),
  }

  // Add small random jitter to make mock feel alive
  const jitter = (Math.random() - 0.5) * 0.5
  return {
    ticker,
    ...base,
    price: parseFloat((base.price + jitter).toFixed(2)),
    timestamp: Date.now(),
    isMock: true,
  }
}

// ---------------------------------------------------------------------------
// Yahoo Finance – module-level singleton (avoids repeated env warnings)
// ---------------------------------------------------------------------------
let _yfInstance: InstanceType<Awaited<typeof import('yahoo-finance2')>['default']> | null = null

async function getYF() {
  if (!_yfInstance) {
    const YahooFinance = (await import('yahoo-finance2')).default
    // suppressNotices silences the survey nag; the Node version warning is
    // a runtime advisory only – data still fetches successfully on Node 21.
    _yfInstance = new YahooFinance({
      suppressNotices: ['yahooSurvey'],
    })
  }
  return _yfInstance
}

async function fetchFromYahooFinance(ticker: string): Promise<QuoteData> {
  const yf = await getYF()
  const quote = await yf.quote(ticker)

  return {
    ticker,
    price: quote.regularMarketPrice ?? 0,
    change: quote.regularMarketChange ?? 0,
    changePercent: quote.regularMarketChangePercent ?? 0,
    high: quote.regularMarketDayHigh ?? 0,
    low: quote.regularMarketDayLow ?? 0,
    previousClose: quote.regularMarketPreviousClose ?? 0,
    volume: quote.regularMarketVolume ?? undefined,
    timestamp: Date.now(),
    isMock: false,
  }
}

// ---------------------------------------------------------------------------
// Finnhub fetcher (optional - if FINNHUB_API_KEY is set)
// ---------------------------------------------------------------------------
async function fetchFromFinnhub(ticker: string): Promise<QuoteData> {
  const apiKey = process.env.FINNHUB_API_KEY
  if (!apiKey) throw new Error('No Finnhub key')

  const res = await fetch(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${apiKey}`,
    { next: { revalidate: 0 } }
  )
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`)

  const data = await res.json()
  if (!data.c || data.c === 0) throw new Error('Finnhub returned empty quote')

  return {
    ticker,
    price: data.c,
    change: data.d ?? 0,
    changePercent: data.dp ?? 0,
    high: data.h ?? 0,
    low: data.l ?? 0,
    previousClose: data.pc ?? 0,
    timestamp: Date.now(),
    isMock: false,
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const ticker = (searchParams.get('ticker') ?? 'AAPL').toUpperCase().trim()

  if (!ticker) {
    return Response.json({ error: 'ticker parameter is required' }, { status: 400 })
  }

  // 1️⃣ Check cache first
  const cached = getCached(ticker)
  if (cached) {
    return Response.json(cached)
  }

  // 2️⃣ Try Finnhub if API key available
  if (process.env.FINNHUB_API_KEY) {
    try {
      const data = await fetchFromFinnhub(ticker)
      setCache(ticker, data)
      return Response.json(data)
    } catch (err) {
      console.warn(`[market-data] Finnhub failed for ${ticker}:`, err)
    }
  }

  // 3️⃣ Try Yahoo Finance (no key needed)
  try {
    const data = await fetchFromYahooFinance(ticker)
    setCache(ticker, data)
    return Response.json(data)
  } catch (err) {
    console.warn(`[market-data] Yahoo Finance failed for ${ticker}:`, err)
  }

  // 4️⃣ Last resort: stale cache or mock
  const staleEntry = priceCache.get(ticker)
  if (staleEntry) {
    return Response.json({ ...staleEntry.data, isCached: true })
  }

  const mock = getMockQuote(ticker)
  return Response.json(mock)
}

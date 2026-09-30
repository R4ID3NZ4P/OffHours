/**
 * /api/orderbook
 *
 * Fetches live order book depth data from Bitget Spot API.
 * The orderbook endpoint is public; API key/secret are forwarded via headers
 * for authenticated rate-limit tier (1 req/100ms with key vs 1 req/500ms without).
 *
 * Endpoint: GET https://api.bitget.com/api/v2/spot/market/orderbook
 * Docs: https://www.bitget.com/api-doc/spot/market/Get-Orderbook
 */

import crypto from 'crypto'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface OrderBookLevel {
  price: number
  size: number
  cumulative: number
  /** 0–100, percentage of the side's total depth */
  depthPct: number
}

export interface OrderBookData {
  symbol: string
  bitgetSymbol: string
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  midPrice: number
  spread: number
  spreadPct: number
  totalBidDepth: number  // USDT value
  totalAskDepth: number
  timestamp: number
  source: 'bitget' | 'mock'
}

// ---------------------------------------------------------------------------
// Symbol mapping: app ticker → Bitget tokenized stock symbol
// Bitget uses "r" prefix for tokenized equities, no underscores in the symbol string.
// Confirmed via: GET /api/v2/spot/public/symbols
// ---------------------------------------------------------------------------
const BITGET_SYMBOL_MAP: Record<string, string> = {
  AAPL:  'RAAPLUSDT',
  NVDA:  'RNVDAUSDT',
  TSLA:  'RTSLAUSDT',
  SPY:   'RSPYUSDT',
  COIN:  'COINUSDT',   // COIN is a native crypto listing on Bitget
  MSFT:  'RMSFTUSDT',  // rMSFT tokenized on Bitget
  AMZN:  'RAMZNUSDT',
  GOOGL: 'RGOOGLUSDT',
  META:  'RMETAUSDT',
  BRK:   'RBRKBUSDT',  // may not exist – falls back to mock gracefully
}

function getBitgetSymbol(ticker: string): string {
  return BITGET_SYMBOL_MAP[ticker] ?? `R${ticker}USDT`
}

// ---------------------------------------------------------------------------
// Bitget request signing (HMAC-SHA256) — used only when env keys present
// ---------------------------------------------------------------------------
function buildHeaders(method: string, path: string, body = ''): Record<string, string> {
  const apiKey    = process.env.BITGET_API_KEY    ?? ''
  const secretKey = process.env.BITGET_SECRET_KEY ?? ''
  const passphrase = process.env.BITGET_PASSPHRASE ?? ''

  if (!apiKey || !secretKey) return {}

  const ts = Date.now().toString()
  const preHash = ts + method.toUpperCase() + path + body
  const sign = crypto.createHmac('sha256', secretKey).update(preHash).digest('base64')

  return {
    'ACCESS-KEY':        apiKey,
    'ACCESS-SIGN':       sign,
    'ACCESS-TIMESTAMP':  ts,
    'ACCESS-PASSPHRASE': passphrase,
    'Content-Type':      'application/json',
    'locale':            'en-US',
  }
}

// ---------------------------------------------------------------------------
// Level enrichment helper
// ---------------------------------------------------------------------------
function enrichLevels(raw: [string, string][], totalVolume: number): OrderBookLevel[] {
  let cum = 0
  return raw.map(([p, s]) => {
    const price = parseFloat(p)
    const size  = parseFloat(s)
    cum += size
    return {
      price,
      size,
      cumulative: parseFloat(cum.toFixed(4)),
      depthPct: totalVolume > 0 ? parseFloat(((cum / totalVolume) * 100).toFixed(1)) : 0,
    }
  })
}

// ---------------------------------------------------------------------------
// Bitget fetch
// ---------------------------------------------------------------------------
async function fetchBitgetOrderBook(ticker: string): Promise<OrderBookData> {
  const bitgetSymbol = getBitgetSymbol(ticker)
  const requestPath  = `/api/v2/spot/market/orderbook?symbol=${bitgetSymbol}&limit=20`
  const url          = `https://api.bitget.com${requestPath}`

  const headers = {
    'Content-Type': 'application/json',
    ...buildHeaders('GET', requestPath),
  }

  const res = await fetch(url, { headers, next: { revalidate: 0 } })
  if (!res.ok) throw new Error(`Bitget HTTP ${res.status}`)

  const json = await res.json()
  if (json.code !== '00000') throw new Error(`Bitget error: ${json.msg} (${json.code})`)

  const rawBids: [string, string][] = json.data?.bids ?? []
  const rawAsks: [string, string][] = json.data?.asks ?? []

  // total volume for normalisation
  const totalBidVol = rawBids.reduce((s, [, sz]) => s + parseFloat(sz), 0)
  const totalAskVol = rawAsks.reduce((s, [, sz]) => s + parseFloat(sz), 0)

  const bids = enrichLevels(rawBids, totalBidVol)
  const asks = enrichLevels(rawAsks, totalAskVol)

  const bestBid = bids[0]?.price ?? 0
  const bestAsk = asks[0]?.price ?? 0

  return {
    symbol: ticker,
    bitgetSymbol,
    bids,
    asks,
    midPrice: parseFloat(((bestBid + bestAsk) / 2).toFixed(4)),
    spread: parseFloat((bestAsk - bestBid).toFixed(4)),
    spreadPct: bestBid > 0
      ? parseFloat(((bestAsk - bestBid) / bestBid * 100).toFixed(4))
      : 0,
    totalBidDepth: parseFloat(bids.reduce((s, l) => s + l.price * l.size, 0).toFixed(2)),
    totalAskDepth: parseFloat(asks.reduce((s, l) => s + l.price * l.size, 0).toFixed(2)),
    timestamp: parseInt(json.data?.ts ?? String(Date.now()), 10),
    source: 'bitget',
  }
}

// ---------------------------------------------------------------------------
// Mock fallback (seeded from rough market prices, randomised each call)
// ---------------------------------------------------------------------------
const MOCK_MID: Record<string, number> = {
  AAPL: 228.48, NVDA: 141.92, TSLA: 342.76, SPY: 594.21,
  COIN: 318.64,  MSFT: 415.32, AMZN: 192.47, GOOGL: 175.84,
  META: 588.30,  BRK: 487.12,
}

function getMockOrderBook(ticker: string): OrderBookData {
  const mid    = MOCK_MID[ticker] ?? 100
  const tick   = mid < 20 ? 0.01 : mid < 100 ? 0.05 : 0.10
  const levels = 15

  let cumBid = 0
  const bids: OrderBookLevel[] = Array.from({ length: levels }, (_, i) => {
    const price = parseFloat((mid - tick * (i + 1)).toFixed(2))
    const size  = parseFloat((Math.random() * 450 + 50).toFixed(0))
    cumBid += size
    return { price, size, cumulative: cumBid, depthPct: 0 }
  })
  const totalBidVol = cumBid
  bids.forEach((b) => { b.depthPct = parseFloat(((b.cumulative / totalBidVol) * 100).toFixed(1)) })

  let cumAsk = 0
  const asks: OrderBookLevel[] = Array.from({ length: levels }, (_, i) => {
    const price = parseFloat((mid + tick * (i + 1)).toFixed(2))
    const size  = parseFloat((Math.random() * 450 + 50).toFixed(0))
    cumAsk += size
    return { price, size, cumulative: cumAsk, depthPct: 0 }
  })
  const totalAskVol = cumAsk
  asks.forEach((a) => { a.depthPct = parseFloat(((a.cumulative / totalAskVol) * 100).toFixed(1)) })

  const bestBid = bids[0].price
  const bestAsk = asks[0].price

  return {
    symbol: ticker,
    bitgetSymbol: getBitgetSymbol(ticker),
    bids,
    asks,
    midPrice: parseFloat(((bestBid + bestAsk) / 2).toFixed(4)),
    spread: parseFloat((bestAsk - bestBid).toFixed(4)),
    spreadPct: parseFloat(((bestAsk - bestBid) / bestBid * 100).toFixed(4)),
    totalBidDepth: parseFloat(bids.reduce((s, l) => s + l.price * l.size, 0).toFixed(2)),
    totalAskDepth: parseFloat(asks.reduce((s, l) => s + l.price * l.size, 0).toFixed(2)),
    timestamp: Date.now(),
    source: 'mock',
  }
}

// ---------------------------------------------------------------------------
// 5-second server-side cache to avoid hammering Bitget
// ---------------------------------------------------------------------------
const cache = new Map<string, { data: OrderBookData; expiresAt: number }>()

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const ticker = (searchParams.get('ticker') ?? 'AAPL').toUpperCase().trim()

  const hit = cache.get(ticker)
  if (hit && Date.now() < hit.expiresAt) {
    return Response.json(hit.data, {
      headers: { 'X-Cache': 'HIT', 'X-Source': hit.data.source },
    })
  }

  try {
    const data = await fetchBitgetOrderBook(ticker)
    cache.set(ticker, { data, expiresAt: Date.now() + 5_000 })
    return Response.json(data, {
      headers: { 'X-Cache': 'MISS', 'X-Source': 'bitget' },
    })
  } catch (err) {
    console.warn(`[orderbook] Bitget failed for ${ticker}:`, (err as Error).message)
    const mock = getMockOrderBook(ticker)
    return Response.json(mock, {
      headers: { 'X-Cache': 'MISS', 'X-Source': 'mock' },
    })
  }
}

import { NextRequest } from 'next/server'
import { GoogleGenAI } from '@google/genai'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface NewsItem {
  id: string
  title: string
  source: string
  url: string
  publishedAt: number   // unix timestamp (seconds)
  summary?: string
  sentiment: 'Bullish' | 'Bearish' | 'Neutral'
  impactScore: number   // -10 to +10
  category?: string
  isMock?: boolean
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------
const newsCache = new Map<string, { items: NewsItem[]; expiresAt: number }>()
const CACHE_TTL_MS = 60_000  // 1 minute

function getCachedNews(ticker: string) {
  const entry = newsCache.get(ticker)
  if (!entry || Date.now() > entry.expiresAt) return null
  return entry.items
}

function setCachedNews(ticker: string, items: NewsItem[]) {
  newsCache.set(ticker, { items, expiresAt: Date.now() + CACHE_TTL_MS })
}

// ---------------------------------------------------------------------------
// Mock news (fallback)
// ---------------------------------------------------------------------------
const MOCK_NEWS_POOL = [
  {
    title: 'Fed signals patience on rate cuts amid persistent inflation pressures',
    source: 'Reuters',
    category: 'MACRO',
    sentiment: 'Bullish' as const,
    impactScore: 4.2,
  },
  {
    title: 'SEC publishes final framework for tokenized equity settlement on-chain',
    source: 'Bloomberg',
    category: 'REGULATION',
    sentiment: 'Bullish' as const,
    impactScore: 6.8,
  },
  {
    title: 'New export controls could reshape advanced semiconductor supply chains',
    source: 'FT',
    category: 'GEOPOLITICS',
    sentiment: 'Bearish' as const,
    impactScore: -4.1,
  },
  {
    title: 'Institutional flows into tokenized US equities surge 28% week-on-week',
    source: 'CoinDesk',
    category: 'MARKET',
    sentiment: 'Bullish' as const,
    impactScore: 5.5,
  },
  {
    title: 'Options market prices elevated weekend gap risk for large-cap tech',
    source: 'Market Watch',
    category: 'OPTIONS',
    sentiment: 'Neutral' as const,
    impactScore: -1.2,
  },
]

function getMockNews(ticker: string): NewsItem[] {
  const now = Math.floor(Date.now() / 1000)
  return MOCK_NEWS_POOL.map((n, i) => ({
    id: `mock-${ticker}-${i}`,
    title: n.title.replace(/tech|equity/gi, ticker),
    source: n.source,
    url: '#',
    publishedAt: now - i * 900,
    sentiment: n.sentiment,
    impactScore: n.impactScore,
    category: n.category,
    isMock: true,
  }))
}

// ---------------------------------------------------------------------------
// Finnhub news fetcher
// ---------------------------------------------------------------------------
async function fetchFinnhubNews(ticker: string): Promise<Omit<NewsItem, 'sentiment' | 'impactScore'>[]> {
  const apiKey = process.env.FINNHUB_API_KEY
  if (!apiKey) throw new Error('No Finnhub key')

  const toDate = new Date().toISOString().split('T')[0]
  const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  const res = await fetch(
    `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${fromDate}&to=${toDate}&token=${apiKey}`,
    { next: { revalidate: 0 } }
  )
  if (!res.ok) throw new Error(`Finnhub news HTTP ${res.status}`)

  const data: Array<{
    id: number
    headline: string
    source: string
    url: string
    datetime: number
    summary?: string
    category?: string
  }> = await res.json()

  return data.slice(0, 8).map((item) => ({
    id: String(item.id),
    title: item.headline,
    source: item.source,
    url: item.url,
    publishedAt: item.datetime,
    summary: item.summary,
    category: item.category?.toUpperCase(),
    isMock: false,
  }))
}

// ---------------------------------------------------------------------------
// AI sentiment tagging (using official @google/genai SDK)
// ---------------------------------------------------------------------------
async function tagSentiments(
  articles: Omit<NewsItem, 'sentiment' | 'impactScore'>[],
  ticker: string,
  customApiKey?: string,
): Promise<NewsItem[]> {
  const envKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim()
  const apiKey = customApiKey || envKey || null

  if (!apiKey || articles.length === 0) {
    // Fallback: simple keyword-based sentiment
    return articles.map((a) => ({
      ...a,
      sentiment: /surge|rally|gain|beat|positive|up|rise|record|high/i.test(a.title)
        ? 'Bullish'
        : /drop|fall|loss|miss|negative|down|cut|ban|concern/i.test(a.title)
        ? 'Bearish'
        : 'Neutral',
      impactScore: 0,
    }))
  }

  const ai = new GoogleGenAI({ apiKey })
  const model = process.env.GEMINI_MODEL ?? process.env.LLM_MODEL ?? 'gemini-2.5-flash'
  const headlineList = articles.map((a, i) => `${i}. ${a.title}`).join('\n')

  try {
    const response = await ai.models.generateContent({
      model,
      contents: headlineList,
      config: {
        systemInstruction: `You are a financial sentiment analyst. For each headline, return a JSON object containing a "results" array of objects with keys: index (number), sentiment ("Bullish"|"Bearish"|"Neutral"), impactScore (number from -10 to 10). The ticker in focus is ${ticker}.`,
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    })

    const raw = response.text ?? ''
    const parsed: {
      results?: Array<{ index: number; sentiment: string; impactScore: number }>
      items?: Array<{ index: number; sentiment: string; impactScore: number }>
    } = JSON.parse(raw)
    const results = parsed.results ?? parsed.items ?? []
    const sentimentMap = new Map(results.map((r) => [r.index, r]))

    return articles.map((a, i) => {
      const tag = sentimentMap.get(i)
      return {
        ...a,
        sentiment: (tag?.sentiment as NewsItem['sentiment']) ?? 'Neutral',
        impactScore: tag?.impactScore ?? 0,
      }
    })
  } catch {
    return articles.map((a) => ({
      ...a,
      sentiment: 'Neutral',
      impactScore: 0,
    }))
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const ticker = (searchParams.get('ticker') ?? 'AAPL').toUpperCase().trim()
  const customKey = request.headers.get('x-api-key')?.trim()

  // Check cache
  const cached = getCachedNews(ticker)
  if (cached) return Response.json(cached)

  // Try Finnhub
  try {
    const raw = await fetchFinnhubNews(ticker)
    if (raw.length > 0) {
      const tagged = await tagSentiments(raw, ticker, customKey)
      setCachedNews(ticker, tagged)
      return Response.json(tagged)
    }
  } catch {
    // Finnhub key not configured or rate-limited — falling back to mock (expected)
  }

  // Fallback: mock
  const mock = getMockNews(ticker)
  return Response.json(mock)
}

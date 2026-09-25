import { NextRequest } from 'next/server'
import { GoogleGenAI } from '@google/genai'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface AnalyzeRequest {
  ticker: string
  currentPrice?: number
  userQuery: string
}

export interface AnalyzeResponse {
  impactScore: number        // -10 to +10
  primaryDrivers: string[]   // 3 bullets
  actionableStrategy: string
  summary?: string           // streaming-friendly text
  isMock?: boolean
}

// ---------------------------------------------------------------------------
// Mock fallback (shown when no Gemini API key is configured)
// ---------------------------------------------------------------------------
function getMockResponse(ticker: string, userQuery: string): AnalyzeResponse {
  const seed = ticker.charCodeAt(0) + ticker.charCodeAt(ticker.length - 1)
  const score = parseFloat(((seed % 21) - 10 + Math.random() * 2 - 1).toFixed(1))

  return {
    impactScore: Math.min(10, Math.max(-10, score)),
    primaryDrivers: [
      `${ticker} showing elevated off-hours implied volatility relative to 30-day average`,
      'Macro rate expectations shift creating cross-asset premium divergence',
      'Tokenized equity liquidity depth supports current price discovery efficiency',
    ],
    actionableStrategy:
      score > 0
        ? 'Accumulate tokenized spot on weekend dips; hedge via perps at key resistance'
        : 'Hedge weekend volatility via tokenized perps; monitor pre-market convergence',
    summary: `Mock analysis for ${ticker}: ${userQuery}. (Configure GEMINI_API_KEY to enable live Gemini AI analysis.)`,
    isMock: true,
  }
}

// ---------------------------------------------------------------------------
// Helper: Resolve Gemini client configuration
// ---------------------------------------------------------------------------
function getGeminiClient(request?: NextRequest) {
  const customKey = request?.headers.get('x-api-key')?.trim()
  const envKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim()
  const apiKey = customKey || envKey || null

  if (!apiKey) return null

  const ai = new GoogleGenAI({ apiKey })
  const model = process.env.GEMINI_MODEL ?? process.env.LLM_MODEL ?? 'gemini-2.5-flash'

  return { ai, model }
}

// ---------------------------------------------------------------------------
// Route handler – POST /api/analyze
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  let body: Partial<AnalyzeRequest> = {}
  try {
    body = (await request.json()) as Partial<AnalyzeRequest>
  } catch { /* ignore JSON parse errors */ }

  try {
    const ticker = (body.ticker ?? 'UNKNOWN').toUpperCase()
    const currentPrice = body.currentPrice
    const userQuery = body.userQuery ?? ticker

    const clientConfig = getGeminiClient(request)

    if (!clientConfig) {
      console.warn('[analyze] No GEMINI_API_KEY configured – returning mock response')
      return Response.json(getMockResponse(ticker, userQuery))
    }

    const { ai, model } = clientConfig

    const systemPrompt = `You are a 24/7 quantitative macro analyst specializing in tokenized US equities. Analyze the provided news or ticker query. Provide:
1. Impact Score: [-10 to +10]
2. Primary Drivers: (3 short bullets)
3. Actionable Strategy: (e.g., 'Hedge weekend volatility via tokenized spot/perps' or 'Monitor pre-market convergence')
Respond in clean JSON format with keys: impactScore (number), primaryDrivers (string[]), actionableStrategy (string).`

    const priceContext = currentPrice != null ? ` The current on-chain price is $${currentPrice}.` : ''
    const userMessage = `Ticker: ${ticker}.${priceContext} Query: ${userQuery}`

    const response = await ai.models.generateContent({
      model,
      contents: userMessage,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        temperature: 0.4,
      },
    })

    const raw = response.text ?? ''

    let parsed: AnalyzeResponse
    try {
      const json = JSON.parse(raw)
      parsed = {
        impactScore: Number(json.impactScore ?? json.impact_score ?? 0),
        primaryDrivers: json.primaryDrivers ?? json.primary_drivers ?? [],
        actionableStrategy: json.actionableStrategy ?? json.actionable_strategy ?? '',
        isMock: false,
      }
    } catch {
      console.warn('[analyze] Failed to parse Gemini JSON, using mock')
      parsed = getMockResponse(ticker, userQuery)
    }

    return Response.json(parsed)
  } catch (err: unknown) {
    console.error('[analyze] Unhandled error:', err)
    return Response.json(getMockResponse(body.ticker ?? 'UNKNOWN', body.userQuery ?? ''))
  }
}

// ---------------------------------------------------------------------------
// Streaming endpoint – GET /api/analyze?ticker=TSLA&query=...
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const ticker = (searchParams.get('ticker') ?? 'UNKNOWN').toUpperCase()
  const userQuery = searchParams.get('query') ?? ticker
  const currentPriceStr = searchParams.get('price')
  const currentPrice = currentPriceStr ? parseFloat(currentPriceStr) : undefined

  const clientConfig = getGeminiClient(request)

  if (!clientConfig) {
    const mock = getMockResponse(ticker, userQuery)
    const streamText = `${mock.summary ?? ''} Impact: ${mock.impactScore}/10. Strategy: ${mock.actionableStrategy}`
    const encoder = new TextEncoder()
    const words = streamText.split(' ')
    let i = 0

    const readableStream = new ReadableStream({
      async start(controller) {
        const interval = setInterval(() => {
          if (i < words.length) {
            controller.enqueue(encoder.encode(words[i++] + ' '))
          } else {
            clearInterval(interval)
            controller.enqueue(encoder.encode('\n\n__DONE__'))
            controller.close()
          }
        }, 60)
      },
    })

    return new Response(readableStream, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Stream': '1' },
    })
  }

  const { ai, model } = clientConfig

  const systemPrompt = `You are an institutional trading assistant for tokenized US stocks. The user wants analysis on ${ticker}${currentPrice ? ` currently trading at $${currentPrice}` : ''}. Analyze the current market context, assess weekend/after-hours volatility risks, and provide 3 concise bullet points with trading implications. Be direct and quantitative.`

  const responseStream = await ai.models.generateContentStream({
    model,
    contents: userQuery,
    config: {
      systemInstruction: systemPrompt,
      temperature: 0.5,
    },
  })

  const encoder = new TextEncoder()
  const readableStream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of responseStream) {
          if (chunk.text) {
            controller.enqueue(encoder.encode(chunk.text))
          }
        }
        controller.enqueue(encoder.encode('\n\n__DONE__'))
      } catch (err) {
        console.error('[analyze] stream error', err)
        controller.error(err)
      } finally {
        controller.close()
      }
    },
  })

  return new Response(readableStream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Stream': '1',
    },
  })
}

# ⚡ Off-Hours AI Trading Desk

> **An AI research desk and risk-aware paper-trading terminal for tokenized US equities, which trade 24/7 while their underlying markets don't.**

[![Next.js](https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js)](https://nextjs.org/)
[![Google Gemini](https://img.shields.io/badge/Google_Gemini-2.5--Flash-4285F4?style=flat-square&logo=google)](https://ai.google.dev/)
[![Bitget](https://img.shields.io/badge/Bitget-Spot_Market_API-00F0FF?style=flat-square)](https://www.bitget.com/api-doc/spot/market/Get-Orderbook)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](#-license)

---

## 🎯 The Problem

US exchanges are open about **32 hours a week**. Tokenized stocks on Bitget trade **168**. For the other ~136 hours, price is set by crypto-native flow with:

- **Gap risk:** weekend news can move the price far from the last regulated close.
- **Thin liquidity:** shallow order books mean bigger slippage.
- **No analyst on duty:** nobody is interpreting headlines at 3am on a Sunday.

Exchange UIs show data without judgment, chatbots give judgment without live data, and pro terminals don't cover this niche. **Off-Hours AI Trading Desk puts the live data, an AI analyst, and a risk-aware order ticket on one screen.**

## 👤 Who It's For

Retail-plus / semi-pro, crypto-native traders (about $1k–$25k, moderate-to-aggressive risk, a few trades a week) who trade US-equity exposure on-chain during evenings and weekends and have no research team.

---

## 🌟 Features

| Area | What you get |
| :--- | :--- |
| 📈 **Live market context** | Tokenized-equity watchlist (`AAPL`, `NVDA`, `TSLA`, `SPY`, `COIN` + any custom ticker), live price vs. previous close, 24h range, volatility label and market-pulse score |
| 🕯 **Charts** | Candlestick chart with 1H / 4H / 1D / 1W / 1M intervals and OHLC hover tooltip |
| 📚 **Order-book depth** | Live **Bitget** spot order book (refreshed every 5s) to gauge real liquidity before trading |
| 🤖 **AI analysis** | Gemini produces an event-impact score (−10 to +10), primary drivers and an actionable off-hours strategy |
| 💬 **Streaming copilot** | Ask free-form questions about any asset, answered in real time and anchored to the live price |
| 📰 **News sentiment** | Headlines scored Bullish / Bearish / Neutral with an impact value |
| 🧮 **Paper trading ticket** | Buy/Sell with **USD or share sizing** and **1–20x leverage** (see below) |
| 🧾 **Trade journal** | Every order is logged and persisted locally, with CSV export and reset |
| 🔐 **Key vault** | Configure keys via `.env.local` or the in-app settings |
| 🛟 **Graceful fallbacks** | Mock data and mock analysis are clearly labeled when keys or APIs are unavailable |

### 🧮 Paper trading: leverage & USD sizing

Choose how to size the order:

| Mode | You enter | Position size (notional) | Margin debited |
| :--- | :--- | :--- | :--- |
| **Shares** | quantity | `price × quantity` | `notional ÷ leverage` |
| **USD** | USD margin to commit | `usd × leverage` | `usd` |

- **Leverage:** 1–20x slider with 1x / 2x / 5x / 10x / 20x presets.
- **Live order summary:** quantity, notional, leverage, margin required and estimated liquidation move (`100 ÷ leverage` %).
- **Guardrails:** Buy orders are blocked if margin exceeds the paper balance, and zero-size orders are disabled.
- **Journal fields:** timestamp, instrument, direction, price, quantity, notional, leverage, margin, balance before/after and balance change. This is exported as CSV.

> ⚠️ **Scope note:** the account is a simple margin ledger. Open positions, unrealized P&L, funding and forced liquidation are not simulated yet (see [Roadmap](#-roadmap)).

---

## 🧠 What the LLM Does (and Doesn't)

**Model:** Google Gemini 2.5 Flash (`gemini-2.5-flash`) via the `@google/genai` SDK. It is overridable with `GEMINI_MODEL`.

| Role | Where |
| :--- | :--- |
| Sentiment / event analysis | Scores each news headline |
| Trading-signal reasoning | Impact score, drivers and strategy for an asset |
| Conversational interaction | Streaming "Ask anything" copilot |
| Summarization / extraction | Turns news and context into structured JSON for the UI |

**The LLM never places trades or computes prices, balances, margin or leverage.** Those are deterministic code, so the AI can't cause an order-sizing error.

---

## 🔄 Architecture

```
          ┌────────────────────────── Browser (Next.js client) ──────────────────────────┐
          │  Watchlist · Charts · Depth · AI Analysis · Copilot · Trade ticket · Journal │
          └───────────────┬───────────────┬──────────────┬───────────────┬───────────────┘
                          │               │              │               │
                  /api/market-data    /api/ohlcv     /api/orderbook   /api/analyze · /api/news
                          │               │              │               │
                  Finnhub → Yahoo     Yahoo Finance   Bitget Spot    Gemini 2.5 Flash
                   (fallback)                         Market API     (+ Finnhub headlines)
```

## 🏗 Tech Stack

| Layer | Technology |
| :--- | :--- |
| Framework | [Next.js 16](https://nextjs.org/) (App Router) · React · TypeScript |
| AI / LLM | [Google Gemini API](https://ai.google.dev/) (`@google/genai`) |
| Market data | Finnhub (quotes, news), Yahoo Finance (OHLCV and fallback), **Bitget public spot Market API** (order book) |
| UI | Recharts, Lucide React, custom SVG candlestick chart |
| Styling | Vanilla CSS design system |

---

## 🚀 Quick Start

### Prerequisites
- Node.js **v20+**
- `npm`, `pnpm` or `yarn`
- A free [Gemini API key](https://aistudio.google.com/)

### Install & run

```bash
git clone https://github.com/<your-username>/off-hours-ai-trading-desk.git
cd off-hours-ai-trading-desk
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment variables

Create `.env.local` in the project root:

```env
# ── Google Gemini (AI analysis, copilot, sentiment) ─────────────────────────
GEMINI_API_KEY=your_gemini_api_key
# GEMINI_MODEL=gemini-2.5-flash          # optional override

# ── Market data (optional – falls back to Yahoo Finance / mock data) ────────
# FINNHUB_API_KEY=your_finnhub_key

# ── Bitget order book (optional – falls back to mock depth) ─────────────────
# BITGET_API_KEY=your_bitget_key
# BITGET_SECRET_KEY=your_bitget_secret
# BITGET_PASSPHRASE=your_bitget_passphrase
```

> You can also paste your Gemini key into the in-app **Settings → API key vault**. It is stored in `localStorage` and sent to the server per request.
> 🔒 Never commit `.env.local`. It is already git-ignored.

Every key is optional. The app still runs end-to-end without them and clearly labels mock data and mock AI output.

---

## 🧭 Walkthrough: A Research Task, End to End

1. **Scan.** Pick `NVDA`. Check live price vs. last close in the spread panel, plus volatility and market pulse.
2. **Check liquidity.** Open the **Depth** tab to read the Bitget order book.
3. **Understand the event.** Open **AI Analysis** for the impact score, drivers and strategy, then skim the sentiment-tagged news.
4. **Ask.** Use **Ask anything** (for example, *"How will this weekend affect NVDA?"*).
5. **Act.** Click **Execute paper trade**, choose **USD**, enter `$1,000`, set **5x** leverage. The ticket shows a $5,000 position, the share count, margin and the liquidation distance.
6. **Review.** Open the **Trade Log** tab and **export CSV** for the audit trail.

---

## 🛠 API Routes

| Route | Method | Purpose |
| :--- | :--- | :--- |
| `/api/market-data?ticker=` | GET | Live quote with in-memory caching (Finnhub → Yahoo fallback) |
| `/api/ohlcv?ticker=&interval=` | GET | Historical candles (`1H`, `4H`, `1D`, `1W`, `1M`) |
| `/api/orderbook?ticker=` | GET | Bitget spot order-book depth |
| `/api/news?ticker=` | GET | Company headlines with Gemini sentiment scoring |
| `/api/analyze` | POST | Structured impact score, drivers and strategy |
| `/api/analyze?ticker=&query=` | GET | Streaming copilot response |

---

## 📊 Validation Status

This is a decision-support tool, not an autonomous strategy, so there is **no backtested P&L or Sharpe to report**. The validation plan is:

- **Task test:** ~10 retail traders complete "analyze → size → place a paper order". The metrics are completion rate and time-to-order (*target: < 60s*).
- **Signal check:** compare the sign of the AI impact score with the realized move from the last close to the next US open over ≥ 8 weekends.
- **Usage metrics (targets):** activation, paper trades per user per week, 7-day retention, and the share of orders blocked by the balance check.

Figures will be published here once measured.

---

## 🗺 Roadmap

- [ ] Position tracking with unrealized P&L, funding and liquidation simulation
- [ ] Out-of-sample backtest of AI impact scores vs. next-open gaps
- [ ] Live order execution via Bitget trading APIs (behind explicit confirmation)
- [ ] Weekend gap and news alerts
- [ ] Server-side persistence and authentication

---

## ⚠️ Disclaimer

For research and educational purposes only. All trades are **simulated**; no real capital is at risk. AI output is not financial advice.

## 📄 License

Distributed under the MIT License.

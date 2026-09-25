# ⚡ Off-Hours AI Trading Desk

> **24/7 Tokenized Market Intelligence & Institutional Copilot powered by Google Gemini AI and Next.js 16.**

[![Next.js](https://img.shields.io/badge/Next.js-16.3-black?style=flat-square&logo=next.js)](https://nextjs.org/)
[![Google Gemini API](https://img.shields.io/badge/Google_Gemini-2.5--Flash-4285F4?style=flat-square&logo=google)](https://ai.google.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Vercel](https://img.shields.io/badge/Deployment-Vercel-000000?style=flat-square&logo=vercel)](https://vercel.com/)

---

## 🌟 Key Features

- 📈 **24/7 Tokenized US Equity Universe**: Real-time price tracking, volatility metrics, and spread analysis for top tokenized stocks (`AAPL`, `NVDA`, `TSLA`, `SPY`, `COIN`, `MSFT`, `AMZN`, `GOOGL`, `META`, `BRK`).
- 🤖 **Google Gemini AI Intelligence Layer**: Powered by the official `@google/genai` SDK (`gemini-2.5-flash`).
  - **Quantitative Risk Analysis**: Event impact scores (-10 to +10), primary market drivers, and actionable weekend trading strategies.
  - **Streaming Copilot**: Real-time streaming response engine for instant Q&A on market conditions and price action.
  - **AI News Sentiment Scoring**: Automated sentiment categorization (Bullish / Bearish / Neutral) on breaking financial headlines.
- 📊 **Spread & Volatility Analytics**: Live tracking of weekend gap risk, fair value price convergence, on-chain liquidity depth, and market pulse metrics.
- ⚡ **Simulated Paper Trading**: Interactive paper trading terminal to simulate buy/sell execution without capital risk.
- 🔐 **API Key Vault**: Dual-mode key management—configure via `.env.local` or directly through the UI Key Vault.

---

## 🏗 Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Framework** | [Next.js 16](https://nextjs.org/) (App Router, Server Actions, Turbopack) |
| **Language** | [TypeScript](https://www.typescriptlang.org/) |
| **AI / LLM** | [Google Gemini API](https://ai.google.dev/) (`@google/genai` SDK) |
| **Market Data** | Yahoo Finance 2 & Finnhub API |
| **UI Components** | Lucide React, Recharts, Base UI |
| **Styling** | Vanilla CSS Design System with Tailwind Utilities |

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js**: `v20.0.0` or higher
- **Package Manager**: `npm`, `pnpm`, or `yarn`
- **Google Gemini API Key**: Obtain a free key from [Google AI Studio](https://aistudio.google.com/)

### 2. Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/YOUR_USERNAME/off-hours-ai-trading-desk.git
cd off-hours-ai-trading-desk
npm install
```

### 3. Environment Setup

Create a `.env.local` file in the root directory:

```env
# ── Google Gemini AI ──────────────────────────────────────────────────────────
# Google AI Studio Gemini API Key – https://aistudio.google.com/
GEMINI_API_KEY=your_gemini_api_key_here

# Optional: Gemini model override (defaults to gemini-2.5-flash)
GEMINI_MODEL=gemini-2.5-flash

# ── Market Data (Optional) ──────────────────────────────────────────────────
# Finnhub free tier key – https://finnhub.io (falls back to Yahoo Finance)
# FINNHUB_API_KEY=your_finnhub_api_key
```

### 4. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🛠 API Routes Overview

- `POST /api/analyze` - Generates quantitative impact scores, primary drivers, and actionable strategies via Gemini AI.
- `GET /api/analyze?ticker=...&query=...` - Returns a Server-Sent text stream for the live Market Copilot chat.
- `GET /api/news?ticker=...` - Fetches company headlines tagged with Gemini AI sentiment scores.
- `GET /api/market-data?ticker=...` - Retrieves live on-chain/after-hours market quotes with in-memory caching.

---

## 🌐 Deploy to Vercel

The easiest way to deploy this project is via [Vercel](https://vercel.com/):

1. Push your code to a GitHub repository.
2. Import your repository into [Vercel](https://vercel.com/new).
3. Add `GEMINI_API_KEY` to the **Environment Variables** section.
4. Click **Deploy**.

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

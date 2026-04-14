# CLAUDE.md — ATLAS // WATCHLIST

Autonomous trading signal system. Ingests TradingView Pine Script alerts and FXSSI order book data, scores them through a multi-layer engine, and presents PROCEED / WATCH / SKIP signals. Signal-only — does **not** execute trades.

**Stack:** Node.js + Express, sql.js, WebSocket, Anthropic Claude API, FXSSI API, Telegram Bot API, Resend.

Full documentation is modularised under `docs/claude/`. Sections below are auto-imported.

## Rules
@docs/claude/rules.md

## Architecture
@docs/claude/architecture.md

## Scorer
@docs/claude/scorer.md

## Deployment
@docs/claude/deployment.md

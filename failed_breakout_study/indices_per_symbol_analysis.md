# Indices per-symbol FADE_FAILURE diagnostic

Per-symbol (SPX500, UK100, J225), per-TF (15m/1h/4h), per-filter (no_filter, VOL_HIGH, VOL_NORMAL, LEVEL_FRESH, TREND_ALIGN, TREND_AGAINST), per-exit (A/B/C/D). Chronological midpoint IS/OOS split.

Note: VOL_HIGH / VOL_NORMAL depend on ATR ratio, not volume — they still fire for UK100 and J225. Volume-based factors (VOL_EXPANSION in raw features) are False on UK100/J225, but are not used as filter candidates here.

Exits:
- **A** — partial-trail SL=2, partial=1.5, trail=0.5, hold=24
- **B** — fixed 1:1 R:R SL=2, TP=2*ATR
- **C** — chandelier SL=2 init, trail 2*ATR below 10-bar high
- **D** — scaled 3-leg 1/3 at 1R, 1/3 at 2R, 1/3 trail 1*ATR, hold=48

## Best combo per symbol (expectancy × √trades, min 30 OOS trades)

**Bottom line: no symbol has any filter × exit × TF combo that produces ≥30 OOS trades.** FADE_FAILURE is too sparse on single indices to support a per-symbol edge test at the requested sample floor. The closest pools are SPX500/1h (36 total signals → ~18 OOS) and UK100/1h (53 total → ~27 OOS). This is the key diagnostic.

| symbol | TF | filter | exit | total sigs | OOS n | OOS mean R | OOS WR | OOS total R | rank score |
|--------|----|--------|:----:|-----------:|------:|-----------:|-------:|------------:|-----------:|
| SPX500 | — | — | — | — | — | — | — | — | **no combo met 30 OOS** |
| UK100 | — | — | — | — | — | — | — | — | **no combo met 30 OOS** |
| J225 | — | — | — | — | — | — | — | — | **no combo met 30 OOS** |

## Best candidate per symbol IGNORING 30-trade minimum (diagnostic only)

Ranked by `oos_mean × √oos_n`. Do not act on these — sample sizes below 30 are not reliable edge signals.

| symbol | TF | filter | exit | total sigs | OOS n | OOS mean R | OOS WR | OOS total R | rank score |
|--------|----|--------|:----:|-----------:|------:|-----------:|-------:|------------:|-----------:|
| SPX500 | 15m | VOL_NORMAL | C | 21 | 6 | +1.860 | 50.0% | +11.16 | +4.556 |
| UK100 | 4h | no_filter | B | 25 | 13 | +0.538 | 76.9% | +7.00 | +1.941 |
| J225 | 15m | TREND_AGAINST | C | 6 | 3 | +1.520 | 66.7% | +4.56 | +2.634 |

## SPX500

### 15m — 21 total signals

| filter | exit | IS n | OOS n | OOS mean R | OOS WR | OOS total R |
|--------|:----:|-----:|------:|-----------:|-------:|------------:|
| no_filter | A | 10 | 11 | +0.576 | 72.7% | +6.34 |
| no_filter | B | 10 | 11 | +0.455 | 72.7% | +5.00 |
| no_filter | C | 10 | 11 | +1.138 | 45.5% | +12.52 |
| no_filter | D | 10 | 11 | +0.645 | 72.7% | +7.10 |
| VOL_HIGH | A | 6 | 4 | -0.584 | 25.0% | -2.34 |
| VOL_HIGH | B | 6 | 4 | -0.500 | 25.0% | -2.00 |
| VOL_HIGH | C | 6 | 4 | -0.194 | 25.0% | -0.78 |
| VOL_HIGH | D | 6 | 4 | -0.554 | 25.0% | -2.22 |
| VOL_NORMAL | A | 1 | 6 | +1.326 | 100.0% | +7.96 |
| VOL_NORMAL | B | 1 | 6 | +1.000 | 100.0% | +6.00 |
| VOL_NORMAL | C | 1 | 6 | +1.860 | 50.0% | +11.16 |
| VOL_NORMAL | D | 1 | 6 | +1.415 | 100.0% | +8.49 |
| LEVEL_FRESH | A | 9 | 6 | -0.136 | 50.0% | -0.82 |
| LEVEL_FRESH | B | 9 | 6 | +0.000 | 50.0% | +0.00 |
| LEVEL_FRESH | C | 9 | 6 | -0.429 | 0.0% | -2.58 |
| LEVEL_FRESH | D | 9 | 6 | +0.014 | 50.0% | +0.08 |
| TREND_ALIGN | A | 5 | 3 | +1.296 | 100.0% | +3.89 |
| TREND_ALIGN | B | 5 | 3 | +1.000 | 100.0% | +3.00 |
| TREND_ALIGN | C | 5 | 3 | +1.691 | 66.7% | +5.07 |
| TREND_ALIGN | D | 5 | 3 | +1.272 | 100.0% | +3.82 |
| TREND_AGAINST | A | 5 | 8 | +0.306 | 62.5% | +2.45 |
| TREND_AGAINST | B | 5 | 8 | +0.250 | 62.5% | +2.00 |
| TREND_AGAINST | C | 5 | 8 | +0.931 | 37.5% | +7.45 |
| TREND_AGAINST | D | 5 | 8 | +0.410 | 62.5% | +3.28 |

### 1h — 36 total signals

| filter | exit | IS n | OOS n | OOS mean R | OOS WR | OOS total R |
|--------|:----:|-----:|------:|-----------:|-------:|------------:|
| no_filter | A | 18 | 18 | +0.243 | 66.7% | +4.38 |
| no_filter | B | 18 | 18 | +0.111 | 55.6% | +2.00 |
| no_filter | C | 18 | 18 | +0.141 | 50.0% | +2.53 |
| no_filter | D | 18 | 18 | +0.169 | 55.6% | +3.04 |
| VOL_HIGH | A | 5 | 6 | +0.578 | 83.3% | +3.47 |
| VOL_HIGH | B | 5 | 6 | +0.333 | 66.7% | +2.00 |
| VOL_HIGH | C | 5 | 6 | +0.607 | 66.7% | +3.64 |
| VOL_HIGH | D | 5 | 6 | +0.457 | 66.7% | +2.74 |
| VOL_NORMAL | A | 9 | 11 | -0.006 | 54.5% | -0.07 |
| VOL_NORMAL | B | 9 | 11 | -0.091 | 45.5% | -1.00 |
| VOL_NORMAL | C | 9 | 11 | -0.143 | 36.4% | -1.57 |
| VOL_NORMAL | D | 9 | 11 | -0.061 | 45.5% | -0.68 |
| LEVEL_FRESH | A | 7 | 9 | +0.050 | 55.6% | +0.45 |
| LEVEL_FRESH | B | 7 | 9 | +0.111 | 55.6% | +1.00 |
| LEVEL_FRESH | C | 7 | 9 | -0.011 | 55.6% | -0.10 |
| LEVEL_FRESH | D | 7 | 9 | +0.031 | 55.6% | +0.28 |
| TREND_ALIGN | A | 2 | 1 | +1.003 | 100.0% | +1.00 |
| TREND_ALIGN | B | 2 | 1 | +1.000 | 100.0% | +1.00 |
| TREND_ALIGN | C | 2 | 1 | +2.612 | 100.0% | +2.61 |
| TREND_ALIGN | D | 2 | 1 | +1.527 | 100.0% | +1.53 |
| TREND_AGAINST | A | 16 | 17 | +0.199 | 64.7% | +3.38 |
| TREND_AGAINST | B | 16 | 17 | +0.059 | 52.9% | +1.00 |
| TREND_AGAINST | C | 16 | 17 | -0.005 | 47.1% | -0.08 |
| TREND_AGAINST | D | 16 | 17 | +0.089 | 52.9% | +1.51 |

### 4h — 5 total signals

| filter | exit | IS n | OOS n | OOS mean R | OOS WR | OOS total R |
|--------|:----:|-----:|------:|-----------:|-------:|------------:|
| no_filter | A | 2 | 3 | +0.718 | 100.0% | +2.16 |
| no_filter | B | 2 | 3 | +1.000 | 100.0% | +3.00 |
| no_filter | C | 2 | 3 | +0.074 | 66.7% | +0.22 |
| no_filter | D | 2 | 3 | +1.137 | 100.0% | +3.41 |
| VOL_HIGH | A | 1 | 3 | +0.718 | 100.0% | +2.16 |
| VOL_HIGH | B | 1 | 3 | +1.000 | 100.0% | +3.00 |
| VOL_HIGH | C | 1 | 3 | +0.074 | 66.7% | +0.22 |
| VOL_HIGH | D | 1 | 3 | +1.137 | 100.0% | +3.41 |
| VOL_NORMAL | A | 0 | 0 | +0.000 | 0.0% | +0.00 |
| VOL_NORMAL | B | 0 | 0 | +0.000 | 0.0% | +0.00 |
| VOL_NORMAL | C | 0 | 0 | +0.000 | 0.0% | +0.00 |
| VOL_NORMAL | D | 0 | 0 | +0.000 | 0.0% | +0.00 |
| LEVEL_FRESH | A | 1 | 2 | +0.715 | 100.0% | +1.43 |
| LEVEL_FRESH | B | 1 | 2 | +1.000 | 100.0% | +2.00 |
| LEVEL_FRESH | C | 1 | 2 | -0.130 | 50.0% | -0.26 |
| LEVEL_FRESH | D | 1 | 2 | +1.212 | 100.0% | +2.42 |
| TREND_ALIGN | A | 0 | 1 | +0.627 | 100.0% | +0.63 |
| TREND_ALIGN | B | 0 | 1 | +1.000 | 100.0% | +1.00 |
| TREND_ALIGN | C | 0 | 1 | -0.365 | 0.0% | -0.36 |
| TREND_ALIGN | D | 0 | 1 | +1.687 | 100.0% | +1.69 |
| TREND_AGAINST | A | 2 | 2 | +0.764 | 100.0% | +1.53 |
| TREND_AGAINST | B | 2 | 2 | +1.000 | 100.0% | +2.00 |
| TREND_AGAINST | C | 2 | 2 | +0.293 | 100.0% | +0.59 |
| TREND_AGAINST | D | 2 | 2 | +0.862 | 100.0% | +1.72 |

## UK100

### 15m — 14 total signals

| filter | exit | IS n | OOS n | OOS mean R | OOS WR | OOS total R |
|--------|:----:|-----:|------:|-----------:|-------:|------------:|
| no_filter | A | 7 | 7 | +0.178 | 57.1% | +1.24 |
| no_filter | B | 7 | 7 | +0.143 | 57.1% | +1.00 |
| no_filter | C | 7 | 7 | -0.210 | 14.3% | -1.47 |
| no_filter | D | 7 | 7 | +0.151 | 57.1% | +1.06 |
| VOL_HIGH | A | 3 | 0 | +0.000 | 0.0% | +0.00 |
| VOL_HIGH | B | 3 | 0 | +0.000 | 0.0% | +0.00 |
| VOL_HIGH | C | 3 | 0 | +0.000 | 0.0% | +0.00 |
| VOL_HIGH | D | 3 | 0 | +0.000 | 0.0% | +0.00 |
| VOL_NORMAL | A | 4 | 5 | +0.223 | 60.0% | +1.12 |
| VOL_NORMAL | B | 4 | 5 | +0.200 | 60.0% | +1.00 |
| VOL_NORMAL | C | 4 | 5 | -0.270 | 0.0% | -1.35 |
| VOL_NORMAL | D | 4 | 5 | +0.178 | 60.0% | +0.89 |
| LEVEL_FRESH | A | 3 | 5 | +0.107 | 60.0% | +0.54 |
| LEVEL_FRESH | B | 3 | 5 | -0.200 | 40.0% | -1.00 |
| LEVEL_FRESH | C | 3 | 5 | -0.178 | 20.0% | -0.89 |
| LEVEL_FRESH | D | 3 | 5 | -0.137 | 40.0% | -0.68 |
| TREND_ALIGN | A | 0 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_ALIGN | B | 0 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_ALIGN | C | 0 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_ALIGN | D | 0 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_AGAINST | A | 7 | 7 | +0.178 | 57.1% | +1.24 |
| TREND_AGAINST | B | 7 | 7 | +0.143 | 57.1% | +1.00 |
| TREND_AGAINST | C | 7 | 7 | -0.210 | 14.3% | -1.47 |
| TREND_AGAINST | D | 7 | 7 | +0.151 | 57.1% | +1.06 |

### 1h — 53 total signals

| filter | exit | IS n | OOS n | OOS mean R | OOS WR | OOS total R |
|--------|:----:|-----:|------:|-----------:|-------:|------------:|
| no_filter | A | 26 | 27 | +0.250 | 74.1% | +6.75 |
| no_filter | B | 26 | 27 | +0.037 | 51.9% | +1.00 |
| no_filter | C | 26 | 27 | -0.001 | 48.1% | -0.03 |
| no_filter | D | 26 | 27 | +0.005 | 51.9% | +0.15 |
| VOL_HIGH | A | 1 | 4 | +0.726 | 100.0% | +2.90 |
| VOL_HIGH | B | 1 | 4 | +0.500 | 75.0% | +2.00 |
| VOL_HIGH | C | 1 | 4 | +0.320 | 50.0% | +1.28 |
| VOL_HIGH | D | 1 | 4 | +0.582 | 75.0% | +2.33 |
| VOL_NORMAL | A | 20 | 21 | +0.196 | 71.4% | +4.13 |
| VOL_NORMAL | B | 20 | 21 | -0.048 | 47.6% | -1.00 |
| VOL_NORMAL | C | 20 | 21 | -0.058 | 47.6% | -1.23 |
| VOL_NORMAL | D | 20 | 21 | -0.094 | 47.6% | -1.98 |
| LEVEL_FRESH | A | 16 | 20 | +0.175 | 70.0% | +3.50 |
| LEVEL_FRESH | B | 16 | 20 | -0.100 | 45.0% | -2.00 |
| LEVEL_FRESH | C | 16 | 20 | -0.116 | 40.0% | -2.33 |
| LEVEL_FRESH | D | 16 | 20 | -0.125 | 45.0% | -2.50 |
| TREND_ALIGN | A | 4 | 3 | +0.168 | 66.7% | +0.50 |
| TREND_ALIGN | B | 4 | 3 | -0.333 | 33.3% | -1.00 |
| TREND_ALIGN | C | 4 | 3 | -0.418 | 33.3% | -1.25 |
| TREND_ALIGN | D | 4 | 3 | -0.395 | 33.3% | -1.18 |
| TREND_AGAINST | A | 22 | 24 | +0.260 | 75.0% | +6.25 |
| TREND_AGAINST | B | 22 | 24 | +0.083 | 54.2% | +2.00 |
| TREND_AGAINST | C | 22 | 24 | +0.051 | 50.0% | +1.23 |
| TREND_AGAINST | D | 22 | 24 | +0.055 | 54.2% | +1.33 |

### 4h — 25 total signals

| filter | exit | IS n | OOS n | OOS mean R | OOS WR | OOS total R |
|--------|:----:|-----:|------:|-----------:|-------:|------------:|
| no_filter | A | 12 | 13 | +0.275 | 69.2% | +3.58 |
| no_filter | B | 12 | 13 | +0.538 | 76.9% | +7.00 |
| no_filter | C | 12 | 13 | -0.179 | 30.8% | -2.32 |
| no_filter | D | 12 | 13 | +0.456 | 76.9% | +5.93 |
| VOL_HIGH | A | 2 | 2 | +0.027 | 50.0% | +0.05 |
| VOL_HIGH | B | 2 | 2 | +0.000 | 50.0% | +0.00 |
| VOL_HIGH | C | 2 | 2 | -0.104 | 50.0% | -0.21 |
| VOL_HIGH | D | 2 | 2 | +0.036 | 50.0% | +0.07 |
| VOL_NORMAL | A | 10 | 6 | +0.476 | 83.3% | +2.85 |
| VOL_NORMAL | B | 10 | 6 | +0.667 | 83.3% | +4.00 |
| VOL_NORMAL | C | 10 | 6 | +0.081 | 50.0% | +0.49 |
| VOL_NORMAL | D | 10 | 6 | +0.604 | 83.3% | +3.62 |
| LEVEL_FRESH | A | 4 | 10 | +0.068 | 60.0% | +0.68 |
| LEVEL_FRESH | B | 4 | 10 | +0.400 | 70.0% | +4.00 |
| LEVEL_FRESH | C | 4 | 10 | -0.186 | 30.0% | -1.86 |
| LEVEL_FRESH | D | 4 | 10 | +0.306 | 70.0% | +3.06 |
| TREND_ALIGN | A | 0 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_ALIGN | B | 0 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_ALIGN | C | 0 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_ALIGN | D | 0 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_AGAINST | A | 12 | 13 | +0.275 | 69.2% | +3.58 |
| TREND_AGAINST | B | 12 | 13 | +0.538 | 76.9% | +7.00 |
| TREND_AGAINST | C | 12 | 13 | -0.179 | 30.8% | -2.32 |
| TREND_AGAINST | D | 12 | 13 | +0.456 | 76.9% | +5.93 |

## J225

### 15m — 6 total signals

| filter | exit | IS n | OOS n | OOS mean R | OOS WR | OOS total R |
|--------|:----:|-----:|------:|-----------:|-------:|------------:|
| no_filter | A | 3 | 3 | +0.238 | 66.7% | +0.71 |
| no_filter | B | 3 | 3 | +0.333 | 66.7% | +1.00 |
| no_filter | C | 3 | 3 | +1.520 | 66.7% | +4.56 |
| no_filter | D | 3 | 3 | +0.207 | 66.7% | +0.62 |
| VOL_HIGH | A | 1 | 0 | +0.000 | 0.0% | +0.00 |
| VOL_HIGH | B | 1 | 0 | +0.000 | 0.0% | +0.00 |
| VOL_HIGH | C | 1 | 0 | +0.000 | 0.0% | +0.00 |
| VOL_HIGH | D | 1 | 0 | +0.000 | 0.0% | +0.00 |
| VOL_NORMAL | A | 0 | 1 | -1.000 | 0.0% | -1.00 |
| VOL_NORMAL | B | 0 | 1 | -1.000 | 0.0% | -1.00 |
| VOL_NORMAL | C | 0 | 1 | -0.681 | 0.0% | -0.68 |
| VOL_NORMAL | D | 0 | 1 | -1.000 | 0.0% | -1.00 |
| LEVEL_FRESH | A | 1 | 3 | +0.238 | 66.7% | +0.71 |
| LEVEL_FRESH | B | 1 | 3 | +0.333 | 66.7% | +1.00 |
| LEVEL_FRESH | C | 1 | 3 | +1.520 | 66.7% | +4.56 |
| LEVEL_FRESH | D | 1 | 3 | +0.207 | 66.7% | +0.62 |
| TREND_ALIGN | A | 1 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_ALIGN | B | 1 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_ALIGN | C | 1 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_ALIGN | D | 1 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_AGAINST | A | 2 | 3 | +0.238 | 66.7% | +0.71 |
| TREND_AGAINST | B | 2 | 3 | +0.333 | 66.7% | +1.00 |
| TREND_AGAINST | C | 2 | 3 | +1.520 | 66.7% | +4.56 |
| TREND_AGAINST | D | 2 | 3 | +0.207 | 66.7% | +0.62 |

### 1h — 32 total signals

| filter | exit | IS n | OOS n | OOS mean R | OOS WR | OOS total R |
|--------|:----:|-----:|------:|-----------:|-------:|------------:|
| no_filter | A | 16 | 16 | -0.182 | 43.8% | -2.92 |
| no_filter | B | 16 | 16 | -0.125 | 43.8% | -2.00 |
| no_filter | C | 16 | 16 | -0.320 | 31.2% | -5.12 |
| no_filter | D | 16 | 16 | -0.163 | 43.8% | -2.60 |
| VOL_HIGH | A | 3 | 1 | -1.000 | 0.0% | -1.00 |
| VOL_HIGH | B | 3 | 1 | -1.000 | 0.0% | -1.00 |
| VOL_HIGH | C | 3 | 1 | -0.930 | 0.0% | -0.93 |
| VOL_HIGH | D | 3 | 1 | -1.000 | 0.0% | -1.00 |
| VOL_NORMAL | A | 11 | 14 | -0.184 | 42.9% | -2.57 |
| VOL_NORMAL | B | 11 | 14 | -0.143 | 42.9% | -2.00 |
| VOL_NORMAL | C | 11 | 14 | -0.329 | 28.6% | -4.60 |
| VOL_NORMAL | D | 11 | 14 | -0.182 | 42.9% | -2.54 |
| LEVEL_FRESH | A | 13 | 9 | -0.593 | 22.2% | -5.34 |
| LEVEL_FRESH | B | 13 | 9 | -0.556 | 22.2% | -5.00 |
| LEVEL_FRESH | C | 13 | 9 | -0.419 | 22.2% | -3.77 |
| LEVEL_FRESH | D | 13 | 9 | -0.560 | 22.2% | -5.04 |
| TREND_ALIGN | A | 2 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_ALIGN | B | 2 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_ALIGN | C | 2 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_ALIGN | D | 2 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_AGAINST | A | 14 | 16 | -0.182 | 43.8% | -2.92 |
| TREND_AGAINST | B | 14 | 16 | -0.125 | 43.8% | -2.00 |
| TREND_AGAINST | C | 14 | 16 | -0.320 | 31.2% | -5.12 |
| TREND_AGAINST | D | 14 | 16 | -0.163 | 43.8% | -2.60 |

### 4h — 5 total signals

| filter | exit | IS n | OOS n | OOS mean R | OOS WR | OOS total R |
|--------|:----:|-----:|------:|-----------:|-------:|------------:|
| no_filter | A | 2 | 3 | +0.801 | 100.0% | +2.40 |
| no_filter | B | 2 | 3 | +1.000 | 100.0% | +3.00 |
| no_filter | C | 2 | 3 | +0.056 | 66.7% | +0.17 |
| no_filter | D | 2 | 3 | +0.799 | 100.0% | +2.40 |
| VOL_HIGH | A | 0 | 0 | +0.000 | 0.0% | +0.00 |
| VOL_HIGH | B | 0 | 0 | +0.000 | 0.0% | +0.00 |
| VOL_HIGH | C | 0 | 0 | +0.000 | 0.0% | +0.00 |
| VOL_HIGH | D | 0 | 0 | +0.000 | 0.0% | +0.00 |
| VOL_NORMAL | A | 2 | 2 | +0.720 | 100.0% | +1.44 |
| VOL_NORMAL | B | 2 | 2 | +1.000 | 100.0% | +2.00 |
| VOL_NORMAL | C | 2 | 2 | -0.131 | 50.0% | -0.26 |
| VOL_NORMAL | D | 2 | 2 | +0.722 | 100.0% | +1.44 |
| LEVEL_FRESH | A | 2 | 3 | +0.801 | 100.0% | +2.40 |
| LEVEL_FRESH | B | 2 | 3 | +1.000 | 100.0% | +3.00 |
| LEVEL_FRESH | C | 2 | 3 | +0.056 | 66.7% | +0.17 |
| LEVEL_FRESH | D | 2 | 3 | +0.799 | 100.0% | +2.40 |
| TREND_ALIGN | A | 0 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_ALIGN | B | 0 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_ALIGN | C | 0 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_ALIGN | D | 0 | 0 | +0.000 | 0.0% | +0.00 |
| TREND_AGAINST | A | 2 | 3 | +0.801 | 100.0% | +2.40 |
| TREND_AGAINST | B | 2 | 3 | +1.000 | 100.0% | +3.00 |
| TREND_AGAINST | C | 2 | 3 | +0.056 | 66.7% | +0.17 |
| TREND_AGAINST | D | 2 | 3 | +0.799 | 100.0% | +2.40 |


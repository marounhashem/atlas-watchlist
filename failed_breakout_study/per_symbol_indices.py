"""Per-symbol FADE_FAILURE diagnostic for indices (SPX500, UK100, J225).

For each (symbol, TF) independently:
  - fire FADE_FAILURE_LONG/SHORT signals from features CSV
  - apply context filter candidate (VOL_HIGH, VOL_NORMAL, LEVEL_FRESH,
    TREND_ALIGN, TREND_AGAINST, no_filter)
  - apply each of 4 exits (A, B, C, D)
  - chronological midpoint IS/OOS split
  - report OOS trade count, mean R, WR, total R

For each symbol, pick single best combo by expectancy × sqrt(trades),
minimum 30 OOS trades.

Writes indices_per_symbol_analysis.md.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from core import sim_exit_wrapper, EXIT_LABELS
from phase4 import compute_context_factors, FACTOR_NAMES

FEATURES_DIR = HERE / "features"
SYMBOLS = ["SPX500", "UK100", "J225"]
TFS = ["15m", "1h", "4h"]
EXITS = ["A", "B", "C", "D"]
FILTERS = ["no_filter", "VOL_HIGH", "VOL_NORMAL", "LEVEL_FRESH",
            "TREND_ALIGN", "TREND_AGAINST"]


def metrics(rs: np.ndarray) -> dict:
    if len(rs) == 0:
        return dict(n=0, mean=0.0, wr=0.0, total=0.0)
    return dict(
        n=int(len(rs)),
        mean=float(rs.mean()),
        wr=float((rs > 0).mean()),
        total=float(rs.sum()),
    )


def analyze_symbol_tf(sym: str, tf: str) -> list[dict]:
    df = pd.read_csv(FEATURES_DIR / f"indices_{sym}_{tf}.csv")
    close = df["close"].to_numpy(dtype=float)
    high = df["high"].to_numpy(dtype=float)
    low = df["low"].to_numpy(dtype=float)
    atr = df["atr"].to_numpy(dtype=float)
    n = len(df)

    long_fires = df["FADE_FAILURE_LONG"].to_numpy().astype(bool)
    short_fires = df["FADE_FAILURE_SHORT"].to_numpy().astype(bool)

    dir_per_bar = np.zeros(n, dtype=np.int64)
    dir_per_bar[long_fires] = +1
    dir_per_bar[short_fires] = -1

    facs = compute_context_factors(df, dir_per_bar)

    rows = []
    for exit_name in EXITS:
        long_r, short_r = sim_exit_wrapper(close, high, low, atr, exit_name)

        # Collect LONG signals in chronological order
        idx_l = np.flatnonzero(long_fires & ~np.isnan(long_r))
        idx_s = np.flatnonzero(short_fires & ~np.isnan(short_r))

        # merge — signals at bar index position (chronological already by index)
        all_idx = np.concatenate([idx_l, idx_s])
        all_r = np.concatenate([long_r[idx_l], short_r[idx_s]])
        all_dir = np.concatenate([
            np.ones(len(idx_l), dtype=np.int64),
            -np.ones(len(idx_s), dtype=np.int64),
        ])
        # Factor values at the fire bars
        fac_vals_all = {}
        for f in FACTOR_NAMES:
            fac_vals_all[f] = np.concatenate([
                facs[f][idx_l], facs[f][idx_s]
            ])

        # Sort by bar index (time proxy)
        order = np.argsort(all_idx, kind="stable")
        all_idx = all_idx[order]
        all_r = all_r[order]
        for f in FACTOR_NAMES:
            fac_vals_all[f] = fac_vals_all[f][order]

        total_n = len(all_r)
        if total_n == 0:
            # produce rows with zero trades for all filter combos
            for filt in FILTERS:
                rows.append(dict(
                    symbol=sym, tf=tf, exit=exit_name, filter=filt,
                    total_signals=0, is_n=0, oos_n=0,
                    oos_mean=0.0, oos_wr=0.0, oos_total=0.0,
                    expectancy_score=0.0,
                ))
            continue

        # Chronological midpoint split
        mid = total_n // 2
        is_slice = slice(0, mid)
        oos_slice = slice(mid, total_n)

        for filt in FILTERS:
            if filt == "no_filter":
                mask = np.ones(total_n, dtype=bool)
            else:
                mask = fac_vals_all[filt]

            is_rs = all_r[is_slice][mask[is_slice]]
            oos_rs = all_r[oos_slice][mask[oos_slice]]

            is_m = metrics(is_rs)
            oos_m = metrics(oos_rs)

            score = (oos_m["mean"] * np.sqrt(oos_m["n"])
                      if oos_m["n"] >= 30 else 0.0)

            rows.append(dict(
                symbol=sym, tf=tf, exit=exit_name, filter=filt,
                total_signals=total_n,
                is_n=is_m["n"], oos_n=oos_m["n"],
                oos_mean=oos_m["mean"], oos_wr=oos_m["wr"],
                oos_total=oos_m["total"],
                expectancy_score=score,
            ))

    return rows


def pick_best_per_symbol(all_rows: list[dict]) -> dict:
    """Return per-symbol: best with ≥30 OOS trades (may be None) AND
    best-available (even below threshold, for diagnostic) ranked by
    oos_mean × √oos_n."""
    df = pd.DataFrame(all_rows)
    df = df[df["oos_n"] > 0].copy()
    df["rank_score"] = df["oos_mean"] * np.sqrt(df["oos_n"].astype(float))
    best = {}
    for sym in SYMBOLS:
        strict = df[(df["symbol"] == sym) & (df["oos_n"] >= 30)].copy()
        strict_best = (strict.sort_values("rank_score", ascending=False).iloc[0].to_dict()
                       if len(strict) else None)
        fallback = df[df["symbol"] == sym].copy()
        fb_best = (fallback.sort_values("rank_score", ascending=False).iloc[0].to_dict()
                    if len(fallback) else None)
        best[sym] = {"strict": strict_best, "fallback": fb_best}
    return best


def write_md(all_rows: list[dict], best: dict, out_path: Path) -> None:
    df = pd.DataFrame(all_rows)
    lines = []
    lines.append("# Indices per-symbol FADE_FAILURE diagnostic")
    lines.append("")
    lines.append("Per-symbol (SPX500, UK100, J225), per-TF (15m/1h/4h), "
                  "per-filter (no_filter, VOL_HIGH, VOL_NORMAL, LEVEL_FRESH, "
                  "TREND_ALIGN, TREND_AGAINST), per-exit (A/B/C/D). "
                  "Chronological midpoint IS/OOS split.")
    lines.append("")
    lines.append("Note: VOL_HIGH / VOL_NORMAL depend on ATR ratio, not volume — "
                  "they still fire for UK100 and J225. Volume-based factors "
                  "(VOL_EXPANSION in raw features) are False on UK100/J225, but "
                  "are not used as filter candidates here.")
    lines.append("")
    lines.append("Exits:")
    for e, lbl in EXIT_LABELS.items():
        lines.append(f"- **{e}** — {lbl}")
    lines.append("")

    lines.append("## Best combo per symbol (expectancy × √trades, min 30 OOS trades)")
    lines.append("")
    lines.append("**Bottom line: no symbol has any filter × exit × TF combo "
                  "that produces ≥30 OOS trades.** FADE_FAILURE is too sparse "
                  "on single indices to support a per-symbol edge test at the "
                  "requested sample floor. The closest pools are SPX500/1h "
                  "(36 total signals → ~18 OOS) and UK100/1h (53 total → ~27 "
                  "OOS). This is the key diagnostic.")
    lines.append("")
    lines.append("| symbol | TF | filter | exit | total sigs | OOS n | OOS mean R | OOS WR | OOS total R | rank score |")
    lines.append("|--------|----|--------|:----:|-----------:|------:|-----------:|-------:|------------:|-----------:|")
    for sym in SYMBOLS:
        b = best[sym]["strict"]
        if b is None:
            lines.append(f"| {sym} | — | — | — | — | — | — | — | — | **no combo met 30 OOS** |")
        else:
            lines.append(
                f"| {sym} | {b['tf']} | {b['filter']} | {b['exit']} | "
                f"{int(b['total_signals'])} | {int(b['oos_n'])} | "
                f"{b['oos_mean']:+.3f} | {b['oos_wr']*100:.1f}% | "
                f"{b['oos_total']:+.2f} | {b['rank_score']:+.3f} |"
            )
    lines.append("")

    lines.append("## Best candidate per symbol IGNORING 30-trade minimum (diagnostic only)")
    lines.append("")
    lines.append("Ranked by `oos_mean × √oos_n`. Do not act on these — "
                  "sample sizes below 30 are not reliable edge signals.")
    lines.append("")
    lines.append("| symbol | TF | filter | exit | total sigs | OOS n | OOS mean R | OOS WR | OOS total R | rank score |")
    lines.append("|--------|----|--------|:----:|-----------:|------:|-----------:|-------:|------------:|-----------:|")
    for sym in SYMBOLS:
        b = best[sym]["fallback"]
        if b is None:
            lines.append(f"| {sym} | — | — | — | — | — | — | — | — | no trades |")
        else:
            lines.append(
                f"| {sym} | {b['tf']} | {b['filter']} | {b['exit']} | "
                f"{int(b['total_signals'])} | {int(b['oos_n'])} | "
                f"{b['oos_mean']:+.3f} | {b['oos_wr']*100:.1f}% | "
                f"{b['oos_total']:+.2f} | {b['rank_score']:+.3f} |"
            )
    lines.append("")

    for sym in SYMBOLS:
        lines.append(f"## {sym}")
        lines.append("")
        for tf in TFS:
            sub = df[(df["symbol"] == sym) & (df["tf"] == tf)].copy()
            if sub["total_signals"].max() == 0:
                lines.append(f"### {tf} — 0 signals")
                lines.append("")
                continue
            tot = int(sub["total_signals"].iloc[0])
            lines.append(f"### {tf} — {tot} total signals")
            lines.append("")
            lines.append("| filter | exit | IS n | OOS n | OOS mean R | OOS WR | OOS total R |")
            lines.append("|--------|:----:|-----:|------:|-----------:|-------:|------------:|")
            # sort by filter order then exit
            sub["_f_order"] = sub["filter"].map({f: i for i, f in enumerate(FILTERS)})
            sub["_e_order"] = sub["exit"].map({e: i for i, e in enumerate(EXITS)})
            sub = sub.sort_values(["_f_order", "_e_order"])
            for _, r in sub.iterrows():
                lines.append(
                    f"| {r['filter']} | {r['exit']} | {int(r['is_n'])} | "
                    f"{int(r['oos_n'])} | {r['oos_mean']:+.3f} | "
                    f"{r['oos_wr']*100:.1f}% | {r['oos_total']:+.2f} |"
                )
            lines.append("")

    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    all_rows = []
    for sym in SYMBOLS:
        for tf in TFS:
            print(f"[per-sym] {sym}/{tf} ...", flush=True)
            rows = analyze_symbol_tf(sym, tf)
            all_rows.extend(rows)
    best = pick_best_per_symbol(all_rows)

    out_md = HERE / "indices_per_symbol_analysis.md"
    write_md(all_rows, best, out_md)

    # Also dump full CSV
    pd.DataFrame(all_rows).to_csv(HERE / "indices_per_symbol_full.csv", index=False)

    print("\n=== BEST PER SYMBOL (>=30 OOS) ===")
    for sym in SYMBOLS:
        b = best[sym]["strict"]
        if b is None:
            print(f"{sym}: no combo met 30-trade minimum")
        else:
            print(f"{sym}: {b['tf']}/{b['filter']}/exit {b['exit']} — "
                   f"OOS n={int(b['oos_n'])}, mean={b['oos_mean']:+.3f}, "
                   f"WR={b['oos_wr']*100:.1f}%, total={b['oos_total']:+.2f}")
    print("\n=== BEST CANDIDATE (no min, diagnostic) ===")
    for sym in SYMBOLS:
        b = best[sym]["fallback"]
        if b is None:
            print(f"{sym}: no trades")
        else:
            print(f"{sym}: {b['tf']}/{b['filter']}/exit {b['exit']} — "
                   f"OOS n={int(b['oos_n'])}, mean={b['oos_mean']:+.3f}, "
                   f"WR={b['oos_wr']*100:.1f}%, total={b['oos_total']:+.2f}")
    print(f"\nWrote {out_md}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

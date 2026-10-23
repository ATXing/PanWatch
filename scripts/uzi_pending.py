#!/usr/bin/env python
"""列出「UZI 磁盘上有产出、但 PanWatch 库里还没有/比较旧」的股票。

只读，不写库、不跑 UZI。用来在 agent 本地跑完 UZI 后判断要不要提醒同步。

用法:
  python scripts/uzi_pending.py            # 人读表格
  python scripts/uzi_pending.py --json     # 机器读
  python scripts/uzi_pending.py 600887.SH 02331.HK   # 只看这几只

判定:
  pending   磁盘上的最新报告目录/日期比库里新（或库里压根没有这只）
  synced    库里已经是最新
  no_report 只有 .cache 抓取结果、没有 reports/ 目录（UZI 可能没跑完）
真正同步用: python scripts/sync_uzi_to_panwatch.py [TICKER...]
"""
from __future__ import annotations

import glob
import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.modules.research import uzi_sync  # noqa: E402


def _iter_tickers():
    cache_root = os.path.join(uzi_sync.UZI_SCRIPTS, ".cache")
    for p in sorted(glob.glob(os.path.join(cache_root, "*"))):
        if os.path.isdir(p) and os.path.exists(os.path.join(p, "dimensions.json")):
            yield os.path.basename(p)


def _db_rows():
    conn = sqlite3.connect(uzi_sync.PANWATCH_DB)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT symbol, market, ticker_raw, as_of_date, report_dir, tier FROM uzi_reports"
        ).fetchall()
    finally:
        conn.close()
    by_ticker = {}
    for r in rows:
        d = dict(r)
        by_ticker[d.get("ticker_raw") or ""] = d
    return by_ticker


def scan(only: list[str] | None = None) -> list[dict]:
    db = _db_rows()
    out: list[dict] = []
    for ticker in _iter_tickers():
        if only and ticker not in only:
            continue
        disk_dir = uzi_sync._latest_report_dir(ticker)
        disk_date = None
        if disk_dir:
            suffix = disk_dir.rsplit("_", 1)[-1]
            if len(suffix) == 8 and suffix.isdigit():
                disk_date = suffix
        row = db.get(ticker)
        disk_name = os.path.basename(disk_dir).replace("\\", "/") if disk_dir else None
        db_name = os.path.basename((row or {}).get("report_dir") or "").replace("\\", "/")
        if not disk_dir:
            state = "no_report"
        elif not row:
            state = "pending"
        elif db_name != disk_name:
            state = "pending"
        else:
            state = "synced"
        out.append(
            {
                "ticker": ticker,
                "state": state,
                "disk_report_dir": os.path.basename(disk_dir) if disk_dir else None,
                "disk_date": disk_date,
                "db_symbol": (row or {}).get("symbol"),
                "db_market": (row or {}).get("market"),
                "db_as_of": (row or {}).get("as_of_date"),
                "db_tier": (row or {}).get("tier"),
            }
        )
    return out


def main(argv: list[str]) -> int:
    as_json = "--json" in argv
    only = [a for a in argv if not a.startswith("-")] or None
    rows = scan(only)
    pending = [r for r in rows if r["state"] == "pending"]
    if as_json:
        print(json.dumps({"pending": pending, "total": len(rows)}, ensure_ascii=False, indent=2))
        return 0
    if not rows:
        print("UZI 磁盘上没有找到任何产出（.cache/*/dimensions.json）")
        return 0
    if not pending:
        print(f"全部已同步：磁盘 {len(rows)} 只，库里都是最新。")
        return 0
    print(f"有 {len(pending)} 只磁盘产出比 PanWatch 库新：")
    for r in pending:
        have = f"{r['db_as_of']}（{r['db_tier']}）" if r["db_as_of"] else "库里没有"
        print(f"  {r['ticker']:<12} 磁盘 {r['disk_date'] or '?'}  库 {have}")
    print("\n要同步就运行：python scripts/sync_uzi_to_panwatch.py " + " ".join(r["ticker"] for r in pending))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

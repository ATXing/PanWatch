#!/usr/bin/env python
"""UZI → PanWatch 同步脚本(命令行包装)。

用法:
  python scripts/sync_uzi_to_panwatch.py            # 同步 .cache 下全部 ticker
  python scripts/sync_uzi_to_panwatch.py 02020.HK    # 只同步单只
  python scripts/sync_uzi_to_panwatch.py 02020.HK 600887.SH

仅读 UZI 产出 + 写 PanWatch 库新表 uzi_reports + 复制 standalone HTML,零侵入。
重新调研工作流: 在 UZI 侧重跑 run.py -> 跑本脚本 -> 面板刷新。
"""
from __future__ import annotations

import os
import sys

# 允许从任意 cwd 直接运行: 把仓库根目录加入 sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.modules.research import uzi_sync  # noqa: E402


def main(argv: list[str]) -> int:
    if argv:
        results = []
        for ticker in argv:
            r = uzi_sync.sync_symbol(ticker)
            if r:
                results.append(r)
                print(f"  synced {ticker} -> {r['symbol']}/{r['market']} tier={r['tier']} score={r['fundamental_score']}")
            else:
                print(f"  SKIP {ticker}: no .cache output")
    else:
        results = uzi_sync.sync_all()
        for r in results:
            print(f"  synced {r['ticker_raw']} -> {r['symbol']}/{r['market']} tier={r['tier']} score={r['fundamental_score']}")
    print(f"done. {len(results)} record(s) upserted into uzi_reports.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

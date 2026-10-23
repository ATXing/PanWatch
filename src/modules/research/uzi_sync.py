"""UZI 调研结果 → PanWatch 同步核心。

UZI 是 L3 尽调/排雷层(只对重仓股做),其产物分两处:
  - 结构化: <UZI_SCRIPTS>/.cache/<TICKER>/dimensions.json (+ raw_data.json)
  - 人读报告: <UZI_SCRIPTS>/reports/<TICKER>_<DATE>/full-report-standalone.html + one-liner.txt

本模块把二者归一化后 upsert 进 PanWatch 库的新表 `uzi_reports`,并复制
standalone HTML 到本地静态目录以便后端直接吐出。

symbol 归一化: UZI 用 '02020.HK' / '600887.SH', PanWatch stocks 表用
symbol='02020' market='HK' / symbol='600887' market='CN'。
"""

from __future__ import annotations

import glob
import json
import os
import shutil
import sqlite3

# 可通过环境变量覆盖(部署路径不同/测试时用)
UZI_SCRIPTS = os.environ.get(
    "UZI_SCRIPTS_DIR",
    r"D:/Projects/UZI-Skill/skills/deep-analysis/scripts",
)
PANWATCH_DB = os.environ.get(
    "PANWATCH_DB",
    r"D:/Projects/PanWatch/data/panwatch.db",
)
UZI_HTML_DIR = os.environ.get(
    "UZI_HTML_DIR",
    r"D:/Projects/PanWatch/data/uzi_reports_html",
)


def _norm_symbol(ticker: str):
    """'02020.HK' -> ('02020', 'HK'); '600887.SH' -> ('600887', 'CN')."""
    sym, _, ext = ticker.partition(".")
    ext = ext.upper()
    if ext == "HK":
        market = "HK"
    elif ext in ("SH", "SZ", "BJ"):
        market = "CN"
    else:
        # 美股/其他:默认按原样
        market = ext or "CN"
    return sym, market


def resolve_ticker(symbol: str, market: str) -> str | None:
    """PanWatch 的 (symbol, market) → UZI ticker。

    优先级:① 库里已存的 ticker_raw;② 扫 .cache 目录按数字代码匹配
    (最可靠,能区分 SH/SZ);③ 按市场代码推导默认后缀。
    """
    conn = sqlite3.connect(PANWATCH_DB)
    try:
        cur = conn.cursor()
        try:
            cur.execute(
                "SELECT ticker_raw FROM uzi_reports WHERE symbol=? AND market=?",
                (symbol, market),
            )
            row = cur.fetchone()
            if row and row[0]:
                return row[0]
        except sqlite3.OperationalError:
            pass  # 表还没建
    finally:
        conn.close()

    cache_root = os.path.join(UZI_SCRIPTS, ".cache")
    if os.path.isdir(cache_root):
        for name in sorted(os.listdir(cache_root)):
            code, _, _ext = name.partition(".")
            if code == symbol:
                return name

    mkt = (market or "").upper()
    if mkt == "HK":
        return f"{symbol}.HK"
    if mkt in ("CN", "SH", "SZ", "BJ"):
        if symbol.startswith(("6", "9")):
            return f"{symbol}.SH"
        if symbol.startswith(("0", "3")):
            return f"{symbol}.SZ"
        if symbol.startswith(("4", "8")):
            return f"{symbol}.BJ"
        return f"{symbol}.SH"
    return None


def _latest_report_dir(ticker: str):
    base = os.path.join(UZI_SCRIPTS, "reports")
    pat = os.path.join(base, f"{ticker}_*")
    dirs = [d for d in glob.glob(pat) if os.path.isdir(d)]
    if not dirs:
        return None
    # 目录名 <TICKER>_<YYYYMMDD>,字典序最大即最新
    return max(dirs)


def _read_one_liner(path: str) -> str:
    """读取 one-liner.txt,剥掉末尾的 Windows 路径残骸行('全文 → ...')。"""
    if not path or not os.path.exists(path):
        return ""
    txt = open(path, encoding="utf-8").read()
    lines = [ln for ln in txt.splitlines() if not ln.strip().startswith("全文 →")]
    return "\n".join(lines).strip()


def _ensure_table(conn: sqlite3.Connection):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS uzi_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol VARCHAR NOT NULL,
            market VARCHAR NOT NULL,
            ticker_raw VARCHAR,
            tier VARCHAR,
            as_of_date VARCHAR,
            fundamental_score REAL,
            one_liner TEXT,
            coverage_pct REAL,
            dimensions_json TEXT,
            report_dir TEXT,
            html_path TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(symbol, market)
        )
        """
    )


def sync_symbol(ticker: str, db_path: str = PANWATCH_DB) -> dict | None:
    """对单只 UZI ticker 同步最新结果进 PanWatch。无 .cache 产出则返回 None。"""
    cache = os.path.join(UZI_SCRIPTS, ".cache", ticker)
    dims_path = os.path.join(cache, "dimensions.json")
    raw_path = os.path.join(cache, "raw_data.json")
    if not os.path.exists(dims_path):
        return None

    d = json.load(open(dims_path, encoding="utf-8"))
    rd = json.load(open(raw_path, encoding="utf-8")) if os.path.exists(raw_path) else {}

    sym, market = _norm_symbol(ticker)
    tier = rd.get("_profile_depth") or "unknown"
    score = d.get("fundamental_score")
    dims = d.get("dimensions", {})
    integrity = rd.get("_integrity") or {}
    coverage = integrity.get("coverage_pct") if isinstance(integrity, dict) else None

    rdir = _latest_report_dir(ticker)
    one_liner = _read_one_liner(os.path.join(rdir, "one-liner.txt")) if rdir else ""
    as_of = None
    if rdir:
        suffix = rdir.rsplit("_", 1)[-1]
        if len(suffix) == 8 and suffix.isdigit():
            as_of = suffix

    # 复制 standalone HTML 到本地静态目录(覆盖写,固定文件名)
    html_path = ""
    if rdir:
        src = os.path.join(rdir, "full-report-standalone.html")
        if os.path.exists(src):
            os.makedirs(UZI_HTML_DIR, exist_ok=True)
            dst = os.path.join(UZI_HTML_DIR, f"{ticker}.html")
            shutil.copyfile(src, dst)
            html_path = dst

    conn = sqlite3.connect(db_path)
    try:
        _ensure_table(conn)
        conn.execute(
            """
            INSERT INTO uzi_reports
                (symbol, market, ticker_raw, tier, as_of_date, fundamental_score,
                 one_liner, coverage_pct, dimensions_json, report_dir, html_path, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
            ON CONFLICT(symbol, market) DO UPDATE SET
                ticker_raw=excluded.ticker_raw,
                tier=excluded.tier,
                as_of_date=excluded.as_of_date,
                fundamental_score=excluded.fundamental_score,
                one_liner=excluded.one_liner,
                coverage_pct=excluded.coverage_pct,
                dimensions_json=excluded.dimensions_json,
                report_dir=excluded.report_dir,
                html_path=excluded.html_path,
                created_at=CURRENT_TIMESTAMP
            """,
            (
                sym,
                market,
                ticker,
                tier,
                as_of,
                score,
                one_liner,
                coverage,
                json.dumps(dims, ensure_ascii=False),
                rdir or "",
                html_path,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    return {
        "symbol": sym,
        "market": market,
        "ticker_raw": ticker,
        "tier": tier,
        "as_of_date": as_of,
        "fundamental_score": score,
        "coverage_pct": coverage,
    }


def sync_all(db_path: str = PANWATCH_DB) -> list[dict]:
    """扫描 .cache 下所有 ticker 并同步。"""
    cache_root = os.path.join(UZI_SCRIPTS, ".cache")
    if not os.path.isdir(cache_root):
        return []
    results: list[dict] = []
    for name in sorted(os.listdir(cache_root)):
        if "." not in name:
            continue
        r = sync_symbol(name, db_path)
        if r:
            results.append(r)
    return results

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


# ── 维度数据性质判定 ───────────────────────────────────────────────────────
# 背景:UZI 打分函数 lib/pipeline/score_fns.py 里,**部分维度根本不读采集结果,
# 直接返回固定分**(注释自称 stub)。例如 7_industry 恒 7 分、18_trap 恒 9 分
# "🟢 未发现推广痕迹"。而 lite 档压根不采集 4_peers/5_chain/6_research/
# 12_capital_flow/14_moat/17_sentiment/18_trap/19_contests,打分层照样给默认分。
# 若面板把这类分数当结论展示,等于给出不可核实的"安全感"。
#
# 因此同步时按 raw_data.json 的真实采集情况给每维打标:
#   ok    = 有真实采集,分数由数据算出
#   stub  = 固定占位分(score_fns 硬编码,不随标的改变)
#   weak  = 有采集但是兜底/推断值,或采到了但无结果
#   none  = 未采集 / 该市场不适用
_STUB_DIMS = {
    # score_fns.py 中直接 return 固定分的维度(行号见注释)
    "3_macro": "score_fns.py:113 · 恒 6",
    "7_industry": "score_fns.py:167 · 恒 7",
    "8_materials": "score_fns.py:170 · 恒 6",
    "9_futures": "score_fns.py:173 · 恒 5",
    "13_policy": "score_fns.py:225 · 恒 6",
    "14_moat": "score_fns.py:228 · 恒 6",
    "18_trap": "score_fns.py:261 · 恒 9(未扫描也给「安全」)",
}
_NO_DATA_LABELS = (
    "无同行数据",
    "数据不完整",
    "数据稀少",
    "无强关联期货品种",
    "需定性评估",
    "市场不适用",
    "证据未核验",
    "无数据",
)


def _dim_status(dims: dict, raw_dims: dict) -> dict[str, dict]:
    """给每个已打分维度标注数据性质,返回 {dimkey: {status, note?}}。"""
    out: dict[str, dict] = {}
    for key, dim in dims.items():
        if not isinstance(dim, dict):
            continue
        weight = dim.get("weight")
        label = str(dim.get("label") or "")
        raw = raw_dims.get(key)
        has_raw = isinstance(raw, dict) and bool(raw.get("data"))
        fallback = isinstance(raw, dict) and raw.get("fallback") is True

        if weight == 0:
            out[key] = {"status": "none", "note": "该市场不适用"}
        elif key == "18_trap":
            # 特例:打分层恒给 9 分「未发现推广痕迹」,但真实扫描结论在 raw 里,
            # 两者可能冲突(命中风险信号时 raw 会降分,dimensions 仍是 9)。
            data = (raw or {}).get("data") or {}
            level = data.get("trap_level")
            hit = data.get("signals_hit")
            if has_raw and level:
                out[key] = {"status": "stub", "note": f"{hit or '—'} 命中 · {level}"}
            else:
                out[key] = {"status": "none", "note": "未扫描 · 9 分是默认值，不代表已排查"}
        elif key in _STUB_DIMS:
            out[key] = {"status": "stub", "note": "UZI 此项为固定占位分"}
        elif not has_raw:
            out[key] = {"status": "none", "note": "本次未采集，分数为默认值"}
        elif fallback or any(s in label for s in _NO_DATA_LABELS):
            out[key] = {"status": "weak", "note": "兜底/推断值，参考价值低"}
        else:
            out[key] = {"status": "ok"}
    return out


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
            dim_status_json TEXT,
            report_dir TEXT,
            html_path TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(symbol, market)
        )
        """
    )
    # 兼容旧库:dim_status_json 是后加的列
    cols = {r[1] for r in conn.execute("PRAGMA table_info(uzi_reports)").fetchall()}
    if "dim_status_json" not in cols:
        conn.execute("ALTER TABLE uzi_reports ADD COLUMN dim_status_json TEXT")


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
    dim_status = _dim_status(dims, rd.get("dimensions") or {})
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
                 one_liner, coverage_pct, dimensions_json, dim_status_json,
                 report_dir, html_path, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
            ON CONFLICT(symbol, market) DO UPDATE SET
                ticker_raw=excluded.ticker_raw,
                tier=excluded.tier,
                as_of_date=excluded.as_of_date,
                fundamental_score=excluded.fundamental_score,
                one_liner=excluded.one_liner,
                coverage_pct=excluded.coverage_pct,
                dimensions_json=excluded.dimensions_json,
                dim_status_json=excluded.dim_status_json,
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
                json.dumps(dim_status, ensure_ascii=False),
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

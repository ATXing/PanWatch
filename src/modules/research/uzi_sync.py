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

# 真实口径综合分的最低门槛:达到才敢给数字,否则直说「数据不足,不予评分」
MIN_REAL_DIMS = 3
MIN_REAL_WEIGHT_PCT = 30.0

# 视为「没拿到值」的占位符。注意 **不把 0 算缺失** ——
# 「近 30 天龙虎榜 0 次」是实测结论,UZI 自己的 _is_missing 把 "0"/"0.0"
# 也当空值,那是把真实结论抹掉,这里不跟。
_MISSING_TOKENS = {
    "",
    "—",
    "-",
    "--",
    "n/a",
    "na",
    "none",
    "null",
    "n/a/none",
    "无",
    "未知",
    "未获取",
    "无数据",
    "数据缺失",
}


def _is_missing(v) -> bool:
    if v is None:
        return True
    if isinstance(v, str):
        return v.strip().lower() in _MISSING_TOKENS
    if isinstance(v, (list, dict, tuple, set)):
        return len(v) == 0
    return False


def _has_content(data) -> bool:
    """该维度是否真的采到了内容（任一子字段有非空值）。

    查询词/开关类字段不算内容：它们的非空只说明「打算去搜」，不说明「搜到了」。
    """
    if not isinstance(data, dict):
        return False
    return any(
        not _is_missing(v) for k, v in data.items() if k not in _NON_CONTENT_KEYS
    )


# data 里「不是采集结果」的字段：查询词、开关、给 agent 的提示
_NON_CONTENT_KEYS = {
    "qualitative_search",
    "web_search_queries",
    "web_search_snippets_query",
    "needs_web_search",
    "fallback_queries",
    "dynamic_snippets",
}


# 有些维度的 data 里混着「要 agent 去搜的查询词」和「真实采集结果」。
# 只看"有任何一个字段非空"会把查询词当成数据 —— 李宁 11_governance 的
# data 就是 {"pledge": [], "insider_trades_1y": [], "qualitative_search": [...查询词]}，
# 两项真数据全空却被判 ok，标签还显示「质押记录 0」——把「没拿到」写成了「没有」。
# 所以：这些维度必须「核心结果字段」里至少一项有内容才算采到。
_CORE_FIELDS: dict[str, tuple[str, ...]] = {
    "4_peers": ("peer_table", "peer_comparison"),
    "5_chain": ("main_business_breakdown", "ths_zyjs", "products"),
    "11_governance": ("pledge", "insider_trades_1y"),
    "15_events": ("recent_notices", "event_timeline", "recent_news"),
    "19_contests": ("xueqiu_cubes", "tgb_mentions", "dpswang"),
}
# 核心字段全空时给的具体说明（不写会误导成「真的没有」）
_CORE_EMPTY_NOTE = {
    "11_governance": "港股没有 A 股的股权质押/高管持股接口，本次两个核心字段全空——这是「没拿到」，不是「0 质押 / 无内部交易」",
    "4_peers": "没拿到港股同行名单（UZI 自己注明需走 AASTOCKS/问财），不是「行业里没有可比公司」",
    "5_chain": "没拿到主营构成（fetch_chain 只写了 A 股分支），不是「公司没有业务拆分」",
}



def _dim_status(dims: dict, raw_dims: dict) -> dict[str, dict]:
    """给每个已打分维度标注数据性质,返回 {dimkey: {status, note?}}。"""
    out: dict[str, dict] = {}
    for key, dim in dims.items():
        if not isinstance(dim, dict):
            continue
        weight = dim.get("weight")
        label = str(dim.get("label") or "")
        raw = raw_dims.get(key)
        # 「有数据」必须是 data 里真有非空值:data={} 或 {"a": None} 都不算
        has_raw = isinstance(raw, dict) and _has_content(raw.get("data"))
        # 核心字段闸门:只有查询词/辅助字段不算采到
        core = _CORE_FIELDS.get(key)
        if core is not None:
            data = (raw or {}).get("data") if isinstance(raw, dict) else None
            has_core = isinstance(data, dict) and any(
                not _is_missing(data.get(f)) for f in core
            )
            if not has_core:
                has_raw = False
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
                out[key] = {"status": "stub", "note": f"{hit or '—'} 命中 · {level}（分数仍为固定 9）"}
            else:
                out[key] = {"status": "none", "note": "未扫描 · 9 分是默认值，不代表已排查"}
        elif key in _STUB_DIMS:
            # 打分层写死固定分,即便 raw 里有兜底文本也不算实测
            out[key] = {"status": "stub", "note": "UZI 此项为固定占位分，不随标的改变"}
        elif not has_raw:
            out[key] = {
                "status": "none",
                "note": _CORE_EMPTY_NOTE.get(key, "本次未采集，分数为默认值"),
            }
        elif fallback or any(s in label for s in _NO_DATA_LABELS):
            out[key] = {"status": "weak", "note": "兜底/推断值，无实测依据"}
        else:
            out[key] = {"status": "ok"}
    return out


def _score_integrity(dims: dict, dim_status: dict) -> dict:
    """按「只认实测维度」的口径重算综合分,并给出可信度与缺失清单。

    UZI 的 fundamental_score 把固定占位分、未采集的默认分一起加权,
    等于让猜测参与打分(伊利 19 维里只有 6 维是真数据,权重占 37%)。
    这里按定义自算一个 real_score,并明确告诉前端够不够格给分。
    """
    total_weight = 0.0
    real_weight = 0.0
    real_sum = 0.0
    counts = {"ok": 0, "stub": 0, "weak": 0, "none": 0}
    real_keys: list[str] = []
    total_dims = 0

    for key, dim in dims.items():
        if not isinstance(dim, dict):
            continue
        total_dims += 1
        weight = float(dim.get("weight") or 0)
        score = dim.get("score")
        status = (dim_status.get(key) or {}).get("status", "none")
        if status in counts:
            counts[status] += 1
        if weight <= 0:
            continue
        total_weight += weight
        if status == "ok" and isinstance(score, (int, float)):
            real_weight += weight
            real_sum += score * weight
            real_keys.append(key)

    real_dims = len(real_keys)
    weight_pct = (real_weight / total_weight * 100) if total_weight else 0.0
    raw_real = (real_sum / real_weight * 10) if real_weight else None

    # 恒等式闸门:结果必须等于逐项重算,否则说明聚合口径写错了
    if raw_real is not None:
        recompute = (
            sum(dims[k]["score"] * float(dims[k].get("weight") or 0) for k in real_keys)
            / real_weight
            * 10
        )
        assert abs(raw_real - recompute) < 1e-6, (raw_real, recompute)

    trusted = real_dims >= MIN_REAL_DIMS and weight_pct >= MIN_REAL_WEIGHT_PCT

    missing = [
        {
            "key": k,
            "label": str((dims.get(k) or {}).get("label") or "")[:40],
            "status": v.get("status"),
            "note": v.get("note") or "",
            "weight": (dims.get(k) or {}).get("weight"),
        }
        for k, v in dim_status.items()
        if v.get("status") in ("stub", "weak", "none")
    ]
    missing.sort(key=lambda x: ({"stub": 0, "weak": 1, "none": 2}.get(x["status"], 3), -(x["weight"] or 0)))

    if trusted:
        note = (
            f"只按 {real_dims}/{total_dims} 个有实测数据的维度重算（权重占 {weight_pct:.0f}%）；"
            f"另 {counts['stub'] + counts['weak'] + counts['none']} 维没有真实依据，未计入。"
        )
    else:
        note = (
            f"实测维度仅 {real_dims}/{total_dims}（权重占 {weight_pct:.0f}%），"
            f"不足 {MIN_REAL_DIMS} 维 / {MIN_REAL_WEIGHT_PCT:.0f}% 门槛，不予评分。"
        )

    return {
        "real_score": round(raw_real, 1) if (trusted and raw_real is not None) else None,
        "raw_real_score": round(raw_real, 1) if raw_real is not None else None,
        "trusted": trusted,
        "real_dims": real_dims,
        "total_dims": total_dims,
        "real_weight_sum": round(real_weight, 2),
        "total_weight_sum": round(total_weight, 2),
        "real_weight_pct": round(weight_pct, 1),
        "status_counts": counts,
        "real_dim_keys": real_keys,
        "missing": missing,
        "note": note,
    }



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
    # 兼容旧库:dim_status_json / score_integrity_json 是后加的列
    cols = {r[1] for r in conn.execute("PRAGMA table_info(uzi_reports)").fetchall()}
    if "dim_status_json" not in cols:
        conn.execute("ALTER TABLE uzi_reports ADD COLUMN dim_status_json TEXT")
    if "score_integrity_json" not in cols:
        conn.execute("ALTER TABLE uzi_reports ADD COLUMN score_integrity_json TEXT")
    # UZI 综合分(0.6 基本面 + 0.4 评委共识)分项也是后加的:面板要能解释
    # 「one-liner 写 49 分、上方写 61.2 分」的差异,必须把构成存下来
    for col, typ in (
        ("uzi_overall_score", "REAL"),
        ("panel_consensus", "REAL"),
        ("consensus_valid", "INTEGER"),
        ("verdict_detail", "VARCHAR"),
        ("verdict_label", "VARCHAR"),
        ("panel_active", "INTEGER"),
    ):
        if col not in cols:
            conn.execute(f"ALTER TABLE uzi_reports ADD COLUMN {col} {typ}")


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
    score_integrity = _score_integrity(dims, dim_status)
    # UZI 自己的 _integrity.coverage_pct 只统计 18 个基础字段(公司名/股价/ROE/PE…),
    # 与 19 维体检的完整度无关,故在接口层改名为 field_coverage_pct,别让它冒充维度覆盖率
    uzi_integrity = rd.get("_integrity") or {}
    coverage = uzi_integrity.get("coverage_pct") if isinstance(uzi_integrity, dict) else None

    rdir = _latest_report_dir(ticker)
    one_liner = _read_one_liner(os.path.join(rdir, "one-liner.txt")) if rdir else ""
    as_of = None
    if rdir:
        suffix = rdir.rsplit("_", 1)[-1]
        if len(suffix) == 8 and suffix.isdigit():
            as_of = suffix

    # 复制 standalone HTML 到本地静态目录(覆盖写,固定文件名)
    # 复制失败不能让整只票的同步失败:HTML 只是「查看完整报告」用的附件,
    # 分数/维度才是主数据(实测被占用/杀软锁文件时 copyfile 会 PermissionError)
    html_path = ""
    if rdir:
        src = os.path.join(rdir, "full-report-standalone.html")
        if os.path.exists(src):
            try:
                os.makedirs(UZI_HTML_DIR, exist_ok=True)
                dst = os.path.join(UZI_HTML_DIR, f"{ticker}.html")
                shutil.copyfile(src, dst)
                html_path = dst
            except Exception as e:
                print(f"  [warn] {ticker} HTML 副本写入失败(忽略): {type(e).__name__}: {e}")
                html_path = ""

    # UZI 自己的 "综合分" 与基本面分是两个数,必须分开存:
    # synthesis.overall_score = 0.6*基本面 + 0.4*66 位流派评委共识(score_fns.py:1052),
    # 所以 one-liner 里的「体检结果 xx 分」既不是 fundamental_score 也不是 real_score。
    synth_path = os.path.join(cache, "synthesis.json")
    synth = json.load(open(synth_path, encoding="utf-8")) if os.path.exists(synth_path) else {}
    uzi_overall = synth.get("overall_score")
    panel_consensus = synth.get("panel_consensus")
    consensus_valid = synth.get("consensus_valid")
    verdict_detail = synth.get("verdict_detail")
    verdict_label = synth.get("verdict_label")
    # 有效评委人数：synthesis 没存，panel.json 的 signal_distribution 里有
    panel_active = None
    panel_path = os.path.join(cache, "panel.json")
    if os.path.exists(panel_path):
        try:
            dist = (json.load(open(panel_path, encoding="utf-8")) or {}).get("signal_distribution") or {}
            n = sum(int(dist.get(k) or 0) for k in ("bullish", "neutral", "bearish"))
            panel_active = n or None
        except Exception:
            panel_active = None

    conn = sqlite3.connect(db_path)
    try:
        _ensure_table(conn)
        conn.execute(
            """
            INSERT INTO uzi_reports
                (symbol, market, ticker_raw, tier, as_of_date, fundamental_score,
                 one_liner, coverage_pct, dimensions_json, dim_status_json,
                 score_integrity_json, report_dir, html_path,
                 uzi_overall_score, panel_consensus, consensus_valid,
                 verdict_detail, verdict_label, panel_active, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
            ON CONFLICT(symbol, market) DO UPDATE SET
                ticker_raw=excluded.ticker_raw,
                tier=excluded.tier,
                as_of_date=excluded.as_of_date,
                fundamental_score=excluded.fundamental_score,
                one_liner=excluded.one_liner,
                coverage_pct=excluded.coverage_pct,
                dimensions_json=excluded.dimensions_json,
                dim_status_json=excluded.dim_status_json,
                score_integrity_json=excluded.score_integrity_json,
                report_dir=excluded.report_dir,
                html_path=excluded.html_path,
                uzi_overall_score=excluded.uzi_overall_score,
                panel_consensus=excluded.panel_consensus,
                consensus_valid=excluded.consensus_valid,
                verdict_detail=excluded.verdict_detail,
                verdict_label=excluded.verdict_label,
                panel_active=excluded.panel_active,
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
                json.dumps(score_integrity, ensure_ascii=False),
                rdir or "",
                html_path,
                uzi_overall,
                panel_consensus,
                None if consensus_valid is None else (1 if consensus_valid else 0),
                verdict_detail,
                verdict_label,
                panel_active,
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
        "real_score": score_integrity.get("real_score"),
        "real_dims": score_integrity.get("real_dims"),
        "total_dims": score_integrity.get("total_dims"),
        "trusted": score_integrity.get("trusted"),
        "uzi_overall_score": uzi_overall,
        "panel_consensus": panel_consensus,
        "panel_active": panel_active,
        "verdict_label": verdict_label,
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

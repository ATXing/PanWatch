"""UZI 补数 prompt 生成器。

用途：UZI 调研跑完后，把「这只票缺哪些维、每维要什么字段、怎么写快照、跑什么命令」
渲染成一段**自包含 prompt**，用户复制到 WorkBuddy 会话，由 agent 用通达信 MCP 补数。

为什么不由后端直接补：通达信 MCP 的 token 只在 WorkBuddy 客户端侧，后端直连 401
（见 `UZI-Skill/skills/deep-analysis/scripts/lib/pipeline/tdx_prefill_source.py` 文件头）。
所以补数必须是「人粘 prompt → agent 抓数 → 写 data/tdx_prefill/<TICKER>.json」。

⚠️ `DIM_SPECS` 的字段依据 `UZI-Skill/skills/deep-analysis/scripts/lib/pipeline/score_fns.py`
（行号在每维 `src` 里注明）。**UZI 升级若改了打分读取的字段，此表必须同步**，否则
agent 补了也是白补（写进去的 key 打分器一行不读）。

分档口径（tier）：
  A = 直接改分（打分器真读字段）
  B = 点数恒定，但字段进 extract_features → 51 评委 → panel_consensus(权重 0.4)
  C = 分数与评委都不受影响，只把报告 label 从「未取得实测」改成实测值
"""

from __future__ import annotations

import json
import sqlite3
from datetime import date
from pathlib import Path

from src.modules.research.uzi_sync import PANWATCH_DB, UZI_SCRIPTS, resolve_ticker

TIER_TITLES = {
    "A": "直接改分（优先补）",
    "B": "点数恒定，但字段会喂给 51 位评委 → 间接影响 uzi_overall_score",
    "C": "只让报告文案从「未取得实测」变实测，分数不变",
}

TIER_NOTES = {
    "A": "补上就直接改变 UZI 基本面分。",
    "B": "这几维的分数写死（7_industry 恒 7、14_moat 恒 6），但字段会进评委特征，"
         "经 panel_consensus 影响综合分（0.6 基本面 + 0.4 评委共识）。",
    "C": "这几维打分器写死分数，补数不会改变任何分数，只影响报告可读性与可信度标注。"
         "时间紧张可以跳过。",
}

# uzi_sync._CORE_EMPTY_NOTE 把「港股」写死在 11_governance/4_peers/5_chain 的文案里，
# A 股命中同一条 note 时会出现「A 股股票被说成港股没有接口」。这里按 market 纠正，
# 避免 prompt 里给 agent 错误的市场信号（根因在 uzi_sync，属独立遗留项）。
_CROSS_MARKET_FIX = {
    "11_governance": "本次没拿到股权质押与高管持股两个核心字段——这是「没拿到」，"
                     "不是「0 质押 / 无内部交易」",
    "4_peers": "本次没拿到同行名单——这是「没拿到」，不是「行业里没有可比公司」",
    "5_chain": "本次没拿到主营构成——这是「没拿到」，不是「公司没有业务拆分」",
}


def _clean_note(note: str, key: str, market: str) -> str:
    """note 与市场不符时换成中性文案（不改库，只用于 prompt 展示）。"""
    if not note:
        return note
    wrong = (market != "HK" and "港股" in note) or (market == "HK" and "A 股" in note and "港股" not in note)
    if wrong and key in _CROSS_MARKET_FIX:
        return _CROSS_MARKET_FIX[key]
    return note

# 维度补数规格。fields = 打分器真正读取的 data key；rule = 打分逻辑；pitfall = 常见白补陷阱
DIM_SPECS: dict[str, dict] = {
    "1_financials": {
        "title": "财报扎实度", "weight": 5, "tier": "A", "src": "score_fns.py:63-90",
        "fields": [
            "`roe`（百分数）或 `roe_history`（list，取最后一项）",
            "`net_margin`（百分数）",
            "`revenue_history`（list，**至少 2 个元素**，否则增速记 0）",
            "`financial_health.debt_ratio`（百分数）",
        ],
        "rule": "ROE≥15 +2 / ≥10 +1 / <5 −2；净利率≥15 +1；营收增速≥20% +1；负债率≥60 −1",
        "sources": ["akshare 财报接口（多数票已能取到，缺通常是港股或新股）"],
        "pitfall": "`gross_margin`、`ocf` 不参与打分，不用补",
    },
    "2_kline": {
        "title": "K 线技术面", "weight": 4, "tier": "A", "src": "score_fns.py:92-110",
        "fields": [
            "`stage`（字符串，须含 `Stage 2` / `Stage 1` / `Stage 3` / `Stage 4` 字面量）",
            "`ma_align`（字符串，须含「多头」二字才 +1）",
            "`kline_stats.max_drawdown`（可解析负数，如 `-12.3%`）",
        ],
        "rule": "Stage 2 +2 / Stage 1 +1 / Stage 3、4 −2；含「多头」+1；回撤≤−30% −1",
        "sources": ["本地 K 线即可算，一般不需要补"],
        "pitfall": "`ma5/ma20/ma60/rsi/kline_daily` 打分器完全不用",
    },
    "3_macro": {
        "title": "宏观环境", "weight": 3, "tier": "C", "src": "score_fns.py:112-155",
        "fields": [
            "`rate_cycle`、`fx_trend`、`geo_risk`、`commodity`（四段自然语言实测描述）",
            "`web_search_snippets.{同名四键}`（list，检索摘要）",
        ],
        "rule": "分数恒 6，不随内容变化",
        "sources": ["宏观数据 + 检索"],
        "pitfall": "不能写「中性（…）」「未拉取」「未命中」「无直接关联」——会被判成占位串等于没写",
    },
    "4_peers": {
        "title": "同行对比", "weight": 4, "tier": "A", "src": "score_fns.py:157-185",
        "fields": [
            "`peer_table`（list，**长度 ≥2**；每行含 `is_self`(bool) 与 `pe`(数字)）",
            "`global_peer_comparison.peer_count`（int ≥3 也可顶到 7 分）",
        ],
        "rule": "有同行表→7 分；自身 PE 低于同行均值 90% +1、高于 120% −1",
        "sources": ["通达信同行/行业归属", "东财行业成分"],
        "pitfall": "只有 1 行等于没有（必须 ≥2 行）；`peer_comparison`、`rank` 打分不读",
    },
    "5_chain": {
        "title": "上下游产业链", "weight": 4, "tier": "A", "src": "score_fns.py:187-193",
        "fields": ["`main_business_breakdown`（list，非空即可，建议含业务名+占比）"],
        "rule": "非空 → 6 分；空 → 5 分（只有这两档）",
        "sources": ["通达信主营构成", "东财主营业务构成", "同花顺主营介绍"],
        "pitfall": "`upstream`/`downstream`/`client_concentration` 只上报告卡，不影响分数",
    },
    "6_research": {
        "title": "研报观点", "weight": 3, "tier": "A", "src": "score_fns.py:195-206",
        "fields": [
            "`report_count`（int，每 5 份 +1，15 份封顶 +3）",
            "`rating_distribution`（dict，key 含「买入」或「增持」，value 累加 ≥10 再 +1）",
        ],
        "rule": "5 + min(3, report_count//5)；买入+增持 ≥10 +1",
        "sources": ["通达信研报", "东财研报"],
        "pitfall": "`coverage`、`coverage_count` fetcher 会写但打分器**不读**，别只填这两个",
    },
    "7_industry": {
        "title": "行业景气", "weight": 4, "tier": "B", "src": "score_fns.py:208-238",
        "fields": [
            "`growth`（可解析数字，如 `+30%/年`；`高增长` 这类文字无效）",
            "`lifecycle`（字符串，非 `—`/`-`/`n/a`）",
            "`cninfo_metrics.total_mcap_yi`（行业总市值，亿元）",
            "`cninfo_metrics.industry_pe_weighted` / `industry_pe_median`、`company_count`",
        ],
        "rule": "分数恒 7；字段只进 label 与评委特征（市占率、BCG 定位）",
        "sources": ["巨潮行业市盈率", "通达信行业数据"],
        "pitfall": "`tam`、`penetration` 打分与评委都不读",
    },
    "8_materials": {
        "title": "原材料", "weight": 3, "tier": "C", "src": "score_fns.py:240-261",
        "fields": ["`core_material`（核心原材料名）", "`cost_share`（成本占比）", "`price_trend`（价格趋势）"],
        "rule": "分数恒 6",
        "sources": ["期货/现货行情", "公司成本披露"],
        "pitfall": "空值不能写 `—`/`-`/`n/a`，会被当未取得",
    },
    "9_futures": {
        "title": "期货关联", "weight": 2, "tier": "C", "src": "score_fns.py:263-279",
        "fields": ["`linked_contract`（关联合约名；确无关联就写「无直接关联」）", "`contract_trend`"],
        "rule": "分数恒 5",
        "sources": ["期货主力合约行情"],
        "pitfall": "`inventory` 打分器不读",
    },
    "10_valuation": {
        "title": "估值多维", "weight": 5, "tier": "A", "src": "score_fns.py:281-295",
        "fields": [
            "`pe_quantile`（**唯一影响分数的字段**）：须为 0–100 的数字，"
            "或 `\"28 分位\"` / `\"28%\"` / `28` 这三种可解析形式",
        ],
        "rule": "分位<30→9 / <50→7 / <70→5 / <85→3 / 其余 2；解析不出→5",
        "sources": ["通达信估值分位", "东财/百度近五年 PE 分位"],
        "pitfall": "写「估值偏低」「近五年分位」都解析失败；`pe`、`industry_pe` 只进文案",
    },
    "11_governance": {
        "title": "管理层与治理", "weight": 4, "tier": "A", "src": "score_fns.py:297-317",
        "fields": [
            "`pledge`（list；**空数组 `[]` 才 +1**，写 null 会走兜底判定）",
            "`insider_trades_1y`（list；非空即 +1）",
            "`pledge_verified` / `insider_verified`（bool，仅影响文案）",
        ],
        "rule": "6 分基础；无质押 +1；有内部交易记录 +1，上限 8",
        "sources": ["通达信股权质押", "东财高管增减持 RPT_EXECUTIVE_HOLD_DETAILS"],
        "pitfall": "打分上限只有 8 分，别指望补齐能到 10",
    },
    "12_capital_flow": {
        "title": "资金面", "weight": 4, "tier": "A", "src": "score_fns.py:319-344",
        "fields": [
            "`main_fund_flow_20d`（list[dict]，**每条的键名必须精确是 `主力净流入-净额`，"
            "值单位=元**，打分器只累加前 5 条）",
            "`unlock_schedule`（list；**空数组才 +1**）",
            "`unlock_verified`（bool，仅文案）",
        ],
        "rule": "前 5 日主力净流入合计 >0 +2、<0 −1；无解禁 +1",
        "sources": ["通达信资金流向", "新浪 MoneyFlow.ssl_qsfx_zjlrqs（主源口径）"],
        "pitfall": "**键名写错（如写 `主力净额`）会永远算成 0，且不加不减，最难发现**；"
                   "`northbound`/`margin_recent`/`holder_count_history` 打分不读",
    },
    "13_policy": {
        "title": "政策与监管", "weight": 3, "tier": "C", "src": "score_fns.py:346-354",
        "fields": ["`snippets`（嵌套 dict，四个子键 `policy_dir`/`subsidy`/`monitoring`/`anti_trust`）"],
        "rule": "分数恒 6；只按 snippets 子键有没有内容决定 label",
        "sources": ["按产业口径检索（按行业名检索港股通常为空）"],
        "pitfall": "顶层 `policy_dir` 打分器不读，必须放进 `snippets` 里",
    },
    "14_moat": {
        "title": "护城河（5 类）", "weight": 3, "tier": "B", "src": "score_fns.py:356-365",
        "fields": [
            "`scores`（dict，值必须是 int/float：intangible / switching / network / scale / rd）",
            "`scores_available`（bool，必须为 true 才计入）",
        ],
        "rule": "分数恒 6；`scores` 会进评委特征做护城河定性",
        "sources": ["定性检索 + 财报研发占比"],
        "pitfall": "`scores` 里写字符串分数（如 `\"强\"`）不会被计入",
    },
    "15_events": {
        "title": "事件驱动", "weight": 4, "tier": "A", "src": "score_fns.py:367-376",
        "fields": [
            "`news` 或 `recent_news`（list；**≥10 条才 +1，20 条 +2，30 条 +3**）",
            "`recent_notices`（公告 list，仅文案）",
        ],
        "rule": "5 + min(3, len(news)//10)",
        "sources": ["通达信公告", "东财个股新闻", "港股 hkexnews"],
        "pitfall": "港股这一维会被 `sanitize_hk_events` 清洗，注入需带 `_issuer_identity_version`；"
                   "版本号不确定时别硬写这一维，交给 UZI 自己的 fetcher",
    },
    "16_lhb": {
        "title": "龙虎榜", "weight": 4, "tier": "A", "src": "score_fns.py:378-391",
        "fields": [
            "`verified`（**必须是布尔 true**，字符串 `\"true\"` 不认）",
            "`lhb_count_30d`（int，每 2 次 +1，6 次封顶 +3）",
            "`matched_youzi`（list，非空 +1）",
        ],
        "rule": "5 + min(3, count//2) + (有游资匹配 ? 1 : 0)；**verified 不是 true → 整维权重归 0**",
        "sources": ["通达信龙虎榜"],
        "pitfall": "**没有 `verified: true` 就直接掉权重**，这维最容易被写成无效数据；"
                   "港股无龙虎榜，不要补",
    },
    "17_sentiment": {
        "title": "舆情与大V", "weight": 3, "tier": "A", "src": "score_fns.py:393-402",
        "fields": [
            "`hot_rank.rank_history`（嵌套 dict 里的 list；**≥10 条才 +1，20 条 +2**）",
            "`sentiment_data_available`（bool，仅文案）",
        ],
        "rule": "6 + min(2, len(rank_history)//10)",
        "sources": ["雪球热度", "股吧", "搜索类渠道",
                    "（通达信无舆情热度数据；雪球/股吧都取不到就写 verified:false，别硬凑）"],
        "pitfall": "**全仓没有任何 fetcher 生产 `hot_rank`**，这维分数天然锁死 6 分，"
                   "只有手工注入才可能动",
    },
    "18_trap": {
        "title": "杀猪盘检测", "weight": 5, "tier": "C", "src": "score_fns.py:404-416",
        "fields": [
            "`snippets`（扫到的公开帖，非空）",
            "`signals_hit_count`（命中信号数，整数 0–8）",
            "`signals_hit`（**字符串** `\"N/8\"`；写成整数 0 会被显示成「—」，像是没扫过）",
            "`trap_level`（**只能用 UZI 的规范档位**：`⚪ 未取证` / `🟢 安全` / `🟡 注意` / "
            "`🟠 警惕` / `🔴 高度可疑`；命中 ≤1 → 🟢 安全、2–3 → 🟡 注意、4–5 → 🟠 警惕、>5 → 🔴 高度可疑）",
        ],
        "rule": "分数恒 9，高危信号再多也不掉分（口径如此，不是 bug）",
        "sources": ["公开帖检索（8 组信号关键词）"],
        "pitfall": "补这一维不会降低风险分，只让报告显示「已扫描 N 组」；"
                   "**`trap_level` 绝不能写裸词「低 / 中 / 高」**——UZI 的 emoji 映射认不出裸词会落到默认 🔴，"
                   "「低风险」被显示成红色，one-liner 末行与下方「🟢 未发现推广痕迹」直接打架（2026-11-02 紫金矿业踩过）",
    },
    "19_contests": {
        "title": "实盘比赛持仓", "weight": 4, "tier": "A", "src": "score_fns.py:418-427",
        "fields": [
            "`summary.xueqiu_cubes_total`（int，每 5 个 +1，15 个封顶 +3）",
            "`summary.high_return_cubes`（int，每个 +1，封顶 +2）",
        ],
        "rule": "5 + min(3, total//5) + min(2, high_return)",
        "sources": ["雪球组合搜索（需登录）",
                    "（通达信无实盘组合数据；雪球要登录态，取不到就写 verified:false）"],
        "pitfall": "顶层 `xueqiu_cubes` 列表打分器不读，必须落到 `summary` 里",
    },
}

DIM_ORDER = [
    "1_financials", "2_kline", "3_macro", "4_peers", "5_chain", "6_research",
    "7_industry", "8_materials", "9_futures", "10_valuation", "11_governance",
    "12_capital_flow", "13_policy", "14_moat", "15_events", "16_lhb",
    "17_sentiment", "18_trap", "19_contests",
]


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _stock_name(symbol: str, market: str) -> str:
    """股票名。库里没有就退回 ticker，不影响 prompt 可用性。"""
    try:
        conn = sqlite3.connect(f"file:{PANWATCH_DB}?mode=ro", uri=True)
        try:
            row = conn.execute(
                "SELECT name FROM stocks WHERE symbol=? AND market=?", (symbol, market)
            ).fetchone()
            return (row[0] if row and row[0] else "") or symbol
        finally:
            conn.close()
    except sqlite3.Error:
        return symbol


def _load_raw_dims(ticker: str | None) -> tuple[dict, str]:
    """读 UZI 缓存里的维度原始记录，用于补「缺哪些字段 / 已试过什么查询」。

    返回 (dimensions, 降级原因)。读不到不报错，prompt 会标注字段明细缺失。
    """
    if not ticker:
        return {}, "无 ticker，读不到 UZI 缓存"
    path = Path(UZI_SCRIPTS) / ".cache" / ticker / "raw_data.json"
    if not path.exists():
        return {}, "UZI 缓存不存在（可能已清理）"
    raw = _read_json(path)
    if not isinstance(raw, dict):
        return {}, "UZI 缓存解析失败"
    dims = raw.get("dimensions")
    return (dims if isinstance(dims, dict) else {}), ""


def collect_gap(symbol: str, market: str) -> dict:
    """汇集这只票的缺口事实。返回 {ok: False, reason} 或完整 gap 结构。"""
    try:
        conn = sqlite3.connect(f"file:{PANWATCH_DB}?mode=ro", uri=True)
        try:
            row = conn.execute(
                "SELECT tier, ticker_raw, as_of_date, dim_status_json, score_integrity_json "
                "FROM uzi_reports WHERE symbol=? AND market=?",
                (symbol, market),
            ).fetchone()
        finally:
            conn.close()
    except sqlite3.Error as e:
        return {"ok": False, "reason": f"读库失败：{e}"}

    if not row:
        return {"ok": False, "reason": "no_report"}

    tier, ticker_raw, as_of_date, dim_status_json, integrity_json = row
    try:
        dim_status = json.loads(dim_status_json) if dim_status_json else {}
        integrity = json.loads(integrity_json) if integrity_json else {}
    except ValueError:
        dim_status, integrity = {}, {}

    ticker = ticker_raw or resolve_ticker(symbol, market) or ""
    raw_dims, raw_note = _load_raw_dims(ticker)

    missing_all = integrity.get("missing") or []
    missing: list[dict] = []
    skipped: list[dict] = []
    for m in missing_all:
        key = m.get("key") or ""
        if key not in DIM_SPECS:
            continue
        # 权重 0 = 该市场不适用（如港股 16_lhb），绝不能叫 agent 去补
        if (m.get("weight") or 0) <= 0:
            skipped.append(m)
            continue
        missing.append(m)

    # 补齐 spec，供渲染
    for m in missing:
        key = m["key"]
        spec = DIM_SPECS[key]
        rd = (raw_dims.get(key) or {}) if raw_dims else {}
        pipeline = rd.get("_pipeline") or {}
        data = rd.get("data") if isinstance(rd.get("data"), dict) else {}
        autofill_failed = data.get("_autofill_failed") if isinstance(data, dict) else None
        m["title"] = spec["title"]
        m["tier"] = spec["tier"]
        m["order"] = DIM_ORDER.index(key) if key in DIM_ORDER else 99
        m["note"] = _clean_note(m.get("note") or "", key, market)
        m["data_gaps"] = list(pipeline.get("data_gaps") or [])
        m["quality"] = pipeline.get("quality")
        m["fallback"] = rd.get("fallback") is True
        m["autofill_query"] = (autofill_failed or {}).get("query") if isinstance(autofill_failed, dict) else None
        m["autofill_reason"] = (autofill_failed or {}).get("reason") if isinstance(autofill_failed, dict) else None
        # 这维在 UZI 里「每次都会重抓还是被 TTL 复用」——决定它是不是结构性空
        m["refetched_every_run"] = bool(
            m["quality"] in ("missing", "error") or m["fallback"] or not data
        )

    missing.sort(key=lambda x: (x["tier"], x["order"]))
    counts = {t: len([m for m in missing if m["tier"] == t]) for t in ("A", "B", "C")}

    return {
        "ok": True,
        "symbol": symbol,
        "market": market,
        "ticker": ticker,
        "name": _stock_name(symbol, market),
        "tier": tier,
        "as_of_date": as_of_date,
        "real_dims": integrity.get("real_dims"),
        "total_dims": integrity.get("total_dims"),
        "real_score": integrity.get("real_score"),
        "real_weight_pct": integrity.get("real_weight_pct"),
        "trusted": integrity.get("trusted"),
        "missing": missing,
        "skipped": skipped,
        "tier_counts": counts,
        "raw_note": raw_note,
        "dim_status": dim_status,
    }


def _render_dim(m: dict) -> list[str]:
    spec = DIM_SPECS[m["key"]]
    out = [f"### {m['key']} · {spec['title']} · 权重 {spec['weight']}"]
    out.append(f"- 当前状态：{m.get('note') or '无实测数据'}")

    gaps = m.get("data_gaps") or []
    if gaps:
        out.append(
            f"- UZI fetcher 侧没拿到的源字段：`{'`、`'.join(gaps)}`"
            "（这些是 UZI 自己失败的入口，你要产出的仍是下面「必须提供」里的打分字段）"
        )

    out.append("- 必须提供（打分器实际读取的 key）：")
    for f in spec["fields"]:
        out.append(f"  - {f}")
    out.append(f"- 打分规则：{spec['rule']}")
    out.append(f"- 建议来源：{'；'.join(spec['sources'])}")
    if spec.get("pitfall"):
        out.append(f"- ⚠️ 易错点：{spec['pitfall']}")

    if m.get("autofill_query"):
        out.append(
            f"- UZI 已试过的查询：「{m['autofill_query']}」→ 失败原因：{m.get('autofill_reason') or '未记录'}"
            "（不要重复这条查询，换源或换关键词）"
        )
    if m.get("refetched_every_run"):
        out.append(
            "- 注意：这维在 UZI 里**每次运行都会重新抓取且仍然为空**，属结构性缺失——"
            "原 fetcher 已经试过多次，必须换数据源手工注入才有用"
        )
    out.append("")
    return out


def build_prompt(gap: dict) -> str:
    """把 gap 渲染成可直接粘贴的任务卡。"""
    tier = gap["tier"] or "unknown"
    n_missing = len(gap["missing"])
    counts = gap["tier_counts"]
    name, ticker, symbol, market = gap["name"], gap["ticker"], gap["symbol"], gap["market"]
    today = date.today().isoformat()

    L: list[str] = [
        f"# 任务：补齐 {name}（{ticker}）的 UZI 调研缺失维度",
        "",
        "你是 WorkBuddy 的执行 agent。**请直接开始执行，不要进入 plan mode、不要先问我确认**。",
        "目标：用通达信 MCP 抓取下列缺失维度 → 写成快照 → 重算评估 → 提醒我刷新页面。",
        "",
        "## 现状",
        f"- 股票：{name} ｜ ticker `{ticker}` ｜ PanWatch `symbol={symbol}&market={market}`",
        f"- UZI 档位：{tier} ｜ 报告期：{gap['as_of_date'] or '未知'}",
        f"- 实测维度：{gap['real_dims']}/{gap['total_dims']} ｜ "
        f"可信分 {gap['real_score']} ｜ 权重覆盖 {gap['real_weight_pct']}%",
        f"- 缺失 {n_missing} 维（档A {counts['A']} / 档B {counts['B']} / 档C {counts['C']}）",
    ]
    if gap.get("raw_note"):
        L.append(f"- ⚠️ 拿不到 UZI 缓存的字段级明细（{gap['raw_note']}），下面按维度级描述执行")
    L.append("")

    if n_missing == 0:
        L += [
            "## 结论",
            f"这只票 {gap['total_dims']} 维全部实测，**不需要补数**。请直接告诉我「无需补数」并结束。",
            "",
        ]
        return "\n".join(L)

    # 分档说明
    L += ["## 三档收益差异（重要，决定你该花多少力气）", ""]
    for t in ("A", "B", "C"):
        if counts[t]:
            L.append(f"- **档 {t}**（{counts[t]} 维）：{TIER_NOTES[t]}")
    L.append("")

    for t in ("A", "B", "C"):
        items = [m for m in gap["missing"] if m["tier"] == t]
        if not items:
            continue
        L.append(f"## 档 {t} · {TIER_TITLES[t]}")
        L.append("")
        for m in items:
            L.extend(_render_dim(m))

    if gap.get("skipped"):
        keys = "、".join(m.get("key") or "" for m in gap["skipped"])
        L += [f"> 已剔除：{keys} —— 该市场不适用（权重 0），不要去补。", ""]

    # 公告类数据的主体校验：港股尤其容易串票（wenda_notice_query 传港股代码会退化成全市场流）
    if market == "HK":
        subject_rule = (
            f"- `wenda_notice_query` 传港股代码会退化成全市场公告流，返回的公司必须与{name}"
            "对得上，对不上整条丢弃。"
        )
    else:
        subject_rule = (
            f"- 公告/新闻类数据必须校验主体：返回的公司名要能与{name}对上，对不上整条丢弃。"
        )

    L += [
        "## 写入格式",
        "",
        f"路径：`D:/Projects/UZI-Skill/data/tdx_prefill/{ticker}.json`",
        "",
        "```json",
        "{",
        f'  "ticker": "{ticker}",',
        f'  "name": "{name}",',
        f'  "as_of": "{today}",',
        '  "max_age_days": 14,',
        '  "captured_by": "workbuddy-agent",',
        '  "dims": {',
        '    "<维度key>": {',
        '      "source": "tdx:<实际用的接口或页面>",',
        '      "quality": "full",',
        '      "verified": true,',
        '      "data": { "<字段>": "<值>" }',
        "    }",
        "  }",
        "}",
        "```",
        "",
        "硬性规则：",
        "- **拿不到就写 `\"verified\": false` + 空 `data`，绝不编造数字**。"
        "false 不占位，UZI 会自己再试一次；编数会污染分数且无法追溯。",
        "- `data` 必须是非空 dict，否则整维被跳过（等于白写）。",
        "- `ticker` 必须大写且与文件名一致；`as_of` 用今天；超 14 天整张快照失效。",
        "- 每条数据都要带 `source`，写清是从哪个接口/页面拿的。",
        "- 已有同名快照时先读出来再合并，**不要覆盖这只票之前补过的维**。",
        "",
        "## 执行命令（按序）",
        "",
        "```bash",
        "cd D:/Projects/UZI-Skill",
        f"python tdx_prefill.py list          # 先看这只票已有的快照与有效期",
        f"python tdx_prefill.py apply {ticker}  # 灌进 raw_data.json（自带 .bak 备份）",
        f"python run.py {ticker} --from-modeling --no-browser --depth {tier}",
        f'curl -X POST "http://127.0.0.1:8123/api/uzi/resync?symbol={symbol}&market={market}"',
        "```",
        "",
        f"⚠️ `--depth {tier}` **必须与原档位一致**：档位不一致会触发 UZI 的自查闸，"
        "报 `RuntimeError: BLOCKED by self-review`（源码 `run.py` 有注释说明）。",
        "",
        "## 禁止",
        "",
        "- 不改任何打分口径（`score_fns.py` / `validators.py` / `uzi_sync.py` 里的 score 表达式）。",
        "- 不编数。取不到就 `verified: false` 并如实说明。",
        "- 通达信调用逐票串行、调用间隔 ≥1s、连续失败即停（数据源安全铁律，不能并发冲）。",
        subject_rule,
        "",
        "## 完成后",
        "",
        "告诉我三件事：",
        "1. 补上了哪几维、哪几维确实拿不到（及原因）；",
        f"2. 分数从 {gap['real_score']} 变成多少（对照档A/B/C 的预期）；",
        "3. 提醒我回 PanWatch 详情页关掉再打开弹窗（或点「仅同步」）看新报告。",
        "",
    ]
    return "\n".join(L)


def build(symbol: str, market: str) -> dict:
    """对外入口：返回 {ok, ticker, name, n_missing, tier_counts, prompt}。"""
    gap = collect_gap(symbol, market)
    if not gap.get("ok"):
        reason = gap.get("reason") or "unknown"
        if reason == "no_report":
            reason = "这只股票还没有 UZI 报告，先跑一次调研"
        return {"ok": False, "reason": reason}

    prompt = build_prompt(gap)
    return {
        "ok": True,
        "symbol": gap["symbol"],
        "market": gap["market"],
        "ticker": gap["ticker"],
        "name": gap["name"],
        "tier": gap["tier"],
        "n_missing": len(gap["missing"]),
        "real_dims": gap["real_dims"],
        "total_dims": gap["total_dims"],
        "tier_counts": gap["tier_counts"],
        "raw_note": gap["raw_note"],
        "prompt": prompt,
    }

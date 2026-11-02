"""UZI 调研进度解析：把子进程日志翻译成「阶段进度 + 逐维状态」。

日志是唯一真相源。UZI 以独立子进程跑（`uzi_jobs.start_job()`），stdout 直接重定向
到 `data/uzi_jobs/<ticker>_<tier>_<ts>.log`，父进程看不到任何内存态，只能读文件。

## 四条设计决定（都是踩过坑换来的，改之前先读完）

1. **全量重扫，不做 offset 增量。**
   实测日志只有 8.6–9.5 KB，全量 read + 40 次正则约 0.3–0.8 ms，1s 一次可忽略。
   而 offset 增量会永久错位：UZI 用 `print(..., end="")` 打 wave 行，紧接着子进程
   的 `login success!` 会直接粘在同一行（实测 `wave 1 · 0_basiclogin success!`），
   写端还可能在任何字节边界 flush。全量重扫天然幂等 ⇒ 「计数倒退」与「重启重建」
   两个坑自动消失。

2. **期望维度数来自本地 tier 表，绝不读日志。**
   `collect.py:284` 无条件打印 `wave 3 · 4 dependent fetcher`；lite 档那 4 个全被
   `_in_scope()` 过滤掉、一个都不跑，但日志照样打 4。读了就会误报。

3. **`ok` 行 ≠ 成功。**
   第三个字段是 quality（full/partial/missing）。实测 lite 日志里有
   `ok similar_stocks missing`——fetcher 跑完了但没拿到东西。

4. **永不抛异常。**
   解析失败降级为 `degraded=True`，上层退回旧的单行进度。UZI 是本地 fork 会持续
   升级，`print` 格式随时可能变，不能让它把新功能连坐弄挂。
"""

from __future__ import annotations

import logging
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime

logger = logging.getLogger(__name__)

__all__ = [
    "DIM_META",
    "GROUP_ORDER",
    "GROUP_LABELS",
    "STAGE_SPECS",
    "DimPlan",
    "plan_for",
    "parse_log",
    "build_progress",
    "summary",
    "clear_cache",
]

SCHEMA_VERSION = 1


# ============================================================================
# 维度字典（key -> 中文简称 + 分组）
#
# 中文名来自 UZI 自己的 `lib/pipeline/score_fns.py:1463-1485` 的 dim_labels，
# 只补了它没有的两个顶层字段提供者。分组是给前端网格用的，与 UZI 无关。
# ============================================================================

DIM_META: dict[str, tuple[str, str]] = {
    "0_basic": ("基础信息", "basic"),
    "6_fund_holders": ("基金持仓", "basic"),
    "similar_stocks": ("相似个股", "basic"),
    "1_financials": ("财报", "finance"),
    "10_valuation": ("估值分位", "finance"),
    "14_moat": ("护城河", "finance"),
    "2_kline": ("K线技术面", "market"),
    "12_capital_flow": ("资金面", "market"),
    "16_lhb": ("龙虎榜", "market"),
    "4_peers": ("同行对比", "chain"),
    "5_chain": ("产业链", "chain"),
    "7_industry": ("行业景气", "chain"),
    "8_materials": ("原材料", "chain"),
    "9_futures": ("期货关联", "chain"),
    "11_governance": ("治理/减持", "company"),
    "15_events": ("事件驱动", "company"),
    "6_research": ("券商研报", "company"),
    "3_macro": ("宏观环境", "macro"),
    "13_policy": ("政策与监管", "macro"),
    "17_sentiment": ("舆情", "safety"),
    "18_trap": ("杀猪盘", "safety"),
    "19_contests": ("实盘比赛", "safety"),
}

GROUP_ORDER: tuple[str, ...] = (
    "basic",
    "finance",
    "market",
    "chain",
    "company",
    "macro",
    "safety",
)

GROUP_LABELS: dict[str, str] = {
    "basic": "基础与共享",
    "finance": "财务与估值",
    "market": "行情与资金",
    "chain": "产业链与行业",
    "company": "公司治理与事件",
    "macro": "宏观与政策",
    "safety": "情绪与风险",
}

# 任何档位都跑（不受 analysis_profile 管辖，见 collect.py:212-216 _in_scope）
SHARED_DIMS: tuple[str, ...] = ("6_fund_holders", "similar_stocks")

# wave 3 串行、依赖 industry 的维度（collect.py:30）
DEPENDENT_DIMS: tuple[str, ...] = ("3_macro", "7_industry", "9_futures", "13_policy")

# analysis_profile.py:123-132 的 _CORE_FETCHERS（lite 档 7 维）
_LITE_GOVERNED: tuple[str, ...] = (
    "0_basic",
    "1_financials",
    "2_kline",
    "10_valuation",
    "11_governance",
    "15_events",
    "16_lhb",
)

# analysis_profile.py:123-132 的 _ALL_FETCHERS（medium/deep 档 20 维）
_MEDIUM_GOVERNED: tuple[str, ...] = (
    "0_basic",
    "1_financials",
    "2_kline",
    "3_macro",
    "4_peers",
    "5_chain",
    "6_research",
    "7_industry",
    "8_materials",
    "9_futures",
    "10_valuation",
    "11_governance",
    "12_capital_flow",
    "13_policy",
    "14_moat",
    "15_events",
    "16_lhb",
    "17_sentiment",
    "18_trap",
    "19_contests",
)

# ddgs 搜索预算上限（analysis_profile.py:146/166/190）
_DDG_BUDGET: dict[str, int] = {"lite": 0, "medium": 30, "deep": 60}


# ============================================================================
# 档位计划
# ============================================================================


@dataclass(frozen=True)
class DimPlan:
    """某个档位下「应该跑哪些维度」的权威答案。"""

    tier: str
    expected: tuple[str, ...]  # 本档位应上报结果的维度，按 DIM_META 顺序
    wave1: tuple[str, ...]
    wave2: tuple[str, ...]
    wave3: tuple[str, ...]
    skipped: tuple[str, ...]  # 本档不跑的（全量 22 - expected）
    ddg_budget: int

    @property
    def total(self) -> int:
        return len(self.expected)


def _ordered(keys: "set[str] | tuple[str, ...]") -> tuple[str, ...]:
    """按 DIM_META 的声明顺序排列，保证前端网格顺序稳定。"""
    allowed = set(keys)
    return tuple(k for k in DIM_META if k in allowed)


def plan_for(tier: str) -> DimPlan:
    """给定档位，算出期望维度与 wave 划分。未知档位按 medium 处理。"""
    t = (tier or "").strip().lower()
    governed = _MEDIUM_GOVERNED if t not in ("lite", "medium", "deep") else (
        _LITE_GOVERNED if t == "lite" else _MEDIUM_GOVERNED
    )
    expected = _ordered(set(governed) | set(SHARED_DIMS))
    w1 = tuple(k for k in expected if k == "0_basic")
    w3 = tuple(k for k in expected if k in DEPENDENT_DIMS)
    w2 = tuple(k for k in expected if k not in w1 and k not in w3)
    skipped = _ordered(set(DIM_META) - set(expected))
    return DimPlan(
        tier=t if t in _DDG_BUDGET else "medium",
        expected=expected,
        wave1=w1,
        wave2=w2,
        wave3=w3,
        skipped=skipped,
        ddg_budget=_DDG_BUDGET.get(t, 30),
    )


# ============================================================================
# 阶段表：7 行骨架，detail 与 skipped 全部由 DimPlan 派生
#
# 顺序即执行顺序。解析时「只前进不后退」——日志是流式追加的，
# 后出现的标记一定代表更靠后的阶段（UZI 不会回退）。
# ============================================================================


@dataclass(frozen=True)
class StageSpec:
    key: str
    label: str
    enter_re: str


STAGE_SPECS: tuple[StageSpec, ...] = (
    StageSpec("preflight", "环境自检与预检", r"深度分析引擎|速判模式|标准分析"),
    StageSpec("collect_w1", "采集基础数据", r"\[pipeline\]\s*wave\s*1"),
    StageSpec("collect_w2", "分维度并行采集", r"\[pipeline\]\s*wave\s*2"),
    StageSpec("collect_w3", "行业/宏观依赖维", r"\[pipeline\]\s*wave\s*3"),
    StageSpec("scoring", "维度打分与评委共识", r"raw_data\.json\s*已写|进入\s*scoring"),
    StageSpec("synthesize", "综合研判与报告组装", r"Task\s*4\s*·\s*综合研判"),
    StageSpec("render", "报告落盘与自检", r"Task\s*5\s*·\s*报告组装"),
)

_STAGE_KEYS: tuple[str, ...] = tuple(s.key for s in STAGE_SPECS)
_BY_KEY: dict[str, StageSpec] = {s.key: s for s in STAGE_SPECS}

# 全部阶段都跑完的标志
_DONE_RE = re.compile(r"Stage\s*2\s*完成|✅\s*完成!")


# ============================================================================
# 正则
# ============================================================================

_ANSI = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")

# 维度结果行。用 search 不用 match：`print(end="")` 会让前缀粘在行首。
# kind 三种：ok / error / timeout；key 允许非数字开头（similar_stocks）。
# 分隔符只能是 `\s+` 不能是 `\s{2,}`：collect.py:151 用 `{marker:7s}` 对齐，
# `ok` 后面补 5 个空格，但 `timeout` 本身 7 字符后面只有 1 个空格
# （实测 `    timeout similar_stocks       fetcher timeout > 120s`），
# 要求 ≥2 个空格会把这一整维漏掉。误匹配由下面的 `key in DIM_META` 兜住。
_DIM_ROW = re.compile(
    r"(?<![A-Za-z_])(?P<kind>ok|error|timeout)\s+(?P<key>[0-9a-z_]{3,24})\s+(?P<rest>\S.*)?$"
)

# banner 与用量信号
_RE_FETCHERS = re.compile(r"fetchers:\s*(\d+)/(\d+)\s*维")
_RE_REJUDGE = re.compile(r"评委:\s*(\d+)\s*位")
_RE_DDG_BUDGET = re.compile(r"ddgs\s*预算:\s*(\d+)")
_RE_MAX_WORKERS = re.compile(r"max_workers=(\d+)")
_RE_COLLECT_SEC = re.compile(r"\[pipeline\]\s*collect\s*完成\s*·\s*([\d.]+)s")
_RE_TRIM = re.compile(r"档位裁剪\s*·\s*跳过\s*(\d+)\s*维")
_RE_FORCE_ALL = re.compile(r"强制重抓所有\s*(\d+)\s*个\s*fetcher")
_RE_LOGIN = re.compile(r"login success", re.I)

_QUALITY_STATES = ("full", "partial", "missing")


def _dim_state(kind: str, rest: str) -> tuple[str, str]:
    """把一行维度结果翻译成 (state, note)。

    state 取值：full / partial / missing / error / timeout
    """
    rest = (rest or "").strip()
    if kind == "ok":
        first = rest.split()[0] if rest else ""
        if first in _QUALITY_STATES:
            return first, ""
        # 未知 quality：保守算 partial（能跑就有东西，但不敢说完整）
        return "partial", rest
    return kind, rest


# ============================================================================
# 解析
# ============================================================================

_CACHE: dict[str, tuple[int, int, dict]] = {}
_CACHE_MAX = 32


def clear_cache() -> None:
    _CACHE.clear()


def _cache_key(path: str) -> str:
    return os.path.abspath(path)


def _cache_get(path: str, size: int, mtime_ns: int) -> dict | None:
    hit = _CACHE.get(_cache_key(path))
    if hit and hit[0] == size and hit[1] == mtime_ns:
        return hit[2]
    return None


def _cache_put(path: str, size: int, mtime_ns: int, value: dict) -> None:
    if len(_CACHE) >= _CACHE_MAX:
        # 简单淘汰：丢掉最早插入的一半，不追求 LRU 精度
        for k in list(_CACHE)[: _CACHE_MAX // 2]:
            _CACHE.pop(k, None)
    _CACHE[_cache_key(path)] = (size, mtime_ns, value)


def _empty_result(tier: str, reason: str) -> dict:
    plan = plan_for(tier)
    return {
        "schema": SCHEMA_VERSION,
        "tier": plan.tier,
        "degraded": True,
        "degraded_reason": reason,
        "phase_key": "",
        "phase": "",
        "dim_states": {},
        "counts": {
            "expected": plan.total,
            "reported": 0,
            "full": 0,
            "partial": 0,
            "missing": 0,
            "error": 0,
            "timeout": 0,
            "pending": plan.total,
            "skipped": len(plan.skipped),
        },
        "usage": {
            "fetchers_declared": None,
            "fetchers_total": None,
            "max_workers": None,
            "source_logins": 0,
            "ddg_budget": plan.ddg_budget,
            "ddg_used": None,
            "collect_sec": None,
            "trimmed": None,
            "forced_all": None,
            "log_bytes": 0,
        },
        "log_live": False,
        "parsed_at": datetime.now().isoformat(timespec="seconds"),
    }


def parse_log(log_path: str, tier: str, *, force: bool = False) -> dict:
    """解析一份 UZI 日志。永不抛异常，失败返回 degraded 结果。"""
    plan = plan_for(tier)
    if not log_path:
        return _empty_result(tier, "no log_path")

    try:
        size = os.path.getsize(log_path)
        mtime_ns = os.stat(log_path).st_mtime_ns
    except OSError as e:
        return _empty_result(tier, f"stat failed: {e.__class__.__name__}")

    if not force:
        cached = _cache_get(log_path, size, mtime_ns)
        if cached is not None:
            return cached

    try:
        with open(log_path, "rb") as f:
            text = f.read().decode("utf-8", errors="ignore")
        result = _parse_text(text, plan)
        result["usage"]["log_bytes"] = size
        result["log_live"] = (time.time() - (mtime_ns / 1_000_000_000)) < 60
        result["parsed_at"] = datetime.now().isoformat(timespec="seconds")
    except Exception as e:  # noqa: BLE001 - 解析器绝不连坐上层
        logger.warning(f"[UZI进度] 解析日志失败 {log_path}: {e}")
        return _empty_result(tier, f"parse failed: {e.__class__.__name__}")

    _cache_put(log_path, size, mtime_ns, result)
    return result


def _parse_text(text: str, plan: DimPlan) -> dict:
    """纯函数：日志文本 → 结构化结果。单测直接喂字符串。"""
    dims: dict[str, tuple[str, str]] = {}
    stage_idx = -1
    usage: dict[str, "int | float | None"] = {
        "fetchers_declared": None,
        "fetchers_total": None,
        "max_workers": None,
        "source_logins": 0,
        "ddg_budget": plan.ddg_budget,
        "ddg_used": None,
        "collect_sec": None,
        "trimmed": None,
        "forced_all": None,
    }

    for line in _ANSI.sub("", text).split("\n"):
        if not line.strip():
            continue

        # ① 阶段：只前进不后退（修掉旧 _PHASE_HINTS「按元组顺序取最后命中」的错标）
        if stage_idx < len(STAGE_SPECS) - 1:
            for i in range(stage_idx + 1, len(STAGE_SPECS)):
                if re.search(STAGE_SPECS[i].enter_re, line):
                    stage_idx = i
                    break

        # ② 维度结果行（非锚定，容忍行首粘连）
        m = _DIM_ROW.search(line)
        if m:
            key = m.group("key")
            if key in DIM_META:
                state, note = _dim_state(m.group("kind"), m.group("rest") or "")
                # 同一维度后出现的行覆盖先出现的（重跑场景）
                dims[key] = (state, note)
            continue

        # ③ 用量信号
        if m2 := _RE_FETCHERS.search(line):
            usage["fetchers_declared"] = int(m2.group(1))
            usage["fetchers_total"] = int(m2.group(2))
        if m3 := _RE_DDG_BUDGET.search(line):
            usage["ddg_budget"] = int(m3.group(1))
        if m4 := _RE_MAX_WORKERS.search(line):
            usage["max_workers"] = int(m4.group(1))
        if m5 := _RE_COLLECT_SEC.search(line):
            usage["collect_sec"] = float(m5.group(1))
        if m6 := _RE_TRIM.search(line):
            usage["trimmed"] = int(m6.group(1))
        if m7 := _RE_FORCE_ALL.search(line):
            usage["forced_all"] = int(m7.group(1))
        if _RE_LOGIN.search(line):
            usage["source_logins"] = int(usage["source_logins"] or 0) + 1

    # 日志里出现了"完成"标记 ⇒ 全部阶段收尾
    finished = bool(_DONE_RE.search(_ANSI.sub("", text)))

    # 只统计本档位的维度；日志里出现但不在 expected 的（理论上不该有）忽略
    expected_set = set(plan.expected)
    kept = {k: v for k, v in dims.items() if k in expected_set}

    counts = {
        "expected": plan.total,
        "reported": len(kept),
        "full": sum(1 for v in kept.values() if v[0] == "full"),
        "partial": sum(1 for v in kept.values() if v[0] == "partial"),
        "missing": sum(1 for v in kept.values() if v[0] == "missing"),
        "error": sum(1 for v in kept.values() if v[0] == "error"),
        "timeout": sum(1 for v in kept.values() if v[0] == "timeout"),
        "pending": max(0, plan.total - len(kept)),
        "skipped": len(plan.skipped),
    }

    phase_key = _STAGE_KEYS[stage_idx] if stage_idx >= 0 else ""
    return {
        "schema": SCHEMA_VERSION,
        "tier": plan.tier,
        "degraded": False,
        "degraded_reason": "",
        "phase_key": phase_key,
        "phase": _BY_KEY[phase_key].label if phase_key else "",
        "dim_states": kept,
        "counts": counts,
        "usage": usage,
        "finished_marker": finished,
    }


# ============================================================================
# 组装
# ============================================================================


def _build_stages(plan: DimPlan, parsed: dict) -> list[dict]:
    """7 行阶段列表：状态 + detail。全部由 plan 与解析结果派生。"""
    dims: dict[str, tuple[str, str]] = parsed.get("dim_states") or {}
    phase_key = parsed.get("phase_key") or ""
    finished = bool(parsed.get("finished_marker"))
    cur_idx = _STAGE_KEYS.index(phase_key) if phase_key in _STAGE_KEYS else -1

    def done_count(keys: tuple[str, ...]) -> int:
        return sum(1 for k in keys if k in dims)

    rows: list[dict] = []
    for i, spec in enumerate(STAGE_SPECS):
        # 本档位不跑的阶段直接 skipped
        stage_dims = {
            "collect_w1": plan.wave1,
            "collect_w2": plan.wave2,
            "collect_w3": plan.wave3,
        }.get(spec.key)

        if stage_dims is not None and not stage_dims:
            rows.append(
                {
                    "key": spec.key,
                    "label": spec.label,
                    "status": "skipped",
                    "detail": "本档无需",
                }
            )
            continue

        if finished or (cur_idx >= 0 and i < cur_idx):
            status = "done"
        elif i == cur_idx:
            status = "running"
        else:
            status = "pending"

        detail = ""
        if spec.key in ("collect_w1", "collect_w2", "collect_w3"):
            detail = f"{done_count(stage_dims)}/{len(stage_dims)}"
            # 采集整段的耗时挂在 wave3 这一行（lite 的 wave3 是 skipped，不显示）
            if spec.key == "collect_w3" and parsed["usage"].get("collect_sec"):
                detail += f" · {parsed['usage']['collect_sec']:.0f}s"
        elif spec.key == "scoring":
            detail = f"采集上报 {parsed['counts']['reported']}/{plan.total}（含取空）"

        rows.append(
            {"key": spec.key, "label": spec.label, "status": status, "detail": detail}
        )
    return rows


def build_progress(job: dict) -> dict:
    """把 `uzi_jobs._row_to_dict()` 的产物组装成前端 UziProgress。

    job 里只需要 `log_path` 与 `tier`；其它字段不影响进度。
    """
    log_path = (job or {}).get("log_path") or ""
    tier = (job or {}).get("tier") or "medium"
    plan = plan_for(tier)
    parsed = parse_log(log_path, tier)

    dims: dict[str, tuple[str, str]] = parsed.get("dim_states") or {}
    items: list[dict] = []
    for key in DIM_META:
        label, group = DIM_META[key]
        if key in dims:
            state, note = dims[key]
        elif key in plan.skipped:
            state, note = "skipped", ""
        else:
            state, note = "pending", ""
        items.append(
            {
                "key": key,
                "label": label,
                "group": group,
                "state": state,
                "note": (note or "")[:120],
            }
        )

    usage = dict(parsed.get("usage") or {})
    usage["fetchers_expected"] = plan.total
    usage["ddg_used"] = None  # UZI 从不打印真实消耗，只报上限，绝不做假数

    # 日志 mtime 的 60s 窗口本是为「服务重启、父进程丢了但子进程还在写」准备的；
    # 已收尾（success/failed）的作业日志不可能再增长，别报「日志仍在更新」误导人。
    status = str((job or {}).get("status") or "")
    log_live = bool(parsed.get("log_live")) and status not in ("success", "failed")

    return {
        "schema": SCHEMA_VERSION,
        "tier": plan.tier,
        "degraded": bool(parsed.get("degraded")),
        "degraded_reason": parsed.get("degraded_reason") or "",
        "stages": _build_stages(plan, parsed),
        "current_stage": parsed.get("phase_key") or None,
        "dims": {**parsed.get("counts", {}), "items": items},
        "usage": usage,
        "log_live": log_live,
        "parsed_at": parsed.get("parsed_at") or "",
    }


def summary(log_path: str, tier: str = "medium") -> dict:
    """瘦接口：给 `uzi_jobs._log_progress()` 用的 {done_dims, phase}。

    `done_dims` 的口径从旧的「64KB 尾窗内去重的 ok 行数」变成「全量已上报维数」
    （含 error/timeout）。只增不减，不会让旧 UI 倒退。
    """
    parsed = parse_log(log_path, tier)
    return {
        "done_dims": int((parsed.get("counts") or {}).get("reported") or 0),
        "phase": parsed.get("phase") or "",
    }

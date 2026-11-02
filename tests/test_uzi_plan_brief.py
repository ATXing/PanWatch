"""UZI「作战计划」落库口径的回归测试（2026-11-03）。

背景：
1) 用户看到「UZI 报告详情里基本面 66.3，股票详情页 UZI 调研结果 68」。
   两者不是同一个数：68 是 PanWatch 的实测口径 real_score（只算有真实数据的维度），
   66.3 是 UZI 官方基本面分；而库里原先存的是 dimensions 的 66.6（未过风格加权），
   既跟报告原文差 0.3，也跟 uzi_overall 的 0.6/0.4 公式对不上（66.6×0.6+52.3×0.4=60.9≠60.7）。
   → 基本面分改为 synthesis 优先、dimensions 兜底。

2) 面板要新出「作战计划」一块（入场/仓位/止损/目标 + 四流派买点 + 退出条件），
   数据从 synthesis.json 抽。UZI 的 buy_zones / exit_triggers 一贯不采信，只做可读展示，
   缺字段宁可整块不渲染也不填占位。
"""

from __future__ import annotations

from src.modules.research.uzi_sync import _plan_brief, _resolve_fundamental_score

FULL_SYNTH = {
    "fundamental_score": 66.3,
    "overall_score": 60.7,
    "dashboard": {
        "core_conclusion": "紫金矿业 · 60 分 · 观望偏多",
        "battle_plan": {
            "entry": "¥24.69",
            "position": "分批建仓 · 勿满仓",
            "stop": "¥22.81",
            "target": "¥33.55",
        },
        "data_perspective": {"trend": "Stage 1 底部", "price": "¥26.84"},
    },
    "buy_zones": {
        "value": {"price": 22.81, "rationale": "历史 PE 25 分位"},
        "growth": {"price": 24.69, "rationale": "PEG 合理区"},
        "technical": {"price": 25.5, "rationale": "MA60 支撑位"},
        "youzi": {"price": 26.84, "rationale": "当前情绪未破"},
    },
    "friendly": {
        "scenarios": {
            "entry_price": 26.84,
            "cases": [
                {"name": "最坏情况", "probability": "5%", "return": -90.8},
                {"name": "合理情况", "probability": "40%", "return": 15.0},
            ],
        },
        "exit_triggers": [
            "股价跌破 ¥23.62（当前价 -12%）→ 无条件止损",
            "PE 站上 5 年 15 分位 → 泡沫区获利了结",
        ],
    },
}


def test_plan_brief_extracts_full_plan():
    p = _plan_brief(FULL_SYNTH)
    assert p is not None
    assert p["battle_plan"] == {
        "entry": "¥24.69",
        "position": "分批建仓 · 勿满仓",
        "stop": "¥22.81",
        "target": "¥33.55",
    }
    assert [z["school"] for z in p["buy_zones"]] == ["value", "growth", "technical", "youzi"]
    assert p["buy_zones"][0]["price"] == 22.81
    assert p["buy_zones"][0]["rationale"] == "历史 PE 25 分位"
    assert len(p["exit_triggers"]) == 2
    assert p["scenarios"]["entry_price"] == 26.84
    assert len(p["scenarios"]["cases"]) == 2
    assert p["core_conclusion"].startswith("紫金矿业")


def test_plan_brief_drops_placeholder_prices():
    """买点价格是占位符（—/-/n/a）时不该渲染成「价值 ¥—」。"""
    synth = {
        "dashboard": {"battle_plan": {"entry": "¥10.00"}},
        "buy_zones": {
            "value": {"price": "—", "rationale": "缺数据"},
            "growth": {"price": 9.5, "rationale": "PEG 合理区"},
        },
    }
    p = _plan_brief(synth)
    assert [z["school"] for z in p["buy_zones"]] == ["growth"]
    assert p["exit_triggers"] == []
    assert p["scenarios"]["cases"] == []


def test_plan_brief_returns_none_when_empty():
    """老报告没有 dashboard / buy_zones → 不写库，前端整块不渲染（不造数）。"""
    assert _plan_brief({}) is None
    assert _plan_brief({"friendly": {"exit_triggers": []}}) is None
    assert _plan_brief(None) is None  # type: ignore[arg-type]


def test_plan_brief_keeps_plan_without_exits():
    """只有 battle_plan、没有退出条件也要保留（止损/目标本身就是操作信息）。"""
    p = _plan_brief({"dashboard": {"battle_plan": {"stop": "¥8.00"}}})
    assert p is not None
    assert p["battle_plan"]["stop"] == "¥8.00"
    assert p["exit_triggers"] == []


def test_fundamental_score_prefers_synthesis():
    """综合分是 0.6×synthesis基本面+0.4×共识，所以存 synthesis 那份才对得上。"""
    assert _resolve_fundamental_score({"fundamental_score": 66.3}, 66.6) == 66.3
    # 缺 synthesis 或值非法 → 退回 dimensions
    assert _resolve_fundamental_score({}, 66.6) == 66.6
    assert _resolve_fundamental_score({"fundamental_score": None}, 66.6) == 66.6
    assert _resolve_fundamental_score({"fundamental_score": "66.3"}, 66.6) == 66.6
    assert _resolve_fundamental_score({"fundamental_score": True}, 66.6) == 66.6
    # 四舍五入到 1 位，与报告原文一致
    assert _resolve_fundamental_score({"fundamental_score": 66.349}, 0) == 66.3


def test_fundamental_consistency_with_overall():
    """回归：用存下来的基本面分反算综合分，必须能对上 uzi_overall（±0.05）。"""
    fund = _resolve_fundamental_score(FULL_SYNTH, 66.6)
    consensus = 52.3
    assert abs(round(fund * 0.6 + consensus * 0.4, 2) - 60.7) < 0.05

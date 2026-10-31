"""候选池 K 线新鲜度：不许把「抄写的日期」当成指标的新鲜度。

背景：机会页出现「买入」而详情页技术指标是「观望」，根因是历史补全把上一天的
meta.kline 原样抄进当天新行，snapshot_date 天天变、指标却一字未改（实测 601127
的「多头排列 / 金叉 / 量比 0.5439…」从 10-19 挂到 10-27），旧 action 又覆盖了
本轮算出的决策。
"""
from __future__ import annotations

from datetime import date

from src.modules.strategy.entry_candidates import (
    KLINE_ASOF_FIELD,
    KLINE_FETCHED_FIELD,
    _derive_market_scan_decision,
    _kline_origin_day,
    _resolve_seeded_decision,
)

BULL_KLINE = {
    "trend": "多头排列",
    "macd_cross": "金叉",
    "rsi_status": "中性",
    "kdj_status": "死叉",
    "volume_ratio": 0.5439061692447406,
    "support": 43.61,
    "resistance": 54.0,
}
BEAR_KLINE = {
    "trend": "空头排列",
    "macd_cross": "死叉",
    "rsi_status": "中性",
    "kdj_status": "金叉",
    "volume_ratio": 0.32,
    "support": 40.21,
    "resistance": 54.0,
}


class Row:
    def __init__(self, snapshot_date: str, meta: dict):
        self.snapshot_date = snapshot_date
        self.meta = meta


def _legacy(day: str, kline: dict, fallback_id: int | None = None) -> Row:
    meta = {"kline": kline}
    if fallback_id is not None:
        meta["source_meta"] = {"source": "market_scan_history", "fallback_candidate_id": fallback_id}
    return Row(day, meta)


def test_origin_traces_copied_kline_back_to_first_day():
    """同一份 kline 被抄了 9 天，采集日应是第一天，不是最后一天。"""
    siblings = [_legacy(day, BULL_KLINE) for day in (
        "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-23", "2026-10-25", "2026-10-26", "2026-10-27",
    )]
    assert _kline_origin_day(siblings[-1], siblings) == date(2026, 10, 19)


def test_origin_uses_explicit_fetch_day_when_present():
    """新数据写了真实采集日就照它算，不能再被同内容的旧行拖回去。"""
    fresh = Row("2026-10-27", {"kline": BEAR_KLINE, KLINE_FETCHED_FIELD: "2026-10-27"})
    siblings = [_legacy("2026-10-19", BEAR_KLINE), fresh]
    assert _kline_origin_day(fresh, siblings) == date(2026, 10, 27)


def test_origin_prefers_own_fetch_day_over_older_siblings():
    row = Row("2026-10-27", {"kline": BEAR_KLINE, KLINE_FETCHED_FIELD: "2026-10-27"})
    older = Row("2026-10-25", {"kline": BULL_KLINE, KLINE_FETCHED_FIELD: "2026-10-25"})
    assert _kline_origin_day(row, [older, row]) == date(2026, 10, 27)


def test_origin_ignores_cross_symbol_fallback_reference():
    """fallback_candidate_id 实测会跨 symbol，链条断了也不能把日期判成「昨天」。"""
    siblings = [
        _legacy("2026-10-19", BULL_KLINE),
        _legacy("2026-10-26", BULL_KLINE, fallback_id=1049),  # 1049 属于另一只票
        _legacy("2026-10-27", BULL_KLINE, fallback_id=1052),
    ]
    assert _kline_origin_day(siblings[-1], siblings) == date(2026, 10, 19)


def test_stale_seed_action_cannot_override_a_fresh_decision():
    """K 线不是当日的，就不许拿旧候选的「建仓」覆盖本轮算出的结论。"""
    decision = _derive_market_scan_decision(
        {"current_price": 42.22, "change_pct": -0.94}, BEAR_KLINE
    )
    resolved = _resolve_seeded_decision(
        seeded_action="buy",
        seeded_label="建仓",
        seeded_signal="趋势延续，MACD金叉",
        seeded_reason="均线多头排列，MACD金叉",
        seeded_tags=["trend_follow", "macd_golden"],
        decision=decision,
        kline_is_today=False,
    )
    assert resolved["action"] == decision["action"] == "avoid"
    assert resolved["action_label"] == "回避"
    assert "trend_follow" not in resolved["strategy_tags"]


def test_same_day_seed_action_is_still_honoured():
    decision = _derive_market_scan_decision(
        {"current_price": 42.22, "change_pct": -0.94}, BULL_KLINE
    )
    resolved = _resolve_seeded_decision(
        seeded_action="buy",
        seeded_label="建仓",
        seeded_signal="趋势延续，MACD金叉",
        seeded_reason="均线多头排列，MACD金叉",
        seeded_tags=["trend_follow", "macd_golden"],
        decision=decision,
        kline_is_today=True,
    )
    assert resolved["action"] == "buy"
    assert resolved["action_label"] == "建仓"


def test_decision_without_seed_uses_kline_maths():
    decision = _derive_market_scan_decision(
        {"current_price": 42.22, "change_pct": -0.94}, BEAR_KLINE
    )
    resolved = _resolve_seeded_decision(
        seeded_action="",
        seeded_label="",
        seeded_signal="",
        seeded_reason="",
        seeded_tags=None,
        decision=decision,
        kline_is_today=True,
    )
    assert resolved["action"] == "avoid"


def test_meta_keys_are_named_explicitly():
    """字段名被下游读，改名必须同步改这里。"""
    assert KLINE_ASOF_FIELD == "kline_asof"
    assert KLINE_FETCHED_FIELD == "kline_fetched_on"

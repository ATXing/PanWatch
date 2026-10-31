"""机会页要能标出「这条信号的技术指标基于哪天的 K 线」。

信号是候选快照那一刻算的，K 线可能已经落后几天。为了让页面能标日期，
`_format_signal` 必须**两种模式**都带上 `kline_asof`：
- include_payload=True（详情用完整 payload）
- include_payload=False（列表用的轻量模式，机会页走这条）

轻量模式会把 payload 压成固定字段表，很容易漏——所以这里钉死。
"""

from datetime import datetime
from types import SimpleNamespace

from src.modules.strategy.strategy_engine import _compact_signal_payload, _format_signal


def _row(**overrides):
    base = dict(
        id=1,
        snapshot_date="2026-10-27",
        stock_symbol="00941",
        stock_market="HK",
        stock_name="中国移动",
        strategy_code="trend_follow",
        strategy_name="趋势延续",
        strategy_version="v1",
        risk_level="medium",
        source_pool="market_scan",
        score=88.0,
        rank_score=88.0,
        confidence=0.9,
        status="active",
        action="buy",
        action_label="建仓",
        signal="均线多头",
        reason="MACD 金叉",
        evidence=[],
        holding_days=3,
        entry_low=80.0,
        entry_high=82.0,
        stop_loss=75.0,
        target_price=95.0,
        invalidation="跌破 75",
        plan_quality=90,
        source_agent="market_scan",
        source_suggestion_id=None,
        source_candidate_id=42,
        trace_id="",
        is_holding_snapshot=False,
        context_quality_score=None,
        payload={
            "entry_candidate_id": 42,
            "kline_asof": "2026-10-23",
            "kline_fetched_on": "2026-10-23",
            "score_breakdown": {"weighted_score": 88.0},
            "source_meta": {"source": "market_scan_history"},
        },
        created_at=datetime(2026, 10, 27, 1, 0, 0),
        updated_at=datetime(2026, 10, 27, 1, 0, 0),
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def test_lightweight_list_mode_keeps_kline_asof():
    item = _format_signal(_row(), include_payload=False)
    assert item["kline_asof"] == "2026-10-23"
    assert item["kline_fetched_on"] == "2026-10-23"
    # 轻量模式拍平了 payload，但顶层字段必须还在
    assert item["payload"] == {}


def test_full_mode_keeps_kline_asof_in_both_places():
    item = _format_signal(_row(), include_payload=True)
    assert item["kline_asof"] == "2026-10-23"
    assert item["payload"]["kline_asof"] == "2026-10-23"


def test_missing_kline_is_empty_string_not_null():
    item = _format_signal(_row(payload={"entry_candidate_id": 42}), include_payload=True)
    assert item["kline_asof"] == ""


def test_compact_payload_survives_whitelist():
    compact = _compact_signal_payload({"kline_asof": "2026-10-22", "kline_fetched_on": "2026-10-22"})
    assert compact["kline_asof"] == "2026-10-22"

"""A failing research run must not be retried on an unchanged configuration forever."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from src.modules.research.orchestration import service
from src.modules.research.orchestration.breaker import ResearchBreaker, fingerprint
from src.platform.marketdata.models import MarketCode

SCOPE = "scope-1"


def make_breaker(threshold=3, cooldown_minutes=60):
    now = [0.0]
    gate = ResearchBreaker(threshold=threshold, cooldown_minutes=cooldown_minutes, clock=lambda: now[0])
    return gate, now


def test_identical_failures_trip_after_threshold():
    gate, now = make_breaker()
    gate.record("premarket_outlook", SCOPE, "fp-a", "budget_exhausted")
    gate.record("premarket_outlook", SCOPE, "fp-a", "validation_failed")
    assert gate.check("premarket_outlook", SCOPE, "fp-a") is None

    gate.record("premarket_outlook", SCOPE, "fp-a", "timeout")
    trip = gate.check("premarket_outlook", SCOPE, "fp-a")
    assert trip is not None
    assert trip["failures"] == 3
    assert trip["completions"] == ["budget_exhausted", "validation_failed", "timeout"]
    assert trip["retry_after_seconds"] == 3600
    assert now[0] == 0.0  # check() must not move the clock


def test_completion_resets_the_counter():
    gate, _ = make_breaker()
    for completion in ("budget_exhausted", "timeout", "validation_failed"):
        gate.record("premarket_outlook", SCOPE, "fp-a", completion)
    assert gate.check("premarket_outlook", SCOPE, "fp-a") is not None

    # A run that actually finished proves the pipeline works; the next failure starts at one.
    gate.record("premarket_outlook", SCOPE, "fp-a", "complete")
    assert gate.check("premarket_outlook", SCOPE, "fp-a") is None
    gate.record("premarket_outlook", SCOPE, "fp-a", "timeout")
    gate.record("premarket_outlook", SCOPE, "fp-a", "timeout")
    assert gate.check("premarket_outlook", SCOPE, "fp-a") is None
    gate.record("premarket_outlook", SCOPE, "fp-a", "timeout")
    assert gate.check("premarket_outlook", SCOPE, "fp-a") is not None


def test_gate_skip_is_not_a_failure():
    gate, _ = make_breaker(threshold=1)
    gate.record("intraday_monitor", SCOPE, "fp-b", "skipped")
    assert gate.check("intraday_monitor", SCOPE, "fp-b") is None
    assert gate.snapshot() == {}


def test_config_edit_reopens_the_gate():
    gate, _ = make_breaker()
    for _ in range(3):
        gate.record("premarket_outlook", SCOPE, "fp-old", "budget_exhausted")
    assert gate.check("premarket_outlook", SCOPE, "fp-old") is not None

    # Raising max_output_tokens changes the fingerprint, so the retry is legitimate again.
    assert gate.check("premarket_outlook", SCOPE, "fp-new") is None
    gate.record("premarket_outlook", SCOPE, "fp-new", "budget_exhausted")
    assert gate.check("premarket_outlook", SCOPE, "fp-new") is None


def test_cooldown_expiry_reopens_the_gate():
    gate, now = make_breaker(cooldown_minutes=60)
    for _ in range(3):
        gate.record("daily_report", SCOPE, "fp-c", "timeout")
    assert gate.check("daily_report", SCOPE, "fp-c") is not None

    now[0] = 3599.0
    assert gate.check("daily_report", SCOPE, "fp-c") is not None
    now[0] = 3600.0
    assert gate.check("daily_report", SCOPE, "fp-c") is None
    # Expiry clears the state instead of leaving a stale trip behind.
    assert gate.snapshot() == {}


def test_agents_do_not_share_state():
    gate, _ = make_breaker(threshold=1)
    gate.record("premarket_outlook", SCOPE, "fp-d", "failed")
    assert gate.check("premarket_outlook", SCOPE, "fp-d") is not None
    assert gate.check("daily_report", SCOPE, "fp-d") is None


def test_one_failing_symbol_cannot_silence_the_watchlist():
    """Single-stock intraday runs share an agent name but must not share a counter."""
    gate, _ = make_breaker()
    for _ in range(3):
        gate.record("intraday_monitor", "scope-600519", "fp-e", "failed")
    assert gate.check("intraday_monitor", "scope-600519", "fp-e") is not None
    assert gate.check("intraday_monitor", "scope-000858", "fp-e") is None


def test_fingerprint_tracks_config_content_not_order():
    assert fingerprint({"a": 1, "b": 2}) == fingerprint({"b": 2, "a": 1})
    assert fingerprint({"a": 1}) != fingerprint({"a": 2})
    assert fingerprint(None) == fingerprint({})


def test_execute_refuses_before_creating_a_run(monkeypatch):
    """A tripped gate must not reach the graph, the database, or the model."""
    gate, _ = make_breaker()
    monkeypatch.setattr(service, "BREAKER", gate)
    monkeypatch.setattr(service, "fingerprint", lambda config: "same")
    started = AsyncMock(side_effect=AssertionError("a tripped gate must not start a run"))
    monkeypatch.setattr(service.repository, "start", started)

    agent = SimpleNamespace(name="premarket_outlook", display_name="盘前分析")
    context = SimpleNamespace(
        watchlist=[SimpleNamespace(symbol="600519", market=MarketCode.CN)],
        _trace_id="test-breaker",
    )
    config = {"template": "premarket_balanced"}
    # Trip the exact scope the service derives, then confirm nothing downstream runs.
    import hashlib
    import json
    keys = sorted([f"{MarketCode.CN.value}:600519"])
    scope = hashlib.sha256(json.dumps(keys).encode()).hexdigest()
    for _ in range(3):
        gate.record("premarket_outlook", scope, "same", "budget_exhausted")

    result = asyncio.run(service.execute(agent, context, config))

    assert result.raw_data["skipped"] is True
    assert result.raw_data["breaker"]["failures"] == 3
    assert "暂停重试" in result.content
    started.assert_not_awaited()

"""Stop an agent that keeps ending in the same non-complete state.

A research graph that already stopped on ``budget_exhausted`` / ``validation_failed``
/ ``timeout`` does not finish on an identical third attempt, yet every attempt pays
for a full context window. On 2026-10-27 twelve consecutive premarket runs spent
~3.86M tokens and eleven of them stopped on the same three faults; the single
completion only arrived after the reporting schema itself was repaired.

The breaker therefore counts *consecutive* non-complete runs per agent **and** per
target scope **and** per effective-policy fingerprint:

* identical repeat runs trip it after ``TRIP_AFTER`` failures, and every further
  attempt inside the cooldown is refused before a run row or a model call exists;
* the counter is scoped to the analysed stock set, so one symbol that keeps failing
  in single-stock intraday mode cannot silence monitoring for the whole watchlist;
* any configuration edit (output budget, specialists, model, debate) changes the
  fingerprint and re-opens the gate at once, because the honest reason a retry may
  now work is that something actually changed;
* ``skipped`` is a normal gate verdict ("no material change") and always resets the
  counter -- it must never be mistaken for a failure.

State is process-local on purpose: a restart is the other honest signal that the
deployment changed. Nothing here is persisted, so a stale trip cannot outlive the
conditions that produced it.
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

#: Completions that mean "the graph gave up", not "the market had nothing to say".
FAILED_COMPLETIONS: frozenset[str] = frozenset(
    {"budget_exhausted", "validation_failed", "timeout", "failed"}
)

#: Two failures may be bad luck (a wedged provider, a truncated reply); three in a
#: row on the same configuration is a defect and repeating it only buys the same error.
TRIP_AFTER = 3

#: Long enough to stop a retry loop, short enough that an unattended fix resumes by itself.
COOLDOWN_MINUTES = 60


@dataclass
class _State:
    fingerprint: str
    failures: int = 0
    completions: list[str] = field(default_factory=list)
    tripped_at: float | None = None


class ResearchBreaker:
    """In-process consecutive-failure gate for scheduled research runs."""

    def __init__(
        self,
        threshold: int = TRIP_AFTER,
        cooldown_minutes: int = COOLDOWN_MINUTES,
        clock=time.monotonic,
    ):
        self.threshold = max(1, int(threshold))
        self.cooldown_seconds = max(0, int(cooldown_minutes)) * 60
        self._clock = clock
        self._states: dict[tuple[str, str], _State] = {}

    def check(self, agent_name: str, scope: str, fingerprint_value: str) -> dict | None:
        """Return trip details when this attempt must be refused, else ``None``."""
        key = (agent_name, scope)
        state = self._states.get(key)
        if state is None or state.fingerprint != fingerprint_value or state.tripped_at is None:
            return None
        elapsed = self._clock() - state.tripped_at
        if elapsed >= self.cooldown_seconds:
            # Cooldown expired; drop the state so the next run starts from a clean slate.
            self._states.pop(key, None)
            return None
        return {
            "agent_name": agent_name,
            "failures": state.failures,
            "completions": list(state.completions),
            "retry_after_seconds": int(self.cooldown_seconds - elapsed),
        }

    def record(self, agent_name: str, scope: str, fingerprint_value: str, completion: str) -> None:
        """Feed one finished run back into the counter."""
        key = (agent_name, scope)
        if completion not in FAILED_COMPLETIONS:
            # A completion (or a gate ``skipped``) proves the pipeline works again.
            self._states.pop(key, None)
            return
        state = self._states.get(key)
        if state is None or state.fingerprint != fingerprint_value:
            state = _State(fingerprint=fingerprint_value)
            self._states[key] = state
        state.failures += 1
        state.completions = (state.completions + [completion])[-self.threshold:]
        if state.failures >= self.threshold and state.tripped_at is None:
            state.tripped_at = self._clock()
            logger.warning(
                "[熔断] %s 连续 %s 轮未完成（%s），暂停重试 %s 分钟：相同的配置重跑只会复现同一个错误",
                agent_name,
                state.failures,
                " / ".join(state.completions),
                self.cooldown_seconds // 60,
            )

    def reset(self, agent_name: str | None = None, scope: str | None = None) -> None:
        if agent_name is None:
            self._states.clear()
            return
        for key in [k for k in self._states if k[0] == agent_name and (scope is None or k[1] == scope)]:
            self._states.pop(key, None)

    def snapshot(self) -> dict[str, dict]:
        now = self._clock()
        return {
            f"{agent}:{scope[:12]}": {
                "fingerprint": state.fingerprint,
                "failures": state.failures,
                "completions": list(state.completions),
                "tripped": state.tripped_at is not None,
                "retry_after_seconds": (
                    max(0, int(self.cooldown_seconds - (now - state.tripped_at)))
                    if state.tripped_at is not None
                    else 0
                ),
            }
            for (agent, scope), state in self._states.items()
        }


def fingerprint(config) -> str:
    """Stable digest of the effective policy, so any real edit re-opens the gate."""
    try:
        payload = json.dumps(config or {}, sort_keys=True, ensure_ascii=False, default=str)
    except (TypeError, ValueError):  # pragma: no cover - defensive, config is JSON-ish
        payload = str(config)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


#: Shared gate for every workflow agent (premarket / intraday / postmarket).
BREAKER = ResearchBreaker()

"""uzi_progress 解析器回归测试。

三份 fixture 都是从 `data/uzi_jobs/` 拷出来的**真实日志**（脱敏只涉及 ticker 已公开），
覆盖三类关键形态：

- `lite_600276_ok_with_timeout.log`：lite 9 维，其中 `similar_stocks` 是 **timeout**
- `medium_688363_full.log`：medium 22 维全齐、无 timeout
- `medium_02331_hk_mixed.log`：港股，含 2 timeout + 3 missing

守住五条边界（都是真实踩到的）：
1. `similar_stocks` 不能被漏 —— 它不以数字开头，且 timeout 行只有 1 个空格间隔；
2. `ok` 行 ≠ 成功 —— 第三列 quality 可能是 missing；
3. tier 决定期望维度数（lite 9 / medium 22），且不读日志里那句「wave 3 · 4 fetcher」；
4. 截断/追加日志都不能让计数倒退或抛异常；
5. 阶段必须按日志出现顺序推进，不能被关键词表顺序带偏。
"""

from __future__ import annotations

import io
import os
import time

import pytest

from src.modules.research import uzi_progress as P

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures", "uzi")
LITE = os.path.join(FIXTURES, "lite_600276_ok_with_timeout.log")
MEDIUM = os.path.join(FIXTURES, "medium_688363_full.log")
MEDIUM_HK = os.path.join(FIXTURES, "medium_02331_hk_mixed.log")


@pytest.fixture(autouse=True)
def _clear():
    P.clear_cache()
    yield
    P.clear_cache()


def _read(path: str) -> str:
    with io.open(path, encoding="utf-8", errors="ignore") as f:
        return f.read()


def _write(path, text: str) -> str:
    with io.open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return str(path)


# ---------------------------------------------------------------- 档位计划


def test_plan_lite_is_nine_dims():
    """lite = 7 个受管辖维度 + 2 个共享维度（6_fund_holders / similar_stocks）。"""
    plan = P.plan_for("lite")
    assert plan.total == 9
    assert "similar_stocks" in plan.expected
    assert "6_fund_holders" in plan.expected
    assert len(plan.wave1) == 1
    assert plan.wave3 == ()  # lite 不跑依赖维
    assert len(plan.wave2) == 8


def test_plan_medium_is_twenty_two_dims():
    plan = P.plan_for("medium")
    assert plan.total == 22
    assert len(plan.wave3) == 4
    assert len(plan.wave2) == 17  # 22 - 1(wave1) - 4(wave3)，与日志里那句一致
    assert plan.skipped == ()


def test_plan_unknown_tier_falls_back_to_medium():
    plan = P.plan_for("deep")  # 未开放，但口径与 medium 同
    assert plan.total == 22
    assert plan.tier == "deep"
    assert P.plan_for("garbage").tier == "medium"


# ---------------------------------------------------------------- 维度解析


def test_lite_parses_all_nine_including_timeout_dim():
    """similar_stocks 是 timeout 行、且 `timeout` 后只有 1 个空格，最容易漏。"""
    r = P.parse_log(LITE, "lite", force=True)
    c = r["counts"]
    assert c["reported"] == 9
    assert c["expected"] == 9
    assert r["dim_states"]["similar_stocks"][0] == "timeout"
    assert "timeout" in r["dim_states"]["similar_stocks"][1].lower()


def test_medium_parses_all_twenty_two():
    r = P.parse_log(MEDIUM, "medium", force=True)
    assert r["counts"]["reported"] == 22
    assert r["counts"]["pending"] == 0
    assert set(P.plan_for("medium").expected) == set(r["dim_states"])


def test_ok_with_missing_quality_is_not_green():
    """`ok similar_stocks missing` 必须落到 missing，不能算成功。"""
    r = P.parse_log(MEDIUM_HK, "medium", force=True)
    assert r["dim_states"]["similar_stocks"][0] == "missing"
    assert r["counts"]["missing"] >= 1
    assert r["counts"]["timeout"] >= 1


def test_quality_three_states_are_split():
    """full / partial / missing 三种 quality 都要能识别，且互不混淆。"""
    r = P.parse_log(MEDIUM, "medium", force=True)
    c = r["counts"]
    assert c["full"] + c["partial"] + c["missing"] == c["reported"]
    assert c["full"] >= 1 and c["partial"] >= 1


# ---------------------------------------------------------------- 阶段推进


def test_phase_follows_log_order_not_keyword_table_order():
    """跑到 Task 5 时不能还停在 wave 段（旧实现在这里会错标成「内联资源」）。"""
    r = P.parse_log(MEDIUM, "medium", force=True)
    assert r["phase_key"] == "render"
    assert r["phase"] == "报告落盘与自检"


def test_phase_mid_stream_is_scoring_after_raw_data_written():
    """collect 刚结束、Task 4 还没打印时，阶段应是 scoring 而不是 wave 3。"""
    text = _read(MEDIUM)
    cut = text.find("Task 4")
    assert cut > 0
    tmp = os.path.join(FIXTURES, "_tmp_mid.log")
    try:
        path = _write(tmp, text[:cut])
        r = P.parse_log(path, "medium", force=True)
        assert r["phase_key"] == "scoring"
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


# ---------------------------------------------------------------- 用量信号


def test_usage_signals_extracted():
    r = P.parse_log(MEDIUM, "medium", force=True)
    u = r["usage"]
    assert u["ddg_budget"] == 30
    assert u["max_workers"] == 6
    assert u["collect_sec"] == pytest.approx(464.9)
    assert u["forced_all"] == 22
    assert u["ddg_used"] is None  # UZI 从不打印真实消耗


def test_lite_ddg_budget_is_zero():
    r = P.parse_log(LITE, "lite", force=True)
    assert r["usage"]["ddg_budget"] == 0


# ---------------------------------------------------------------- 鲁棒性


def test_truncated_log_does_not_raise():
    """半行截断（写端正在 flush）不能让解析崩掉。"""
    text = _read(MEDIUM)
    tmp = os.path.join(FIXTURES, "_tmp_trunc.log")
    try:
        path = _write(tmp, text[: len(text) // 4])
        r = P.parse_log(path, "medium", force=True)
        assert r["degraded"] is False
        assert 0 < r["counts"]["reported"] < 22
        assert r["phase_key"] in {s.key for s in P.STAGE_SPECS}
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def test_count_never_regresses_when_log_grows():
    """追加日志后已上报数只能不减（旧实现读 64KB 尾窗会倒退）。"""
    text = _read(MEDIUM)
    tmp = os.path.join(FIXTURES, "_tmp_grow.log")
    try:
        path = _write(tmp, text[: len(text) // 3])
        first = P.parse_log(path, "medium", force=True)["counts"]["reported"]
        _write(tmp, text)
        second = P.parse_log(path, "medium", force=True)["counts"]["reported"]
        assert second >= first
        assert second == 22
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def test_missing_file_returns_degraded_not_raise():
    r = P.parse_log("/nonexistent/uzi.log", "lite", force=True)
    assert r["degraded"] is True
    assert r["counts"]["reported"] == 0


def test_cache_hit_returns_same_object_for_same_mtime():
    a = P.parse_log(MEDIUM, "medium")
    b = P.parse_log(MEDIUM, "medium")
    assert a is b  # 命中缓存返回同一对象，未重复解析


# ---------------------------------------------------------------- 组装视图


def test_build_progress_shape_and_skipped_stage():
    job = {"log_path": LITE, "tier": "lite"}
    p = P.build_progress(job)
    assert p["schema"] == P.SCHEMA_VERSION
    assert p["degraded"] is False
    assert len(p["stages"]) == 7
    assert len(p["dims"]["items"]) == 22  # lite 也渲染 22 格，13 格 skipped

    by_key = {s["key"]: s for s in p["stages"]}
    assert by_key["collect_w3"]["status"] == "skipped"
    assert by_key["collect_w3"]["detail"] == "本档无需"

    skipped_items = [i for i in p["dims"]["items"] if i["state"] == "skipped"]
    assert len(skipped_items) == 13
    assert p["dims"]["items"][0]["group"] == "basic"


def test_build_progress_all_stages_done_on_finished_log():
    p = P.build_progress({"log_path": MEDIUM, "tier": "medium"})
    assert all(s["status"] == "done" for s in p["stages"])
    assert p["dims"]["reported"] == 22
    assert p["usage"]["fetchers_expected"] == 22
    assert p["usage"]["ddg_used"] is None


def test_log_live_only_for_unfinished_jobs():
    """mtime 60s 窗口只对未收尾作业有意义：success/failed 不该报「日志仍在更新」。"""
    tmp = os.path.join(FIXTURES, "_tmp_live.log")
    with open(LITE, "rb") as src, open(tmp, "wb") as dst:
        dst.write(src.read())
    try:
        now = time.time()
        os.utime(tmp, (now, now))
        P.clear_cache()
        for status in ("running", "interrupted"):
            got = P.build_progress({"log_path": tmp, "tier": "lite", "status": status})
            assert got["log_live"] is True, status
        for status in ("success", "failed"):
            got = P.build_progress({"log_path": tmp, "tier": "lite", "status": status})
            assert got["log_live"] is False, status
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def test_summary_contract_matches_legacy_shape():
    """`uzi_jobs._log_progress` 依赖 {done_dims, phase} 这两个键。"""
    s = P.summary(MEDIUM, "medium")
    assert set(s) == {"done_dims", "phase"}
    assert s["done_dims"] == 22
    assert s["phase"] == "报告落盘与自检"

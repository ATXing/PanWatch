"""uzi_jobs 收拣逻辑回归：进程还活着 / 已跑完 / 真中断 三种情形。

补这组测试的直接原因（2026-10-31 实测）：600519 的 lite 作业 15:24 起跑、
15:29 已正常打印「✅ 完成!」并落盘报告，但库里被记成
「服务重启，任务已中断」——因为旧判据只看内存里有没有 Popen 句柄，
父进程重启过就必然误判，用户会白重跑一遍。

新判据按证据排序：进程存活 → 不动；进程已退但有收尾标记 → 补同步入库；
两者都不成立 → 才标记 interrupted，且文案不许再编「服务重启」。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.modules.research import uzi_jobs as J

DEAD_PID = 999999  # 正常机器上不可能存在的 pid


def _row(job_id="uj1", ticker="600519.SH", pid=DEAD_PID, log_path="", started_at=None):
    started = started_at or J._now()
    return (
        job_id,
        "600519",
        "cn",
        ticker,
        "lite",
        "running",
        pid,
        started,
        None,
        None,
        log_path,
        None,
        None,
        started,
    )


def _insert(conn, row):
    conn.execute(
        "INSERT INTO uzi_jobs (job_id, symbol, market, ticker, tier, status, pid, started_at,"
        " finished_at, exit_code, log_path, error, result_json, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        row,
    )
    conn.commit()


def _status(conn):
    return conn.execute("SELECT status, error, result_json FROM uzi_jobs").fetchone()


@pytest.fixture()
def conn():
    c = sqlite3.connect(":memory:")
    J._ensure_table(c)
    yield c
    c.close()


def test_pid_alive_detects_self_and_missing():
    import os

    assert J._pid_alive(os.getpid()) is True
    assert J._pid_alive(DEAD_PID) is False
    assert J._pid_alive(None) is False
    assert J._pid_alive("not-a-pid") is False


def test_live_pid_is_not_marked_interrupted(conn, tmp_path):
    """父进程重启过、子进程还在跑 —— 绝不能标中断（这就是漏报 600519 的形状）。"""
    log = tmp_path / "running.log"
    log.write_text("[pipeline] wave 2 · 8 fetcher\n", encoding="utf-8")
    row = _row(pid=__import__("os").getpid(), log_path=str(log))
    _insert(conn, row)

    J._reap_stale(conn, row)

    status, error, _ = _status(conn)
    assert status == "running"
    assert error is None


def test_finished_orphan_is_synced_instead_of_interrupted(conn, tmp_path, monkeypatch):
    """进程已退但日志有收尾标记 → 判定成功并补同步，不能报中断。"""
    log = tmp_path / "done.log"
    log.write_text(
        "📄 报告路径: D:/x/full-report-standalone.html\n✅ 完成!\n", encoding="utf-8"
    )
    row = _row(log_path=str(log))
    _insert(conn, row)

    calls = []

    def fake_sync(ticker):
        calls.append(ticker)
        return {"overall": 66.6}

    monkeypatch.setattr(J.uzi_sync, "sync_symbol", fake_sync)

    J._reap_stale(conn, row)

    status, error, result_json = _status(conn)
    assert status == "success"
    assert error is None
    assert result_json and "66.6" in result_json
    assert calls == ["600519.SH"]


def test_finished_orphan_without_artifact_is_failed(conn, tmp_path, monkeypatch):
    """跑完了但磁盘没产出 → failed，别谎报 success。"""
    log = tmp_path / "done_no_artifact.log"
    log.write_text("✅ 完成!\n", encoding="utf-8")
    row = _row(log_path=str(log))
    _insert(conn, row)

    monkeypatch.setattr(J.uzi_sync, "sync_symbol", lambda ticker: None)

    J._reap_stale(conn, row)

    status, error, _ = _status(conn)
    assert status == "failed"
    assert "无 .cache 产出" in error


def test_dead_without_marker_is_interrupted_with_honest_wording(conn, tmp_path):
    log = tmp_path / "killed.log"
    log.write_text("[pipeline] wave 2 · 1/8\n", encoding="utf-8")
    row = _row(log_path=str(log))
    _insert(conn, row)

    J._reap_stale(conn, row)

    status, error, _ = _status(conn)
    assert status == "interrupted"
    assert "服务重启" not in error  # 文案不许编原因
    assert "进程已退出" in error


def test_overdue_orphan_is_reaped_even_if_pid_looks_alive(conn, tmp_path):
    """僵死进程占着 pid 也要收拣，否则任务永远挂着 running。"""
    import os
    from datetime import datetime, timedelta

    log = tmp_path / "stuck.log"
    log.write_text("", encoding="utf-8")
    old = (datetime.now() - timedelta(seconds=J.JOB_MAX_SEC + 3600)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    row = _row(pid=os.getpid(), log_path=str(log), started_at=old)
    _insert(conn, row)

    J._reap_stale(conn, row)

    status, _, _ = _status(conn)
    assert status == "interrupted"

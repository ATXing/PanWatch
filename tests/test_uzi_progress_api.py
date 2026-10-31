"""UZI 进度端点契约测试。

守住四条：
1. 无任务时 `/job/progress` 与 `/job` 一样回 `exists=False`，不能抛；
2. 有任务时 `progress` 结构完整（7 阶段 / 22 维 / usage），且**旧字段口径一致**；
3. 服务重启后 job 被标 `interrupted`，但**进度仍能从日志完整重建**（不依赖内存）；
4. `/job/stream` 先推 progress 事件，遇终态推 done 并关流。
"""

from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.modules.research import uzi_jobs, uzi_progress
from src.modules.research.api import uzi as uzi_api

FIXTURES = Path(__file__).parent / "fixtures" / "uzi"
MEDIUM = FIXTURES / "medium_688363_full.log"


@pytest.fixture
def env(tmp_path, monkeypatch):
    """造一个只有 uzi_jobs 表的最小库，把模块常量指到 tmp。"""
    db = tmp_path / "panwatch.db"
    conn = sqlite3.connect(str(db))
    try:
        uzi_jobs._ensure_table(conn)
        conn.commit()
    finally:
        conn.close()

    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    log = log_dir / "688363_SH_medium_test.log"
    shutil.copy(MEDIUM, log)

    monkeypatch.setattr(uzi_jobs, "PANWATCH_DB", str(db))
    monkeypatch.setattr(uzi_jobs, "JOB_LOG_DIR", str(log_dir))
    monkeypatch.setattr(uzi_jobs, "_PROCS", {})
    uzi_progress.clear_cache()
    yield {"db": db, "log": log}
    uzi_progress.clear_cache()


def _insert_job(db: Path, *, status: str, log_path: str, tier: str = "medium") -> str:
    job_id = "uj-test-0001"
    conn = sqlite3.connect(str(db))
    try:
        conn.execute(
            "INSERT INTO uzi_jobs (job_id, symbol, market, ticker, tier, status, pid,"
            " started_at, finished_at, exit_code, log_path, error, result_json, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                job_id,
                "688363",
                "CN",
                "688363.SH",
                tier,
                status,
                None,
                "2026-10-30 22:10:39",
                "2026-10-30 22:21:11" if status != "running" else None,
                0 if status == "success" else None,
                log_path,
                None,
                None,
                "2026-10-30 22:21:11",
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return job_id


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(uzi_api.router, prefix="/api/uzi")
    return TestClient(app)


# ---------------------------------------------------------------- 快照端点


def test_progress_without_job_returns_exists_false(client, env):
    r = client.get("/api/uzi/job/progress", params={"symbol": "688363", "market": "CN"})
    assert r.status_code == 200
    assert r.json() == {"exists": False}


def test_job_without_task_also_not_found(client, env):
    """守住 /job 与 /job/progress 在「无任务」时的行为一致。"""
    r = client.get("/api/uzi/job", params={"symbol": "688363", "market": "CN"})
    assert r.json() == {"exists": False}


def test_progress_snapshot_has_full_structure(client, env):
    _insert_job(env["db"], status="success", log_path=str(env["log"]))
    r = client.get("/api/uzi/job/progress", params={"symbol": "688363", "market": "CN"})
    body = r.json()
    assert body["exists"] is True

    job = body["job"]
    assert job["status"] == "success"
    assert job["tier"] == "medium"

    p = job["progress"]
    assert p is not None
    assert p["schema"] == uzi_progress.SCHEMA_VERSION
    assert p["degraded"] is False
    assert len(p["stages"]) == 7
    assert len(p["dims"]["items"]) == 22
    assert p["dims"]["reported"] == 22
    assert p["dims"]["expected"] == 22
    assert p["current_stage"] == "render"
    assert p["usage"]["fetchers_expected"] == 22
    assert p["usage"]["ddg_used"] is None


def test_old_and_new_done_dims_agree(client, env):
    """`/job` 的 done_dims 与 `progress.dims.reported` 必须是同一口径。"""
    _insert_job(env["db"], status="success", log_path=str(env["log"]))
    old = client.get("/api/uzi/job", params={"symbol": "688363", "market": "CN"}).json()
    new = client.get(
        "/api/uzi/job/progress", params={"symbol": "688363", "market": "CN"}
    ).json()
    assert old["job"]["done_dims"] == new["job"]["progress"]["dims"]["reported"]
    assert old["job"]["phase"] == "报告落盘与自检"


def test_lite_tier_reports_nine_expected(client, env):
    lite_log = FIXTURES / "lite_600276_ok_with_timeout.log"
    dst = Path(uzi_jobs.JOB_LOG_DIR) / "600276_SH_lite_test.log"
    shutil.copy(lite_log, dst)
    _insert_job(env["db"], status="success", log_path=str(dst), tier="lite")
    body = client.get(
        "/api/uzi/job/progress", params={"symbol": "688363", "market": "CN"}
    ).json()
    p = body["job"]["progress"]
    assert p["tier"] == "lite"
    assert p["dims"]["expected"] == 9
    assert p["dims"]["skipped"] == 13
    assert len([i for i in p["dims"]["items"] if i["state"] == "skipped"]) == 13


# ---------------------------------------------------------------- 重启重建


def test_progress_survives_orphan_without_finish_marker(client, env):
    """内存态丢失且日志无收尾标记（真中断）→ 懒标 interrupted，进度仍要能从日志重建。"""
    text = Path(env["log"]).read_text(encoding="utf-8", errors="ignore")
    killed = "\n".join(
        ln
        for ln in text.splitlines()
        if "✅ 完成!" not in ln and "报告路径:" not in ln
    )
    Path(env["log"]).write_text(killed + "\n", encoding="utf-8")
    uzi_progress.clear_cache()

    _insert_job(env["db"], status="running", log_path=str(env["log"]))
    uzi_jobs._PROCS.clear()  # 模拟父进程重启：内存里没有对应 Popen

    body = client.get(
        "/api/uzi/job/progress", params={"symbol": "688363", "market": "CN"}
    ).json()
    assert body["exists"] is True
    assert body["job"]["status"] == "interrupted"
    # 但进度不能因此丢
    p = body["job"]["progress"]
    assert p["dims"]["reported"] == 22
    assert len(p["stages"]) == 7


def test_orphan_with_finish_marker_is_recovered_as_success(client, env, monkeypatch):
    """跑完但父进程丢了句柄：不该报中断，要补同步成 success。

    这是 2026-10-31 600519 那次的实际形状——报告已落盘，库里却写「服务重启，任务已中断」。
    """
    monkeypatch.setattr(uzi_jobs.uzi_sync, "sync_symbol", lambda t: {"overall": 60.0})
    _insert_job(env["db"], status="running", log_path=str(env["log"]))
    uzi_jobs._PROCS.clear()

    body = client.get(
        "/api/uzi/job/progress", params={"symbol": "688363", "market": "CN"}
    ).json()
    assert body["job"]["status"] == "success"
    assert body["job"]["progress"]["dims"]["reported"] == 22


def test_missing_log_degrades_without_breaking_endpoint(client, env):
    """日志文件被删时，progress 降级但端点仍 200。"""
    _insert_job(env["db"], status="failed", log_path=str(env["log"]) + ".gone")
    body = client.get(
        "/api/uzi/job/progress", params={"symbol": "688363", "market": "CN"}
    ).json()
    assert body["exists"] is True
    assert body["job"]["progress"]["degraded"] is True
    assert body["job"]["progress"]["dims"]["reported"] == 0


# ---------------------------------------------------------------- SSE


def test_stream_emits_progress_then_done():
    """SSE：首事件是 progress（含 job.progress），终态推 done 后关流。"""
    app = FastAPI()
    app.include_router(uzi_api.router, prefix="/api/uzi")
    client = TestClient(app)

    # 直接打桩快照函数，避开 DB 依赖，专测流协议
    calls = {"n": 0}
    states = [
        {"exists": True, "job": {"status": "running", "tier": "medium", "progress": {"schema": 1}}},
        {"exists": True, "job": {"status": "running", "tier": "medium", "progress": {"schema": 1}}},
        {"exists": True, "job": {"status": "success", "tier": "medium", "progress": {"schema": 1}}},
    ]

    def fake_snapshot(symbol, market):
        i = min(calls["n"], len(states) - 1)
        calls["n"] += 1
        return states[i]

    import src.modules.research.api.uzi as mod

    original = mod._uzi_progress_snapshot
    mod._uzi_progress_snapshot = fake_snapshot
    original_poll = mod.UZI_SSE_POLL_SEC
    mod.UZI_SSE_POLL_SEC = 0.01
    try:
        with client.stream(
            "GET", "/api/uzi/job/stream", params={"symbol": "688363", "market": "CN"}
        ) as r:
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("text/event-stream")
            chunks = []
            for line in r.iter_lines():
                if line:
                    chunks.append(line)
                if any("event: done" in c for c in chunks):
                    break
    finally:
        mod._uzi_progress_snapshot = original
        mod.UZI_SSE_POLL_SEC = original_poll

    joined = "\n".join(chunks)
    assert "event: progress" in joined
    assert "event: done" in joined
    # 3 次快照只有 2 种 payload（running x2 相同、success 变化）⇒ progress 推 2 次：
    # 一次 running、一次终态（终态也必须推，否则前端拿不到最终状态）
    assert joined.count("event: progress") == 2
    assert '"status": "running"' in joined
    assert '"status": "success"' in joined
    # done 必须是最后一个事件
    assert joined.rstrip().endswith("event: done") or "event: done" in joined.split("\n")[-3:]

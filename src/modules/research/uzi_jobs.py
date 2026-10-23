"""UZI 重新调研任务管理（后台跑 run.py，完成后自动回写库）。

背景: 之前面板上只有「重新同步」= 从磁盘重读已有产出，不触发任何新调研。
本模块补上真正的「重新调研」:

    POST /api/uzi/analyze  → 起一个子进程跑 `run.py <ticker> --no-browser --depth <tier>`
    GET  /api/uzi/job      → 轮询进度；进程退出码 0 时自动 sync_symbol() 刷新 uzi_reports

设计约束:
- **不阻塞请求**: 调研 lite 1-2 分钟、medium 数分钟，必须异步。
- **同标的不并发**: 同一 ticker 已有 running 任务时直接复用，不重复起进程
  (UZI 内部会写同一个 .cache 目录，并发会互相踩)。
- **deep 档不开放**: UZI 的 deep 要求 agent 介入 66 评委 role-play 并产出
  agent_analysis.json（HARD-GATE），一键子进程跑只会得到不完整的 deep 产物。
- 状态落 sqlite（`uzi_jobs` 表）而不是纯内存，避免接口在读、进程已重启时拿到空。

任务状态: running / success / failed / interrupted
  interrupted = 服务重启后遗留的 running（本进程内已无对应 Popen）
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import threading
import time
from datetime import datetime

from src.modules.research import uzi_sync

UZI_ROOT = os.environ.get("UZI_ROOT_DIR", r"D:/Projects/UZI-Skill")
JOB_LOG_DIR = os.environ.get(
    "UZI_JOB_LOG_DIR",
    r"D:/Projects/PanWatch/data/uzi_jobs",
)
PANWATCH_DB = uzi_sync.PANWATCH_DB

# 只允许这两档；deep 需 agent 介入，见模块 docstring
ALLOWED_TIERS = ("lite", "medium")
DEFAULT_TIER = "medium"

# job_id -> Popen，用于判断 running 是否真有活进程
_PROCS: dict[str, subprocess.Popen] = {}
_LOCK = threading.Lock()


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _ensure_table(conn: sqlite3.Connection):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS uzi_jobs (
            job_id VARCHAR PRIMARY KEY,
            symbol VARCHAR NOT NULL,
            market VARCHAR NOT NULL,
            ticker VARCHAR,
            tier VARCHAR,
            status VARCHAR,
            pid INTEGER,
            started_at DATETIME,
            finished_at DATETIME,
            exit_code INTEGER,
            log_path VARCHAR,
            error TEXT,
            result_json TEXT,
            updated_at DATETIME
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_uzi_jobs_symbol ON uzi_jobs(symbol, market)"
    )


def _py_exe() -> str:
    for rel in (".venv/Scripts/python.exe", ".venv/bin/python"):
        p = os.path.join(UZI_ROOT, rel.replace("/", os.sep))
        if os.path.exists(p):
            return p
    # 兜底: 用当前解释器（有依赖时装得通）
    import sys

    return sys.executable


# ── 日志解析：把 UZI 的进度条噪音压成一句人话 ────────────────────────────
_ANSI = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")
_WAVE = re.compile(r"\[pipeline\]\s*(wave\s*\d+[^\r\n]*)")
_OKDIM = re.compile(r"^\s*ok\s+([0-9]{1,2}_[a-z_]+)", re.M)
_PHASE_HINTS = (
    ("collect", "采集数据中"),
    ("wave 1", "采集基础数据"),
    ("wave 2", "采集分维度数据"),
    ("score", "计算维度分数"),
    ("modeling", "建模与估值"),
    ("assemble", "生成报告"),
    ("report", "生成报告"),
    ("inline", "内联资源"),
)


def _log_progress(log_path: str) -> dict:
    """读日志尾部 → {done_dims, phase}。仅用于 UI 提示，不参与逻辑判断。"""
    if not log_path or not os.path.exists(log_path):
        return {"done_dims": 0, "phase": ""}
    try:
        size = os.path.getsize(log_path)
        with open(log_path, "rb") as f:
            f.seek(max(0, size - 65536))
            tail = f.read().decode("utf-8", errors="ignore")
    except OSError:
        return {"done_dims": 0, "phase": ""}
    tail = _ANSI.sub("", tail)
    done = len(set(_OKDIM.findall(tail)))
    phase = ""
    low = tail.lower()
    for key, label in _PHASE_HINTS:
        if key in low:
            phase = label  # 取最后一个命中的（越靠后越新）
    return {"done_dims": done, "phase": phase}


def _log_tail(log_path: str, n: int = 12) -> list[str]:
    """取最后 n 行有意义日志（去进度条 / 空行），给失败时排查用。"""
    if not log_path or not os.path.exists(log_path):
        return []
    try:
        size = os.path.getsize(log_path)
        with open(log_path, "rb") as f:
            f.seek(max(0, size - 32768))
            raw = f.read().decode("utf-8", errors="ignore")
    except OSError:
        return []
    raw = _ANSI.sub("", raw)
    # 进度条靠 \r 刷新，按 \r 与 \n 切成片段后丢掉带 it/s 的
    parts = [p.strip() for p in re.split(r"[\r\n]+", raw) if p.strip()]
    parts = [p for p in parts if not re.search(r"it/s\]|\?it/s|\d+/\d+ \[", p)]
    return parts[-n:]


def _row_to_dict(row) -> dict:
    if not row:
        return {}
    keys = (
        "job_id",
        "symbol",
        "market",
        "ticker",
        "tier",
        "status",
        "pid",
        "started_at",
        "finished_at",
        "exit_code",
        "log_path",
        "error",
        "result_json",
        "updated_at",
    )
    d = dict(zip(keys, row))
    res = d.pop("result_json", None)
    d["result"] = json.loads(res) if res else None
    prog = _log_progress(d.get("log_path") or "")
    d["done_dims"] = prog["done_dims"]
    d["phase"] = prog["phase"]
    d["running"] = d.get("status") == "running"
    d["can_restart"] = d.get("status") in ("success", "failed", "interrupted")
    if d.get("started_at") and d.get("running"):
        try:
            t0 = datetime.strptime(d["started_at"], "%Y-%m-%d %H:%M:%S")
            d["elapsed_sec"] = int((datetime.now() - t0).total_seconds())
        except ValueError:
            d["elapsed_sec"] = None
    elif d.get("started_at") and d.get("finished_at"):
        try:
            t0 = datetime.strptime(d["started_at"], "%Y-%m-%d %H:%M:%S")
            t1 = datetime.strptime(d["finished_at"], "%Y-%m-%d %H:%M:%S")
            d["elapsed_sec"] = int((t1 - t0).total_seconds())
        except ValueError:
            d["elapsed_sec"] = None
    return d


def _select_job(conn: sqlite3.Connection, symbol: str, market: str):
    cur = conn.execute(
        """
        SELECT job_id, symbol, market, ticker, tier, status, pid, started_at,
               finished_at, exit_code, log_path, error, result_json, updated_at
        FROM uzi_jobs WHERE symbol=? AND market=?
        ORDER BY started_at DESC LIMIT 1
        """,
        (symbol, market),
    )
    return cur.fetchone()


def _reap_stale(conn: sqlite3.Connection, row) -> None:
    """服务重启后，内存里已无对应 Popen 的 running 任务标记为 interrupted。"""
    if not row or row[5] != "running":
        return
    job_id = row[0]
    with _LOCK:
        alive = job_id in _PROCS
    if alive:
        return
    conn.execute(
        "UPDATE uzi_jobs SET status='interrupted', finished_at=?, updated_at=?,"
        " error=COALESCE(error,'服务重启，任务已中断') WHERE job_id=? AND status='running'",
        (_now(), _now(), job_id),
    )
    conn.commit()


def get_job(symbol: str, market: str) -> dict | None:
    conn = sqlite3.connect(PANWATCH_DB)
    try:
        _ensure_table(conn)
        row = _select_job(conn, symbol, market)
        _reap_stale(conn, row)
        if row:
            row = _select_job(conn, symbol, market)
        return _row_to_dict(row) if row else None
    finally:
        conn.close()


def _watch(job_id: str, proc: subprocess.Popen, ticker: str, symbol: str, market: str):
    """等子进程结束 → 成功则同步进库。跑在 daemon 线程里。"""
    try:
        code = proc.wait()
    except Exception as e:  # noqa: BLE001
        code = -1
        err = f"等待进程失败: {e}"
    else:
        err = None if code == 0 else f"UZI 退出码 {code}"

    result = None
    status = "success" if code == 0 else "failed"
    if code == 0:
        try:
            result = uzi_sync.sync_symbol(ticker)
            if result is None:
                status = "failed"
                err = "进程成功但磁盘无 .cache 产出，同步失败"
        except Exception as e:  # noqa: BLE001
            status = "failed"
            err = f"同步入库失败: {e}"

    conn = sqlite3.connect(PANWATCH_DB)
    try:
        _ensure_table(conn)
        conn.execute(
            "UPDATE uzi_jobs SET status=?, finished_at=?, exit_code=?, error=?,"
            " result_json=?, updated_at=? WHERE job_id=?",
            (
                status,
                _now(),
                code,
                err,
                json.dumps(result, ensure_ascii=False) if result else None,
                _now(),
                job_id,
            ),
        )
        conn.commit()
    finally:
        conn.close()
        with _LOCK:
            _PROCS.pop(job_id, None)


def start_job(symbol: str, market: str, tier: str | None = None) -> dict:
    """起一次真实调研。返回任务信息（含 job_id）。

    同标的已有 running 任务时返回既有任务（幂等），不重复起进程。
    """
    ticker = uzi_sync.resolve_ticker(symbol, market)
    if not ticker:
        raise ValueError(f"cannot resolve UZI ticker for {symbol}.{market}")

    tier = (tier or "").lower()
    if tier not in ALLOWED_TIERS:
        tier = DEFAULT_TIER

    conn = sqlite3.connect(PANWATCH_DB)
    try:
        _ensure_table(conn)
        row = _select_job(conn, symbol, market)
        _reap_stale(conn, row)
        row = _select_job(conn, symbol, market)
        if row and row[5] == "running":
            return _row_to_dict(row)

        job_id = "uj" + datetime.now().strftime("%Y%m%d%H%M%S%f")[:20]
        log_dir = JOB_LOG_DIR
        os.makedirs(log_dir, exist_ok=True)
        safe = ticker.replace(".", "_")
        log_path = os.path.join(log_dir, f"{safe}_{tier}_{datetime.now():%Y%m%d_%H%M%S}.log")

        # -u: 关掉 stdout 块缓冲，否则日志要攒满 8KB 才落盘，进度条看起来像卡死
        # --no-resume: UZI 默认 resume 会复用 .cache 里上一次的 raw_data，
        #   那等于「重算分数」而不是「重新调研」；用户点这个按钮要的是最新数据。
        cmd = [
            _py_exe(),
            "-u",
            os.path.join(UZI_ROOT, "run.py"),
            ticker,
            "--no-browser",
            "--no-resume",
            "--depth",
            tier,
        ]
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"

        fh = open(log_path, "wb")
        try:
            proc = subprocess.Popen(  # noqa: S603
                cmd,
                cwd=UZI_ROOT,
                stdout=fh,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                env=env,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception:
            fh.close()
            raise
        finally:
            # 父进程句柄关掉，子进程继续写（它自己持有 fd）
            try:
                fh.close()
            except Exception:  # noqa: BLE001
                pass

        with _LOCK:
            _PROCS[job_id] = proc

        conn.execute(
            """
            INSERT INTO uzi_jobs
                (job_id, symbol, market, ticker, tier, status, pid, started_at,
                 finished_at, exit_code, log_path, error, result_json, updated_at)
            VALUES (?,?,?,?,?,'running',?,?,NULL,NULL,?,NULL,NULL,?)
            """,
            (job_id, symbol, market, ticker, tier, proc.pid, _now(), log_path, _now()),
        )
        conn.commit()

        threading.Thread(
            target=_watch,
            args=(job_id, proc, ticker, symbol, market),
            daemon=True,
            name=f"uzi-job-{job_id}",
        ).start()

        return _row_to_dict(_select_job(conn, symbol, market))
    finally:
        conn.close()

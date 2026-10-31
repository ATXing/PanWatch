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
import logging
import os
import re
import sqlite3
import subprocess
import threading
import time
from datetime import datetime

from src.modules.research import uzi_sync

logger = logging.getLogger(__name__)

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

# 子进程总时长上限（秒）。只防「卡死后永远 running」，不作为性能约束：
# UZI 自身 wave 超时 360s×2 封顶约 15 分钟，medium 实测 7-10 分钟；
# 这里取 45 分钟 ≈ 4 倍余量，正常任务不可能触发。
JOB_MAX_SEC = int(os.environ.get("UZI_JOB_MAX_SEC", "2700"))


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
    ("wave 3", "采集行业与宏观维度"),
    ("score", "计算维度分数"),
    ("modeling", "建模与估值"),
    ("assemble", "生成报告"),
    ("report", "生成报告"),
    ("inline", "内联资源"),
)


def _log_progress_legacy(log_path: str) -> dict:
    """旧实现（读尾部 64KB + 关键词猜阶段）。

    两个已知缺陷，保留仅用于 `UZI_PROGRESS_V2=0` 回滚对照：
    1. 只读末尾 65536 字节 ⇒ 任务久了早期 `ok` 行被挤出窗口，计数会**倒退**；
    2. `_PHASE_HINTS` 取的是「元组里最后一个命中的 key」，不是日志里最后出现的，
       且 `collect` 是 `collect 完成` 的子串 ⇒ 采集结束后仍显示「采集数据中」。
    """
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


def _log_progress(log_path: str, tier: str = "medium") -> dict:
    """读日志算 {done_dims, phase}。仅用于 UI 提示，不参与逻辑判断。

    v2 实现委托 `uzi_progress.summary()`：全量扫描、按日志出现顺序定阶段、
    解析 quality。返回契约不变，调用方无需改动。
    """
    if os.environ.get("UZI_PROGRESS_V2", "1").strip() == "0":
        return _log_progress_legacy(log_path)
    try:
        from src.modules.research.uzi_progress import summary

        return summary(log_path, tier)
    except Exception as e:  # noqa: BLE001 - 进度是增强项，绝不能连坐主流程
        logger.warning(f"[UZI] 进度解析降级到 legacy: {e}")
        return _log_progress_legacy(log_path)


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
    prog = _log_progress(d.get("log_path") or "", d.get("tier") or DEFAULT_TIER)
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


_DONE_MARKERS = ("✅ 完成!", "报告路径:")


def _pid_alive(pid) -> bool:
    """pid 是否仍存活。只用标准库：Windows 走 OpenProcess，其他平台 os.kill(pid, 0)。

    不能拿「内存里有没有 Popen 句柄」当存活判据——父进程重启过就没有句柄了，
    但子进程可能还在正常跑（2026-10-31 实测：600519 lite 明明跑完并落盘了报告，
    却被记成「服务重启，任务已中断」，用户会白重跑一遍）。
    """
    if not pid:
        return False
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            handle = kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
            if not handle:
                # 5 = ERROR_ACCESS_DENIED：进程存在但没权限问，算活着而非误判死亡
                return ctypes.get_last_error() == 5
            try:
                code = wintypes.DWORD()
                if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return False
                return code.value == 259  # STILL_ACTIVE
            finally:
                kernel32.CloseHandle(handle)
        except Exception:  # noqa: BLE001
            return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _log_says_done(log_path: str) -> bool:
    """孤儿作业的收尾证据：UZI 正常结束会在日志末尾打印「✅ 完成!」+ 报告路径。"""
    if not log_path:
        return False
    try:
        size = os.path.getsize(log_path)
        with open(log_path, "rb") as f:
            f.seek(max(0, size - 8192))
            tail = f.read().decode("utf-8", errors="ignore")
    except OSError:
        return False
    return any(m in tail for m in _DONE_MARKERS)


def _overdue(started_at) -> bool:
    """起跑时间超过「进程上限 + 10 分钟」就认作僵死，避免孤儿永远挂着 running。"""
    try:
        started = datetime.strptime(str(started_at), "%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return False
    return (datetime.now() - started).total_seconds() > JOB_MAX_SEC + 600


def _reap_stale(conn: sqlite3.Connection, row) -> None:
    """收拣本进程没有 Popen 句柄的 running 任务（父进程重启过，或子进程已退）。

    判据按「证据」排序，不再只看内存字典：
    1. 子进程还活着 → 什么都不做（父进程重启不该等于任务失败）；
    2. 子进程已退、但日志有收尾标记 → 其实成功了，补跑一次入库；
    3. 子进程已退、无收尾标记 → 才标记 interrupted，且文案说清是「进程退出」，
       不能编成「服务重启」。
    """
    if not row or row[5] != "running":
        return
    job_id, ticker, pid, log_path, started_at = row[0], row[3], row[6], row[10], row[7]
    with _LOCK:
        if job_id in _PROCS:
            return
    alive = _pid_alive(pid)
    if alive and not _overdue(started_at):
        return
    if not alive and _log_says_done(log_path):
        status, err, result = "success", None, None
        try:
            result = uzi_sync.sync_symbol(ticker) if ticker else None
            if result is None:
                status, err = "failed", "进程已结束但磁盘无 .cache 产出，同步失败"
        except Exception as e:  # noqa: BLE001
            status, err = "failed", f"同步入库失败: {e}"
        conn.execute(
            "UPDATE uzi_jobs SET status=?, finished_at=?, error=?, result_json=?, updated_at=?"
            " WHERE job_id=? AND status='running'",
            (
                status,
                _now(),
                err,
                json.dumps(result, ensure_ascii=False) if result else None,
                _now(),
                job_id,
            ),
        )
        conn.commit()
        return
    conn.execute(
        "UPDATE uzi_jobs SET status='interrupted', finished_at=?, updated_at=?,"
        " error=COALESCE(error,'任务进程已退出且未见收尾标记，判定为中断')"
        " WHERE job_id=? AND status='running'",
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
        code = proc.wait(timeout=JOB_MAX_SEC)
    except subprocess.TimeoutExpired:
        # 卡死兜底：超过上限强制终止，否则 UI 会一直「调研中」、elapsed 无限增长
        code = -9
        err = f"超过 {JOB_MAX_SEC // 60} 分钟未完成，已强制终止"
        try:
            proc.kill()
            proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            pass
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

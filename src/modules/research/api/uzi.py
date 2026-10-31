"""UZI 调研结果查询端点。

- GET  /api/uzi/report?symbol=&market=  返回结构化调研(无则 exists=False)
- GET  /api/uzi/report-html?symbol=&market=  直接吐出 standalone HTML 完整报告
- POST /api/uzi/resync?symbol=&market=  从磁盘重读最新 UZI 产出并刷新库(不触发 LLM)
- POST /api/uzi/analyze?symbol=&market=&tier=  后台起一次真实调研(子进程跑 run.py)
- GET  /api/uzi/job?symbol=&market=  轮询调研进度;成功时已自动回写库
- GET  /api/uzi/gap-prompt?symbol=&market=  把缺的维度渲染成一段可粘贴的补数 prompt

UZI 是排雷/尽调层,不是 buy/sell 信号;此端点只读接入,不动交易逻辑。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import time
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from src.modules.research import uzi_gap_prompt, uzi_jobs, uzi_progress, uzi_sync
from src.platform.events.sse import format_sse_comment, format_sse_event
from src.platform.persistence.database import get_db

logger = logging.getLogger(__name__)

router = APIRouter()
# 公开路由:完整报告 HTML 经 window.open 打开,浏览器不会带 Bearer 头,故不鉴权。
public_router = APIRouter()

_PANWATCH_DB = uzi_sync.PANWATCH_DB


def _report_time(rdir: str | None, created_at: str | None) -> str | None:
    """报告产出时刻（带本地时区的 ISO 字符串）。

    优先取报告目录内最新文件的 mtime —— 那是 UZI 真正写出报告的时刻。
    库里的 created_at 只是「最后一次同步」时间，点一下「仅同步」也会刷新，
    拿它当调研时间会显示成「刚刚调研过」，是假的。

    回退时注意：SQLite CURRENT_TIMESTAMP 是 UTC 且不带时区标记，
    必须补 Z，否则前端会按本地时间解析，凭空差 8 小时。
    """
    if rdir and os.path.isdir(rdir):
        try:
            names = os.listdir(rdir)
            stamps = [os.path.getmtime(os.path.join(rdir, n)) for n in names]
            newest = max(stamps) if stamps else os.path.getmtime(rdir)
            return datetime.fromtimestamp(newest).astimezone().isoformat()
        except OSError:
            pass
    if created_at:
        raw = str(created_at).strip().replace(" ", "T")
        if raw.endswith("Z") or "+" in raw[10:]:
            return raw
        return f"{raw}Z"
    return None


def _fetch_row(symbol: str, market: str):
    conn = sqlite3.connect(_PANWATCH_DB)
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT symbol, market, tier, as_of_date, fundamental_score,
                   one_liner, coverage_pct, dimensions_json, html_path, dim_status_json,
                   score_integrity_json, uzi_overall_score, panel_consensus,
                   consensus_valid, verdict_detail, verdict_label, panel_active
            FROM uzi_reports WHERE symbol=? AND market=?
            """,
            (symbol, market),
        )
        return cur.fetchone()
    finally:
        conn.close()


@router.get("/list")
def list_uzi_reports():
    """列表页用:一次返回所有已有 UZI 报告的摘要(不含维度明细)。

    前端据此在股票名后打「UZI xx」标签,避免每行单独请求。
    """
    conn = sqlite3.connect(_PANWATCH_DB)
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT symbol, market, tier, as_of_date, fundamental_score,
                   one_liner, coverage_pct, html_path, score_integrity_json,
                   report_dir, created_at
            FROM uzi_reports
            ORDER BY as_of_date DESC
            """
        )
        rows = cur.fetchall()
    finally:
        conn.close()
    items = []
    for r in rows:
        integ = json.loads(r[8]) if r[8] else {}
        items.append(
            {
                "symbol": r[0],
                "market": r[1],
                "tier": r[2],
                "as_of_date": r[3],
                "fundamental_score": r[4],
                # 列表标签只用真实口径分;没有就空着,不拿含占位的总分充数
                "real_score": integ.get("real_score"),
                "trusted": integ.get("trusted", False),
                "real_dims": integ.get("real_dims"),
                "total_dims": integ.get("total_dims"),
                "real_weight_pct": integ.get("real_weight_pct"),
                "one_liner": r[5],
                "coverage_pct": r[6],
                "field_coverage_pct": r[6],
                "html_available": bool(r[7] and os.path.exists(r[7])),
                # 列表标签下方显示的「调研时间」；没报告目录的老数据回退同步时间
                "report_time": _report_time(r[9], r[10]),
            }
        )
    return {"count": len(items), "items": items}


@router.get("/report")
def get_uzi_report(symbol: str, market: str, db: Session = Depends(get_db)):
    row = _fetch_row(symbol, market)
    if not row:
        return {"exists": False}
    (
        symbol,
        market,
        tier,
        as_of,
        score,
        one_liner,
        coverage,
        dims_json,
        html_path,
        dim_status_json,
        integrity_json,
        uzi_overall,
        panel_consensus,
        consensus_valid,
        verdict_detail,
        verdict_label,
        panel_active,
    ) = row
    dims = json.loads(dims_json) if dims_json else {}
    dim_status = json.loads(dim_status_json) if dim_status_json else {}
    integrity = json.loads(integrity_json) if integrity_json else {}
    return {
        "exists": True,
        "symbol": symbol,
        "market": market,
        "tier": tier,
        "as_of_date": as_of,
        "fundamental_score": score,
        "real_score": integrity.get("real_score"),
        # UZI 的综合分(=0.6 基本面 + 0.4 评委共识)与其构成,用来解释 one-liner 的「体检结果 x 分」
        "uzi_overall_score": uzi_overall,
        "panel_consensus": panel_consensus,
        "panel_active": panel_active,
        "consensus_valid": None if consensus_valid is None else bool(consensus_valid),
        "verdict_detail": verdict_detail,
        "verdict_label": verdict_label,
        "trusted": integrity.get("trusted"),
        "score_integrity": integrity,
        "one_liner": one_liner,
        "coverage_pct": coverage,
        # 明确改名:UZI 的 coverage_pct 是 18 个基础字段的通过率,不是 19 维完整度
        "field_coverage_pct": coverage,
        "dimensions": dims,
        "dim_status": dim_status,
        "html_available": bool(html_path and os.path.exists(html_path)),
    }


@public_router.get("/report-html")
def get_uzi_report_html(symbol: str, market: str):
    row = _fetch_row(symbol, market)
    if not row or not row[8] or not os.path.exists(row[8]):
        raise HTTPException(status_code=404, detail="UZI report not found")
    # 必须 inline:带 filename 会让 FastAPI 下发 attachment 头,浏览器变成下载而不是打开
    return FileResponse(
        row[8],
        media_type="text/html",
        headers={"Content-Disposition": f'inline; filename="{symbol}.html"'},
    )


@router.get("/gap-prompt")
def get_gap_prompt(symbol: str = Query(...), market: str = Query(...)):
    """把「这只票缺哪些维、每维要什么字段、怎么写快照、跑什么命令」渲染成一段 prompt。

    生成的是给 WorkBuddy agent 读的任务卡(不是给人看的说明). 只读, 不触发调研:
    通达信 MCP 的 token 只在客户端侧, 后端拿不到数据, 只能让人把 prompt 粘过去。
    """
    res = uzi_gap_prompt.build(symbol, market)
    if not res.get("ok"):
        raise HTTPException(status_code=404, detail=res.get("reason") or "no report")
    return res


@router.post("/resync")
def resync_uzi(
    symbol: str = Query(...),
    market: str = Query(...),
):
    # 反查真实 UZI ticker(库里 ticker_raw → .cache 扫描 → 按市场推导)
    ticker = uzi_sync.resolve_ticker(symbol, market)
    if not ticker:
        raise HTTPException(status_code=400, detail="cannot resolve UZI ticker for " + symbol)
    res = uzi_sync.sync_symbol(ticker)
    if not res:
        raise HTTPException(status_code=404, detail="no UZI output on disk for " + ticker)
    return {"ok": True, **res}


@router.post("/analyze")
def analyze_uzi(
    symbol: str = Query(...),
    market: str = Query(...),
    tier: str | None = Query(None, description="lite / medium（deep 需 agent 介入，不开放）"),
):
    """在后台真跑一次 UZI 调研（子进程），立即返回任务信息。

    前端随后轮询 GET /api/uzi/job 拿进度；进程成功退出时会自动把新结果
    sync 进 uzi_reports，故轮询到 success 即代表库已刷新。
    """
    try:
        job = uzi_jobs.start_job(symbol, market, tier)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=f"UZI 运行环境缺失: {e}") from e
    if not job:
        raise HTTPException(status_code=500, detail="failed to start UZI job")
    return {"ok": True, "job": job}


@router.get("/job")
def get_uzi_job(
    symbol: str = Query(...),
    market: str = Query(...),
    tail: int = Query(0, ge=0, le=80, description=">0 时附带日志尾部行数，供失败排查"),
):
    """查最近一次调研任务状态。无任务返回 exists=False。"""
    job = uzi_jobs.get_job(symbol, market)
    if not job:
        return {"exists": False}
    if tail > 0:
        job["log_tail"] = uzi_jobs._log_tail(job.get("log_path") or "", tail)
    return {"exists": True, "job": job}


# ── 动态进度 ────────────────────────────────────────────────────────────────
# 数据来源是子进程日志（UZI 以独立进程跑，父进程看不到内存态）。
# 日志只有 9KB 左右，全量重扫约 0.5ms，1s 一次无压力；解析结果按
# (size, mtime_ns) 命中缓存，文件不变时零成本。

UZI_SSE_POLL_SEC = 1.0
UZI_SSE_HEARTBEAT_TICKS = 15
# 与进程上限对齐（默认 45 分钟）+ 2 分钟收尾，别把长尾任务切了
UZI_SSE_MAX_DURATION_SEC = uzi_jobs.JOB_MAX_SEC + 120
_UZI_TERMINAL_STATUSES = ("success", "failed", "interrupted")


def _uzi_progress_snapshot(symbol: str, market: str) -> dict:
    """组装一次进度快照：1 次 sqlite 读 + 解析（命中缓存时零成本）。"""
    job = uzi_jobs.get_job(symbol, market)
    if not job:
        return {"exists": False}
    try:
        job["progress"] = uzi_progress.build_progress(job)
    except Exception as e:  # noqa: BLE001 - 进度是增强项，坏了不能连坐 /job
        logger.warning(f"[UZI] 组装进度失败 {symbol}.{market}: {e}")
        job["progress"] = None
    return {"exists": True, "job": job}


@router.get("/job/progress")
def get_uzi_job_progress(
    symbol: str = Query(...),
    market: str = Query(...),
):
    """调研进度快照（7 阶段 + 22 维状态 + 用量）。无任务返回 exists=False。

    与 `/job` 的区别：`/job` 只给一行文字级的 `phase`/`done_dims`，
    这里给结构化的 `progress`，供前端画阶段列表与维度网格。
    `job.progress` 为 null 表示解析降级，调用方应回退到 `/job` 的旧字段。
    """
    return _uzi_progress_snapshot(symbol, market)


@router.get("/job/stream")
async def stream_uzi_job_progress(
    symbol: str = Query(...),
    market: str = Query(...),
):
    """SSE 推流：每 1s 重算快照，内容变了才推，终态发 done 并关流。

    与 `/api/agents/runs/{trace_id}/progress/stream` 同构（前端可共用一套
    `subscribeSSE` 消费方式），区别是这里每 tick 直接读日志文件而不是查库。
    """

    async def gen():
        seq = 0
        last = ""
        ticks = 0
        started = time.monotonic()
        while time.monotonic() - started < UZI_SSE_MAX_DURATION_SEC:
            try:
                snap = await asyncio.to_thread(_uzi_progress_snapshot, symbol, market)
            except Exception as e:  # noqa: BLE001 - 单次快照失败不能断流
                logger.warning(f"[UZI] 进度快照失败 {symbol}.{market}: {e}")
                await asyncio.sleep(UZI_SSE_POLL_SEC)
                continue

            payload = json.dumps(snap, ensure_ascii=False, default=str)
            if payload != last:
                last = payload
                ticks = 0
                seq += 1
                yield format_sse_event(seq, "progress", payload)
            else:
                ticks += 1
                if ticks >= UZI_SSE_HEARTBEAT_TICKS:
                    ticks = 0
                    yield format_sse_comment()

            job = snap.get("job") or {}
            status = job.get("status") or ""
            if not snap.get("exists") or status in _UZI_TERMINAL_STATUSES:
                seq += 1
                yield format_sse_event(
                    seq,
                    "done",
                    {"exists": bool(snap.get("exists")), "status": status or "not_found"},
                )
                return
            await asyncio.sleep(UZI_SSE_POLL_SEC)

        seq += 1
        yield format_sse_event(seq, "done", {"status": "timeout"})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )

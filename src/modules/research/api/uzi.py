"""UZI 调研结果查询端点。

- GET /api/uzi/report?symbol=&market=  返回结构化调研(无则 exists=False)
- GET /api/uzi/report-html?symbol=&market=  直接吐出 standalone HTML 完整报告
- POST /api/uzi/resync?symbol=&market=  从磁盘重读最新 UZI 产出并刷新库(不触发 LLM)

UZI 是排雷/尽调层,不是 buy/sell 信号;此端点只读接入,不动交易逻辑。
"""

from __future__ import annotations

import json
import os
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from src.modules.research import uzi_sync
from src.platform.persistence.database import get_db

router = APIRouter()
# 公开路由:完整报告 HTML 经 window.open 打开,浏览器不会带 Bearer 头,故不鉴权。
public_router = APIRouter()

_PANWATCH_DB = uzi_sync.PANWATCH_DB


def _fetch_row(symbol: str, market: str):
    conn = sqlite3.connect(_PANWATCH_DB)
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT symbol, market, tier, as_of_date, fundamental_score,
                   one_liner, coverage_pct, dimensions_json, html_path, dim_status_json
            FROM uzi_reports WHERE symbol=? AND market=?
            """,
            (symbol, market),
        )
        return cur.fetchone()
    finally:
        conn.close()


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
    ) = row
    dims = json.loads(dims_json) if dims_json else {}
    dim_status = json.loads(dim_status_json) if dim_status_json else {}
    return {
        "exists": True,
        "symbol": symbol,
        "market": market,
        "tier": tier,
        "as_of_date": as_of,
        "fundamental_score": score,
        "one_liner": one_liner,
        "coverage_pct": coverage,
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

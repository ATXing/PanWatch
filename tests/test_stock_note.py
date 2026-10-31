"""User note on a stock: write / clear / omit / null / length cap / migration."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from src.modules.market.api import stocks
from src.platform.persistence.database import Base, get_db
from src.platform.persistence.migrations import _m140_stock_note
from src.platform.persistence.models import Stock


@pytest.fixture
def api():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    app = FastAPI()
    app.include_router(stocks.router, prefix="/stocks")
    app.dependency_overrides[get_db] = lambda: session
    yield TestClient(app), session
    session.close()
    engine.dispose()


def _create(client, symbol: str = "600519", name: str = "贵州茅台") -> int:
    created = client.post("/stocks", json={"symbol": symbol, "name": name, "market": "CN"})
    assert created.status_code == 200
    return created.json()["id"]


def test_note_roundtrip(api):
    client, db = api
    stock_id = _create(client)
    # 新建时没有备注，出参统一给空串而不是 null，前端不用判空
    assert client.get("/stocks").json()[0]["note"] == ""

    text_value = "打新底仓\n跌到 1500 加仓"
    updated = client.put(f"/stocks/{stock_id}", json={"note": text_value})
    assert updated.status_code == 200
    assert updated.json()["note"] == text_value
    assert client.get("/stocks").json()[0]["note"] == text_value
    assert db.query(Stock).filter(Stock.id == stock_id).one().note == text_value


def test_empty_string_clears_note(api):
    client, db = api
    stock_id = _create(client)
    client.put(f"/stocks/{stock_id}", json={"note": "先写点什么"})

    cleared = client.put(f"/stocks/{stock_id}", json={"note": ""})
    assert cleared.status_code == 200
    assert cleared.json()["note"] == ""
    # 必须是空串而不是 None：exclude_none 会把 null 丢掉，清空只能靠空串
    assert db.query(Stock).filter(Stock.id == stock_id).one().note == ""


def test_omitting_note_keeps_it(api):
    client, _ = api
    stock_id = _create(client)
    client.put(f"/stocks/{stock_id}", json={"note": "别把我弄丢"})

    renamed = client.put(f"/stocks/{stock_id}", json={"name": "贵州茅台酒"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "贵州茅台酒"
    assert renamed.json()["note"] == "别把我弄丢"


def test_null_does_not_clear_note(api):
    client, _ = api
    stock_id = _create(client)
    client.put(f"/stocks/{stock_id}", json={"note": "保留"})

    # 这一条锁定 exclude_none 的既有语义：null 被丢弃 ⇒ 不清空。前端清空必须发 ""
    result = client.put(f"/stocks/{stock_id}", json={"note": None})
    assert result.status_code == 200
    assert result.json()["note"] == "保留"


def test_overlong_note_rejected(api):
    client, _ = api
    stock_id = _create(client)

    too_long = client.put(f"/stocks/{stock_id}", json={"note": "x" * 501})
    assert too_long.status_code == 422

    at_limit = client.put(f"/stocks/{stock_id}", json={"note": "中" * 500})
    assert at_limit.status_code == 200
    assert len(at_limit.json()["note"]) == 500


def test_m140_adds_column_idempotently(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    with engine.begin() as conn:
        # 老库：还没有 note 列，且已有数据
        conn.execute(text(
            "CREATE TABLE stocks (id INTEGER PRIMARY KEY, symbol VARCHAR NOT NULL, "
            "name VARCHAR NOT NULL, market VARCHAR NOT NULL)"
        ))
        conn.execute(text(
            "INSERT INTO stocks (id, symbol, name, market) VALUES (1, '600519', '贵州茅台', 'CN')"
        ))

    with engine.begin() as conn:
        _m140_stock_note(conn)
        _m140_stock_note(conn)  # 跑两次必须无副作用（_add_column_if_missing 自带幂等）

    columns = {c["name"]: c for c in inspect(engine).get_columns("stocks")}
    assert "note" in columns
    assert columns["note"]["nullable"] is True

    with engine.connect() as conn:
        row = conn.execute(text("SELECT symbol, note FROM stocks WHERE id = 1")).one()
    assert row[0] == "600519"
    assert row[1] is None  # 老数据保留，新列为 NULL，读取时由 `or ""` 归一
    engine.dispose()

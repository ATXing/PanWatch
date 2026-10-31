"""SQLite 连接层对「短暂打不开」的处理。

背景（2026-10-27 线上现象）：服务进程 + UZI 子进程共用同一个 SQLite 库，
NullPool 下连接用完即关，WAL 的 -wal/-shm 随最后一条连接关闭被删、下一条
再建。Windows 上偶发 SQLITE_CANTOPEN（"unable to open database file"），
表现为盘前/调研请求突然 500，几秒后又自愈。

这里锁定三件事：
1. 这类错误被判为「可重试」，而真正的语法/路径错误不会；
2. 连接层会重试并在后续成功；
3. 重试仍失败时抛出，交给上层转成可读的 503。
"""

import sqlite3

import pytest
from sqlalchemy.exc import OperationalError

from src.platform.persistence import database


def test_cantopen_is_treated_as_transient():
    assert database._is_transient_open_error(
        sqlite3.OperationalError("unable to open database file")
    )
    assert database._is_transient_open_error(sqlite3.OperationalError("database is locked"))
    assert not database._is_transient_open_error(sqlite3.OperationalError("no such table: foo"))


def test_lock_detection_walks_sqlalchemy_cause_chain():
    inner = sqlite3.OperationalError("unable to open database file")
    wrapped = OperationalError("SELECT 1", {}, inner)
    assert database._is_sqlite_lock_error(wrapped)


def test_connect_retries_transient_failures(monkeypatch):
    calls = {"n": 0}
    real_connect = sqlite3.connect

    def flaky_connect(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise sqlite3.OperationalError("unable to open database file")
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(database.sqlite3, "connect", flaky_connect)
    conn = database._connect_sqlite()
    try:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    finally:
        conn.close()
    assert calls["n"] == 3


def test_connect_gives_up_on_persistent_failure(monkeypatch):
    attempts = {"n": 0}

    def always_fail(*args, **kwargs):
        attempts["n"] += 1
        raise sqlite3.OperationalError("unable to open database file")

    monkeypatch.setattr(database.sqlite3, "connect", always_fail)
    with pytest.raises(sqlite3.OperationalError):
        database._connect_sqlite()
    assert attempts["n"] == len(database.SQLITE_CONNECT_RETRY_DELAYS) + 1


def test_connect_does_not_retry_real_errors(monkeypatch):
    attempts = {"n": 0}

    def broken(*args, **kwargs):
        attempts["n"] += 1
        raise sqlite3.OperationalError("no such function: definitely_missing")

    monkeypatch.setattr(database.sqlite3, "connect", broken)
    with pytest.raises(sqlite3.OperationalError):
        database._connect_sqlite()
    assert attempts["n"] == 1


def test_db_path_has_no_parent_segments():
    assert ".." not in database.DB_PATH
    assert database.DB_PATH.endswith("panwatch.db")

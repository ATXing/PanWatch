"""Run blocking database operations with a worker-owned session."""

import asyncio
import logging
from collections.abc import Callable
from typing import TypeVar

from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

T = TypeVar("T")

# WAL 下偶尔会拿到 "attempt to write a readonly database"（另一端关闭连接时删掉
# -wal/-shm 的瞬间，见 database.py 的锚连接说明）或 "database is locked"。
# 这类失败都是亚秒级的，重开一个 session 重跑即可。
#
# 重试安全性：research 全链路的写操作都幂等 —— start 用 on_conflict_do_nothing、
# progress/fail 是整字段覆盖写、commit 先查 existing 再写；且 readonly / locked
# 在事务的第一个写语句就会抛出，此时 operation 里的副作用代码还没执行，
# 因此重跑不会产生重复落库或重复通知。
RETRY_MESSAGE_HINTS = (
    "readonly database",
    "database is locked",
    "database table is locked",
    "unable to open database file",
)
RETRY_DELAYS = (0.05, 0.15, 0.4)


def _is_retryable(exc: BaseException) -> bool:
    """SQLAlchemy 会把 DBAPI 异常包一层，沿 __cause__ 链找原始文案。"""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if any(hint in str(current).lower() for hint in RETRY_MESSAGE_HINTS):
            return True
        current = current.__cause__ or current.__context__
    return False


async def run_db_operation(bind, operation: Callable[[Session], T]) -> T:
    """Finish an in-flight transaction before propagating cancellation.

    Return plain data or fully loaded values; the worker closes its session
    before returning and never shares the caller's identity map.
    """

    def run():
        with Session(bind=bind, expire_on_commit=False) as db:
            return operation(db)

    total_attempts = len(RETRY_DELAYS) + 1
    for attempt in range(total_attempts):
        if attempt:
            await asyncio.sleep(RETRY_DELAYS[attempt - 1])
        pending = asyncio.create_task(asyncio.to_thread(run))
        try:
            return await asyncio.shield(pending)
        except asyncio.CancelledError:
            await pending
            raise
        except OperationalError as exc:
            if attempt >= total_attempts - 1 or not _is_retryable(exc):
                raise
            logger.warning(
                "数据库写遇到瞬时错误，%.2fs 后重试 (%s/%s): %s",
                RETRY_DELAYS[attempt],
                attempt + 1,
                total_attempts - 1,
                str(exc).splitlines()[0][:200],
            )
    raise RuntimeError("db operation retries exhausted")  # pragma: no cover

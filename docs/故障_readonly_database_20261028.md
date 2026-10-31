# 故障：`attempt to write a readonly database`（2026-10-28）

## 现象

盘中监测（`intraday_monitor`）每 30 分钟一轮、每轮 2 只票串行执行，
其中一只报错：

```
AI 服务调用失败，请检查模型配置或稍后重试。（code=e3q8 ·
(sqlite3.OperationalError) attempt to write a readonly database
[SQL: UPDATE research_runs SET progress=? WHERE research_runs.id = ?]）
```

`agent_runs` 里记为 `single mode executed 1, skipped 0, total 2`。
盘前分析（`premarket_outlook`）09:00 也栽在同一个错误上。

## 关键时间规律

失败几乎总落在**每轮第 2 只票、启动后 3 秒内**（成功那只通常跑 29 秒左右）：

| 轮次（北京） | 第 1 只 | 第 2 只 |
|---|---|---|
| 09:30 | completed | **failed**（10 秒） |
| 10:00 | **failed**（35 秒） | **failed**（3 秒） |
| 10:30 | completed | completed |
| 11:00 | completed | **failed**（3 秒） |

「3 秒就挂」说明它在**第一次写库**时就失败了，而不是 AI 调用或数据获取出错。
错误文案里的「AI 服务调用失败」是外层的兜底包装，具有误导性。

## 排查过程

排除掉的：

- 文件属性：`attrib` 显示 `A`（普通归档），**不是只读**
- 磁盘空间：D 盘 229G 可用
- 数据完整性：`PRAGMA quick_check` = ok
- 连接串：全项目无 `mode=ro` / `immutable=1`
- 文件权限：外部进程独立测试 `BEGIN IMMEDIATE` **可写成功**

真正的线索：**服务在跑，但 `data/` 目录下没有 `-wal` / `-shm` 文件。**

## 根因

`journal_mode = WAL`，而 WAL 模式下**最后一个连接关闭时**，SQLite 会 checkpoint
并删除 `-wal` / `-shm`。本项目用 `NullPool`（每请求开一个连接、用完即关），
于是**每个请求连接都可能是「最后一个连接」**。

若此刻另一端正在建连接并写入，就会拿到 `attempt to write a readonly database`。

`database.py` 原有注释已经记录过同一根因的另一个表现（`SQLITE_CANTOPEN`
"unable to open database file"），并加了重试，但判据只覆盖了
`unable to open` / `database is locked`，**没有覆盖 `readonly database`**。

### 为什么「请求间隙」越大越容易挂

在库副本上做对照实验（A = 每次开关连接 / B = 持有一个常驻连接）：

| 每次写之后的间隙 | A 现状 | B 常驻连接 |
|---|---|---|
| 0（满速，连接永远重叠） | 7/640 = 1.09% | 0/640 = **0%** |
| 20 ms | 8/160 = 5.00% | 0/160 = **0%** |
| **50 ms（接近真实）** | **58/160 = 36.25%** | 0/160 = **0%** |

满速时线程间的连接互相重叠，几乎不出现「零连接」瞬间，所以只有 1%；
一旦请求之间有间隙（真实服务里一只票跑完后几十秒不写库），
「零连接」频繁出现，失败率飙到 36%。这与线上每轮挂一只的观感一致。

## 修复

改两个文件（备份在同目录 `*.bak-20261028-wal-anchor`）：

### 1. `src/platform/persistence/database.py` — WAL 锚连接（治本）

新增 `hold_wal_anchor()`：保留一个**永不关闭**的空闲连接，把 `-wal` / `-shm`
的生命期从「最后一个请求连接」改绑到「进程」。在 `init_db()` 末尾调用。

代价是 WAL 文件常驻磁盘，auto-checkpoint（默认 1000 页 ≈ 4MB）会持续回收，
不会无限增长。实测常驻大小 4.16 MB。

同时把 `readonly database` 加入 `_is_transient_open_error()` 判据。

### 2. `src/platform/persistence/worker.py` — 事务层重试（兜底）

`run_db_operation` 遇到 `readonly` / `locked` 时重开 session 重跑，
最多 4 次尝试（间隔 0.05 / 0.15 / 0.4 秒）。

**重试安全性**：research 全链路写操作都幂等 —— `start` 用
`on_conflict_do_nothing`、`progress` / `fail` 是整字段覆盖写、`commit` 先查
`existing`；且 `readonly` / `locked` 在事务的第一个写语句就抛出，此时
`operation` 里的副作用代码还没执行，重跑不会重复落库或重复通知。

判据只放行这两类文案，`no such column` 等真实 SQL 错误和业务异常照常抛出，
不会被重试掩盖（已单测验证）。

## 验证

- 对照实验：A 组 36.25% → B 组 0%（见上表）
- 62 个既有测试全过（`test_database` / `test_db_transient_connect` /
  `test_research_migration` / `test_research_signals` / `test_research_reporting` /
  `test_investment_research_integration`）
- 重启后：`data/panwatch.db-wal` 常驻 4.16 MB；外部另开连接再关闭，`-wal`
  **不再被删除**（重启前该目录下根本没有 `-wal`）

## 遗留

- 锚连接只保护「主服务进程」。若将来有**长时间不关闭的子进程**参与写库
  （UZI 调研、批量排雷），同样逻辑需要在子进程侧建立锚连接。
- `get_db()` 依赖注入的 249 处写路径没有加事务重试，只受锚连接保护。
  若根因重新出现，这些路径仍需单独处理。
- 服务以 `run_in_background` 方式启动，仍会被沙箱回收（历史实测 10–30 小时）。
  与本故障无关，但会中断盘中监测。

## 诊断脚本（可复现）

`_trash/20261028_readonly根因排查/`：

- `_diag_readonly.py` — 满速压测复现
- `_diag_keepalive.py` — A/B 对照，支持 `DIAG_GAP` 环境变量模拟真实请求节奏
- `_diag_e2e.py` — 用真实 `run_db_operation` 端到端验证

均在库副本上运行，不触碰生产库。副本可由 `shutil.copy2` 重建。

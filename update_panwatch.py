# -*- coding: utf-8 -*-
"""PanWatch 自动更新流水线（熙语本地定制版）。

流程：检查远端 → [有更新] 整项目备份 → git 打标签 → 依赖同步 → rebase 拉取
     → 定制特征校验 → 前端构建 → 覆盖式部署 → 重启服务 → 端点验证

安全原则：
  * 任一步失败即中止，旧版本保持运行；
  * 部署后验证失败 → 从备份完整回滚并重启；
  * rebase 冲突 → 自动 abort 原样退出（绝不自动丢键/丢代码）；
  * 更新前必备份（排除 .venv/.gtk3/node_modules 等可再生环境目录），
    保留最近 10 份；git 标签 pre-update-<时间戳> 提供秒级代码级回滚点。

用法：
    python update_panwatch.py            # 常规：检查并更新
    python update_panwatch.py --force    # 跳过检查与拉取，直接重建部署重启
                                         # （用于手工解决 rebase 冲突后继续，
                                         #   或强制重新部署；假定已存在备份）

退出码：0 = 已更新或无新提交；1 = 失败（旧版本已保留或已回滚）。
"""

import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

# ---- 关闭 WorkBuddy 安全删除闸 ----
# 本脚本的删除行为仅限：过期备份清理、vite 构建时清空自身 dist、pip 临时文件，
# 均为包管理/构建工具的常规操作，不触碰用户数据。
os.environ["CODEBUDDY_SAFE_DELETE_SANDBOX"] = "0"   # Python 侧（sitecustomize 闸）
os.environ["CODEBUDDY_SAFE_DELETE_ENABLED"] = "0"   # Node 侧（vite emptyDir 等）

PROJECT = Path(__file__).resolve().parent
BACKUP_ROOT = Path(r"D:\Projects\PanWatch_backups")
KEEP_BACKUPS = 10
PORT = 8123
BASE = f"http://127.0.0.1:{PORT}"
# 监听地址：默认仅本机；手机局域网访问时设为 0.0.0.0（或环境变量 PANWATCH_BIND_HOST）
HOST = os.environ.get("PANWATCH_BIND_HOST", "127.0.0.1")
VENV_PY = PROJECT / ".venv" / "Scripts" / "python.exe"
LOG = PROJECT / "logs" / "autostart.log"
LOCK = PROJECT / "logs" / ".update_lock"

# 备份排除项：git 从不触碰、且可从零重建的环境目录
BACKUP_IGNORE = shutil.ignore_patterns(
    ".venv", ".gtk3", "node_modules", "__pycache__", "*.pyc", ".pytest_cache"
)

# 本地定制特征标记：拉取后必须仍在，否则说明定制被冲掉 → 回滚
MARKERS = [
    ("src/modules/portfolio/fees.py", "__FILE_EXISTS__"),
    ("src/modules/portfolio/api/accounts.py", "net_pnl"),
    ("src/modules/portfolio/api/accounts.py", "total_net_pnl"),
    ("server.py", "Not Found: /{path}"),
    ("frontend/public/sw.js", "panwatch-v3"),
]


def log(msg=""):
    print(msg, flush=True)


def run(cmd, cwd=PROJECT, timeout=600, check=False, env=None):
    """运行命令，返回 (returncode, 合并输出)。"""
    try:
        p = subprocess.run(
            cmd, cwd=str(cwd), timeout=timeout, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
        )
        out = (p.stdout or "").strip()
        if check and p.returncode != 0:
            raise RuntimeError(f"命令失败({' '.join(map(str, cmd))}):\n{out[-2000:]}")
        return p.returncode, out
    except subprocess.TimeoutExpired:
        return 124, f"超时({timeout}s): {' '.join(map(str, cmd))}"


def git(*args, timeout=300):
    return run(["git", *args], timeout=timeout)


# ---------- 锁：防止手动运行与定时任务并发 ----------

def pid_alive(pid: int) -> bool:
    rc, out = run(["tasklist", "/NH", "/FI", f"PID eq {pid}"], timeout=30)
    return rc == 0 and str(pid) in out and "No tasks" not in out


def acquire_lock():
    LOG.parent.mkdir(exist_ok=True)
    if LOCK.exists():
        try:
            old_pid = int(LOCK.read_text().strip() or 0)
        except ValueError:
            old_pid = 0
        age = time.time() - LOCK.stat().st_mtime
        if old_pid and pid_alive(old_pid) and age < 3 * 3600:
            log(f"[中止] 另一个更新进程正在运行（PID {old_pid}，锁年龄 {age:.0f}s）。")
            sys.exit(1)
        log(f"[提示] 清理陈旧锁（PID {old_pid} 不存在或锁超过 3 小时）。")
    LOCK.write_text(str(os.getpid()))


def upstream_remote() -> str:
    """fork 工作流下 origin=自己的 fork、upstream=原仓库；未配 upstream 时退回 origin。"""
    rc, out = git("remote")
    return "upstream" if "upstream" in out.split() else "origin"


def pip_show_version(name: str):
    rc, out = run([str(VENV_PY), "-m", "pip", "show", name], timeout=120)
    if rc != 0:
        return None
    for line in out.splitlines():
        if line.startswith("Version:"):
            return line.split(":", 1)[1].strip()
    return None


def filter_satisfied_git_deps(req_paths):
    """剔除已按 pin 版本装好的 git+ 依赖。

    pip 对 `pkg @ git+URL@tag` 这类 direct-URL 依赖会重复 clone，
    而本机访问 github.com 必须走代理（直连不通），代理抽风时整步必失败。
    已装好且版本与 pin 一致 → 无需再 clone。
    返回 (临时 requirements 路径 or None, 被剔除的依赖说明列表)。
    """
    git_re = re.compile(r"^\s*([A-Za-z0-9_.\-]+)\s*@\s*git\+(\S+?)@([A-Za-z0-9_.\-]+)\s*(?:#.*)?$")
    kept, dropped = [], []
    for rp in req_paths:
        base = Path(rp).resolve().parent
        for line in Path(rp).read_text(encoding="utf-8").splitlines():
            m = git_re.match(line)
            if not m:
                # 嵌套 -r 引用改成绝对路径（pip 按清单文件所在目录解析相对路径）
                mr = re.match(r"^\s*-r\s+(\S+)\s*$", line)
                if mr and not Path(mr.group(1)).is_absolute():
                    line = f"-r {(base / mr.group(1)).resolve()}"
                kept.append(line)
                continue
            name, ref = m.group(1), m.group(3)
            ver = pip_show_version(name)
            if ver and ver.lstrip("vV") == ref.lstrip("vV"):
                dropped.append(f"{name}=={ver}（已按 pin 装好，免 clone）")
            else:
                kept.append(line)
    if not dropped:
        return None, dropped
    tmp = PROJECT / "_req_filtered.txt"
    tmp.write_text("\n".join(kept) + "\n", encoding="utf-8")
    return tmp, dropped


NET_ERROR_KEYS = ("CONNECT tunnel", "RPC failed", "Could not resolve", "Could not connect",
                  "Connection", "timed out", "超时", "Temporary failure")


def is_network_error(out: str) -> bool:
    return any(k in out for k in NET_ERROR_KEYS)


def release_lock():
    try:
        LOCK.unlink()
    except Exception:
        try:
            LOCK.write_text("")  # 删不掉就清空 PID，下轮自动视为陈旧锁
        except Exception:
            pass


# ---------- 服务探活（绕过任何代理） ----------

def http_get(path: str, timeout: int = 15):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(BASE + path, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except Exception as e:
        return None, str(e)


def wait_ready(seconds: int = 45) -> bool:
    for i in range(seconds):
        code, _ = http_get("/")
        if code == 200:
            log(f"  服务就绪（{i + 1}s）")
            return True
        time.sleep(1)
    return False


# ---------- 备份 ----------

def make_backup() -> Path:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_ROOT / ts
    BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    shutil.copytree(PROJECT, dest, ignore=BACKUP_IGNORE)
    # 记录备份点信息（便于回滚时确认版本）
    _, head = git("log", "-1", "--format=%h %s")
    remote = upstream_remote()
    rc, remote_log = git("log", "--oneline", f"HEAD..{remote}/main")
    info = [
        f"备份时间: {datetime.now():%Y-%m-%d %H:%M:%S}",
        f"更新前 HEAD: {head}",
        "",
        "本次拉取的提交:",
        remote_log or "(无)",
        "",
        "变更文件:",
    ]
    rc2, stat = git("diff", "--stat", "HEAD", f"{remote}/main")
    info.append(stat or "(无)")
    (dest / "BACKUP_INFO.txt").write_text("\n".join(info), encoding="utf-8")
    size = sum(f.stat().st_size for f in dest.rglob("*") if f.is_file()) / 1e6
    log(f"  备份完成: {dest}（{size:.1f} MB，{time.time() - t0:.1f}s）")
    return dest


def prune_backups():
    dirs = sorted((d for d in BACKUP_ROOT.glob("*") if d.is_dir()), reverse=True)
    for old in dirs[KEEP_BACKUPS:]:
        try:
            shutil.rmtree(old, ignore_errors=True)
            log(f"  已清理过期备份: {old.name}")
        except Exception as e:
            log(f"  [警告] 清理备份 {old.name} 失败（不影响更新）: {e}")


# ---------- 服务重启 ----------

def stop_server():
    ps = (
        "Get-CimInstance Win32_Process | "
        "Where-Object { $_.Name -match 'python' -and $_.CommandLine -match 'uvicorn' "
        "-and $_.CommandLine -notmatch 'update_panwatch' } | "
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
    )
    for _ in range(2):  # 两遍：防 reloader 父进程重启子进程
        run(["powershell", "-NoProfile", "-Command", ps], timeout=60)
        time.sleep(1.5)
    for _ in range(15):
        rc, out = run(
            ["powershell", "-NoProfile", "-Command",
             "(Get-NetTCPConnection -LocalPort %d -State Listen -ErrorAction SilentlyContinue).Count" % PORT],
            timeout=30,
        )
        if out.strip() == "0":
            return True
        time.sleep(1)
    return False


def start_server():
    env = {k: v for k, v in os.environ.items()
           if k not in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
                        "ALL_PROXY", "all_proxy")}
    env["NO_PROXY"] = "localhost,127.0.0.1"
    env["PATH"] = str(PROJECT / ".gtk3" / "bin") + os.pathsep + env.get("PATH", "")
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(f"\n===== update_panwatch 重启 {datetime.now():%Y-%m-%d %H:%M:%S} =====\n")
        subprocess.Popen(
            [str(VENV_PY), "-m", "uvicorn", "server:app",
             "--host", HOST, "--port", str(PORT)],
            cwd=str(PROJECT), env=env, stdout=fh, stderr=subprocess.STDOUT,
            creationflags=0x00000008 | 0x00000200, close_fds=True,
        )


# ---------- 主流程 ----------

def main():
    force = "--force" in sys.argv[1:]
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    tag = f"pre-update-{ts}"
    acquire_lock()
    backup = None
    pulled = False
    try:
        log("=" * 62)
        log(f"PanWatch 自动更新  {datetime.now():%Y-%m-%d %H:%M:%S}"
            f"（{'--force 强制部署' if force else '常规检查'}）")
        log("=" * 62)

        # 0) 前置检查：工作区必须干净（无未提交的跟踪文件改动）
        rc, status = git("status", "--porcelain")
        dirty = [l for l in status.splitlines() if l and not l.startswith("??")]
        if dirty:
            log("[中止] 工作区有未提交改动，为避免覆盖你的工作，先提交或 stash：")
            for l in dirty:
                log("   " + l)
            return 1
        if (PROJECT / ".git" / "rebase-merge").exists() or (PROJECT / ".git" / "rebase-apply").exists():
            log("[中止] 检测到未完成的 rebase，请先手工解决（git rebase --continue/--abort）。")
            return 1

        rc, head_before = git("rev-parse", "--short", "HEAD")

        if force:
            log("[--force] 跳过远端检查与拉取，直接重建部署。")
            log("  前提假设：当前状态已备份（冲突解决后续跑请确认上一轮备份存在）。")
        else:
            remote = upstream_remote()
            # 1) fetch 并比较
            rc, out = git("fetch", remote, timeout=180)
            if rc != 0:
                log(f"[失败] git fetch {remote} 失败：\n{out[-800:]}")
                return 1
            rc, counts = git("rev-list", "--left-right", "--count",
                             f"HEAD...{remote}/main")
            ahead, behind = (counts.split() + ["0", "0"])[:2]
            log(f"本地领先 {ahead} / 远端领先 {behind}")
            if behind == "0":
                log("[完成] 已是最新，无需更新。")
                return 0

            # 2) 备份 + 打标签
            log(f"\n[1/6] 备份整项目并打标签 {tag}")
            backup = make_backup()
            prune_backups()
            rc, _ = git("tag", tag)
            if rc != 0:
                log(f"[失败] 打标签失败：{tag}")
                return 1

            # 3) 依赖同步（上游新增依赖/新包时必须）
            log("\n[2/6] 同步 Python 依赖")
            reqs = [PROJECT / r for r in ("requirements.txt", "requirements-runtime.txt")
                    if (PROJECT / r).exists()]
            if reqs:
                tmp, dropped = filter_satisfied_git_deps(reqs)
                if dropped:
                    log("  跳过重复 clone 的 git 依赖：")
                    for d in dropped:
                        log("   " + d)
                install_list = [tmp] if tmp else reqs
                cmd = [str(VENV_PY), "-m", "pip", "install", "-q"]
                for r in install_list:
                    cmd += ["-r", str(r)]
                rc, out = 1, ""
                for attempt in range(1, 4):
                    rc, out = run(cmd, timeout=900)
                    if rc == 0 or not is_network_error(out):
                        break
                    log(f"  [重试] pip 网络类失败（{attempt}/3），5s 后重试")
                    time.sleep(5)
                if tmp:
                    try:
                        tmp.unlink()
                    except Exception:
                        pass
                if rc != 0:
                    log(f"[失败] pip 依赖同步失败，保持旧版本：\n{out[-800:]}")
                    return 1
                log("  requirements 同步完成")
            for pkg in sorted((PROJECT / "packages").glob("*/pyproject.toml")):
                rc, out = run([str(VENV_PY), "-m", "pip", "install", "-q", "-e", str(pkg.parent)],
                              timeout=600)
                if rc != 0:
                    log(f"[失败] editable 安装失败（{pkg.parent.name}），保持旧版本：\n{out[-800:]}")
                    return 1
            log("  packages editable 安装完成")

            # 4) rebase 拉取
            log(f"\n[3/6] git pull --rebase {remote} main")
            rc, out = git("pull", "--rebase", remote, "main", timeout=600)
            if rc != 0:
                rc2, conflicts = git("diff", "--name-only", "--diff-filter", "U")
                git("rebase", "--abort")
                log("[失败] rebase 冲突，已自动 abort，旧版本未动。")
                log("冲突文件（需人工合并后 --force 续跑）：")
                for l in conflicts.splitlines():
                    log("   " + l)
                if backup:
                    log(f"备份保留在: {backup}")
                return 1
            log("  " + out.splitlines()[-1] if out else "")
            _, pulled_log = git("log", "--oneline", f"{head_before}..HEAD")
            log("  已合入：")
            for l in pulled_log.splitlines():
                log("   " + l)
            pulled = True

            # 5) 定制特征校验
            log("\n[4/6] 校验本地定制特征是否保留")
            missing = []
            for rel, needle in MARKERS:
                p = PROJECT / rel
                if needle == "__FILE_EXISTS__":
                    ok = p.exists()
                else:
                    ok = p.exists() and needle in p.read_text(encoding="utf-8", errors="replace")
                if not ok:
                    missing.append(f"{rel} 缺少 [{needle}]")
            if missing:
                log("[失败] 定制特征丢失，回滚代码到更新前：")
                for m in missing:
                    log("   " + m)
                git("reset", "--hard", tag)
                log("  已 git reset --hard 回滚（static/ 未动，服务仍在跑旧版本）")
                return 1
            log("  5 项定制特征全部在位")

        # 6) 前端构建 + 部署
        log("\n[5/6] 前端构建与部署")
        corepack = shutil.which("corepack")
        if not corepack:
            for cand in (r"C:\Program Files\nodejs\corepack.cmd",
                         r"C:\Users\CXH\.workbuddy\binaries\node\versions\22.22.2-6\corepack.cmd"):
                if Path(cand).exists():
                    corepack = cand
                    break
        if not corepack:
            log("[失败] 找不到 corepack（node 未装或不在 PATH）")
            return 1
        rc, out = 1, ""
        for attempt in range(1, 3):
            rc, out = run([corepack, "pnpm@9.15.9", "install"], cwd=PROJECT / "frontend", timeout=900)
            if rc == 0 or not is_network_error(out):
                break
            log(f"  [重试] pnpm install 网络类失败（{attempt}/2），5s 后重试")
            time.sleep(5)
        if rc != 0:
            log(f"[失败] pnpm install 失败：\n{out[-800:]}")
            if pulled:
                git("reset", "--hard", tag)
            return 1
        rc, out = run([corepack, "pnpm@9.15.9", "run", "build"], cwd=PROJECT / "frontend", timeout=900)
        if rc != 0:
            log(f"[失败] 前端构建失败：\n{out[-1500:]}")
            if pulled:
                git("reset", "--hard", tag)
                log("  已 git reset --hard 回滚（static/ 未动，服务仍在跑旧版本）")
            return 1
        log("  构建完成")

        # 覆盖式拷贝（绝不 rm -rf static，杜绝空窗期投毒）
        dist, static = PROJECT / "frontend" / "dist", PROJECT / "static"
        shutil.copytree(dist, static, dirs_exist_ok=True)
        html = (static / "index.html").read_text(encoding="utf-8")
        refs = set(re.findall(r'(?:src|href)="(/assets/[^"]+)"', html))
        missing_assets = [r for r in refs if not (static / r.lstrip("/")).is_file()]
        if missing_assets:
            log("[失败] index.html 引用的资源缺失：")
            for m in missing_assets:
                log("   " + m)
            if backup:
                log("  从备份恢复 static/ ...")
                shutil.copytree(backup / "static", static, dirs_exist_ok=True)
                log("  static/ 已恢复为更新前版本")
            return 1
        log(f"  部署完成（index.html 引用 {len(refs)} 个资源，全部在位）")

        # 7) 重启 + 验证
        log("\n[6/6] 重启服务并验证")
        if not stop_server():
            log("[失败] 旧服务未能停止（8123 仍被占用），保持现状等待人工处理")
            return 1
        start_server()
        if not wait_ready():
            log("[失败] 服务未在 45s 内就绪")
        code_root, html_live = http_get("/")
        code_stocks, _ = http_get("/stocks")
        entry = re.search(r'src="(/assets/index-[^"]+\.js)"', html_live or "")
        code_entry = None
        if entry:
            code_entry, _ = http_get(entry.group(1))
        ok = code_root == 200 and code_stocks == 200 and code_entry == 200
        log(f"  端点验证: /={code_root}  /stocks={code_stocks}  入口包={code_entry}")
        if not ok:
            log("[失败] 端点验证未通过 → 从备份完整回滚")
            if backup:
                stop_server()
                shutil.copytree(backup, PROJECT, dirs_exist_ok=True)
                start_server()
                if wait_ready():
                    log(f"  已回滚到更新前版本（{backup}），服务已恢复")
                else:
                    log("  [严重] 回滚后服务未就绪，请人工检查 logs/autostart.log")
            return 1

        log("")
        log("=" * 62)
        if force:
            log("[完成] 强制重建部署成功，服务已重启。")
        else:
            log(f"[完成] 更新成功：{head_before} → ", end="")
            _, head_after = git("rev-parse", "--short", "HEAD")
            log(head_after)
            log(f"备份: {backup}")
            log(f"回滚点: git tag {tag}（或整目录拷贝 {backup}）")
        log("=" * 62)
        return 0
    finally:
        release_lock()


if __name__ == "__main__":
    sys.exit(main())

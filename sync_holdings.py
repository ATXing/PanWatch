# -*- coding: utf-8 -*-
"""熙语持仓台账 → PanWatch 持仓同步脚本。

用  法：
    python sync_holdings.py               # 正常同步（自动跳过无变化的行）
    python sync_holdings.py --dry-run     # 预演：只打印将发生的变更，不写入
    python sync_holdings.py --prune       # 额外删除 CSV 中已移除的持仓（默认不删，安全优先）
    python sync_holdings.py --csv <path>  # 指定台账路径

凭  据（按顺序取值，避免密码进代码）：
    1. 环境变量 PANWATCH_USER / PANWATCH_PASS
    2. D:\\Drive\\Obsidian\\05-搞钱\\01-股票\\持仓\\.panwatch_cred.json
       内容 {"username": "...", "password": "..."}
       ★ 刻意放在 git 仓库「外」，避免误提交到 PanWatch 仓库
    3. 脚本同目录 .panwatch_cred.json（兜底，已被 .gitignore 屏蔽）
    4. 命令行交互输入（getpass，不回显）

依赖：仅 Python 标准库（urllib / csv / json），无需 requests。
"""

import argparse
import csv
import getpass
import io
import json
import os
import sys
import unicodedata
import urllib.error
import urllib.request

BASE_URL = os.getenv("PANWATCH_URL", "http://127.0.0.1:8123")
DEFAULT_CSV = os.getenv(
    "HOLDINGS_CSV",
    r"D:\Drive\Obsidian\05-搞钱\01-股票\持仓\holdings.csv",
)
DEFAULT_ACCOUNTS_CSV = os.getenv(
    "ACCOUNTS_CSV",
    r"D:\Drive\Obsidian\05-搞钱\01-股票\持仓\accounts.csv",
)
# 凭据默认放在 git 仓库「外」（Obsidian 持仓目录），避免误提交；同目录文件仅作兜底
_OBS_HOLDINGS = os.getenv(
    "HOLDINGS_DIR",
    r"D:\Drive\Obsidian\05-搞钱\01-股票\持仓",
)
CRED_FILES = [
    os.path.join(_OBS_HOLDINGS, ".panwatch_cred.json"),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), ".panwatch_cred.json"),
]

# style 中文 → PanWatch trading_style
STYLE_MAP = {
    "波段": "swing", "swing": "swing",
    "价值": "long", "长线": "long", "long": "long",
    "短线": "short", "short": "short",
}
# ⚠️ 台账 style 留空时的默认值，必须显式传 "long"。
# 原因：PanWatch 的 positions.trading_style 列有 DEFAULT 'swing'
# （见 platform/persistence/database.py 的 ALTER TABLE），
# 传 None 会被 DB 悄悄落成「波段」，导致长线持仓被短线时钟打扰。
DEFAULT_STYLE = "long"
# ETF 代码段：沪市 5xxxxx，深市 15xxxx / 16xxxx（A 股个股无 1/5 开头，安全）
ETF_PREFIXES = ("5", "15", "16")

# 支持的市场；HK 代码需补满 5 位（PanWatch 约定：02020 而非 2020）
MARKETS = ("CN", "HK", "US")
# 各市场的计价币种。cost_price 必须以原币种填写，否则盈亏会被汇率算歪
CURRENCY_BY_MARKET = {"CN": "CNY", "HK": "HKD", "US": "USD"}


class ApiError(Exception):
    pass


class PanWatch:
    def __init__(self, base, token=None):
        self.base = base.rstrip("/")
        self.token = token

    def _req(self, method, path, payload=None):
        url = self.base + path
        data = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "ignore")
            try:
                body = json.loads(raw)
            except Exception:
                body = {"message": raw[:200]}
            raise ApiError("HTTP %s %s -> %s: %s" % (
                method, path, body.get("error_code") or body.get("code"),
                body.get("message") or body.get("detail"),
            ))
        except urllib.error.URLError as e:
            raise ApiError("连接失败 %s (%s)。PanWatch 服务是否已在 %s 运行？" % (path, e.reason, self.base))
        if not raw:
            return None
        body = json.loads(raw)
        return body.get("data") if isinstance(body, dict) and "data" in body else body

    def login(self, username, password):
        d = self._req("POST", "/api/auth/login", {"username": username, "password": password})
        if not isinstance(d, dict) or "token" not in d:
            raise ApiError("登录返回异常，未拿到 token：%s" % d)
        self.token = d["token"]
        return d

    def get(self, path):
        return self._req("GET", path)

    def post(self, path, payload):
        return self._req("POST", path, payload)

    def put(self, path, payload):
        return self._req("PUT", path, payload)

    def delete(self, path):
        return self._req("DELETE", path)


def load_credentials():
    """取值顺序：环境变量 → .panwatch_cred.json → 交互输入。"""
    u = os.getenv("PANWATCH_USER")
    p = os.getenv("PANWATCH_PASS")
    if u and p:
        return u, p, "环境变量"
    for cred_file in CRED_FILES:
        if os.path.exists(cred_file):
            try:
                with io.open(cred_file, encoding="utf-8-sig") as f:
                    c = json.load(f)
                if c.get("username") and c.get("password"):
                    return c["username"], c["password"], cred_file
            except Exception as e:
                print("[warn] 凭据文件解析失败：%s" % e)
    print("PanWatch 登录（账号密码仅用于取 token，不写入任何文件）")
    u = input("  用户名： ").strip()
    p = getpass.getpass("  密码： ")
    return u, p, "交互输入"


def _dw(s):
    """字符串显示宽度：中日韩全角字符按 2 计。"""
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)


def _pad(s, width, left=True):
    gap = " " * max(0, width - _dw(s))
    return (s + gap) if left else (gap + s)


def norm_market(code, raw_market):
    """推断/校验市场；港股代码统一补满 5 位（PanWatch 约定 02020 而非 2020）。"""
    m = (raw_market or "").strip().upper()
    if not m:
        # 推断：A 股为 6 位纯数字，港股为 1~5 位
        m = "CN" if (len(code) == 6 and code.isdigit()) else "HK"
    if m not in MARKETS:
        raise ValueError("不支持的 market：%s（只认 CN/HK/US）" % m)
    if m == "HK" and code.isdigit():
        code = code.zfill(5)
    return code, m


def parse_csv(path):
    """读台账，跳过 # 注释行与空行。返回 (rows, errors)。"""
    rows, errs = [], []
    with io.open(path, encoding="utf-8-sig") as f:
        # 跳过注释行与空行（注释块末尾的空行会被 DictReader 误当成表头）
        lines = [ln for ln in f if ln.strip() and not ln.lstrip().startswith("#")]
    reader = csv.DictReader(lines)
    for i, r in enumerate(reader, 1):
        if r is None:
            continue
        code = (r.get("code") or "").strip()
        if not code:
            continue
        try:
            code, market = norm_market(code, r.get("market"))
        except ValueError as e:
            errs.append("第 %d 行 %s：%s" % (i, code, e))
            continue
        want_cur = CURRENCY_BY_MARKET[market]
        cur = (r.get("currency") or "").strip().upper() or want_cur
        if cur != want_cur:
            # 这是最容易犯又最贵的错：港股填人民币成本，盈亏会被算歪
            errs.append("第 %d 行 %s：market=%s 应以 %s 计价，但 currency 填了 %s"
                        % (i, code, market, want_cur, cur))
            continue
        asset_type = (r.get("asset_type") or "").strip().lower() or None
        if not asset_type:
            asset_type = "etf" if (market == "CN" and code.startswith(ETF_PREFIXES)) else "stock"
        avail_raw = (r.get("avail_qty") or "").strip()
        # style：留空 → DEFAULT_STYLE；填了但不认识 → 报错（避免手滑写成「波断」被静默降级）
        raw_style = (r.get("style") or "").strip()
        if not raw_style:
            style = DEFAULT_STYLE
        elif raw_style in STYLE_MAP:
            style = STYLE_MAP[raw_style]
        else:
            errs.append("第 %d 行 %s：style 值「%s」无法识别，只接受 波段/价值/长线/短线"
                        % (i, code, raw_style))
            continue
        rows.append({
            "line": i,
            "source": (r.get("来源") or r.get("source") or "").strip(),
            "code": code,
            "market": market,
            "currency": cur,
            "name": (r.get("name") or code).strip(),
            "quantity": int(float((r.get("quantity") or "0").strip() or 0)),
            "avail_qty": int(float(avail_raw)) if avail_raw else None,
            "cost_price": float((r.get("cost_price") or "0").strip() or 0),
            "style": style,
            "account": (r.get("account") or "主账户").strip(),
            "open_date": (r.get("open_date") or "").strip(),
            "asset_type": asset_type,
        })
    return rows, errs


def load_accounts_csv(path):
    """读账户台账 {账户名: 可用资金}。文件不存在返回空字典。"""
    if not os.path.exists(path):
        return {}
    with io.open(path, encoding="utf-8-sig") as f:
        lines = [ln for ln in f if ln.strip() and not ln.lstrip().startswith("#")]
    out = {}
    for r in csv.DictReader(lines):
        name = (r.get("account") or "").strip()
        if not name:
            continue
        try:
            out[name] = float((r.get("available_funds") or "0").strip() or 0)
        except ValueError:
            print("[warn] accounts.csv 中 %s 的可用资金无法解析，已跳过" % name)
    return out


def main():
    ap = argparse.ArgumentParser(description="熙语持仓台账 → PanWatch 同步")
    ap.add_argument("--csv", default=DEFAULT_CSV, help="持仓台账路径")
    ap.add_argument("--accounts-csv", default=DEFAULT_ACCOUNTS_CSV, help="账户台账路径（可用资金）")
    ap.add_argument("--dry-run", action="store_true", help="预演，不写入")
    ap.add_argument("--prune", action="store_true", help="删除台账中已移除的持仓")
    ap.add_argument("--url", default=BASE_URL, help="PanWatch 地址")
    args = ap.parse_args()

    if not os.path.exists(args.csv):
        print("[error] 台账不存在：%s" % args.csv)
        return 2

    rows, errs = parse_csv(args.csv)
    if errs:
        print("[error] 台账有 %d 处问题，已中止（不做半截写入）：" % len(errs))
        for e in errs:
            print("   - " + e)
        return 2
    if not rows:
        print("[error] 台账没有有效数据行：%s" % args.csv)
        return 2

    # 校验：同账户内 (代码, 市场) 去重
    seen = {}
    dup = []
    for r in rows:
        k = (r["account"], r["code"], r["market"])
        if k in seen:
            dup.append("%s.%s@%s (第%d行 vs 第%d行)" % (
                r["code"], r["market"], r["account"], seen[k], r["line"]))
        seen[k] = r["line"]
    if dup:
        print("[error] 台账内有重复持仓，请先合并：")
        for d in dup:
            print("   - " + d)
        return 2

    if args.dry_run:
        acc_cash = load_accounts_csv(args.accounts_csv)
        print("== DRY RUN ==")
        by_mkt = {}
        for r in rows:
            by_mkt[r["market"]] = by_mkt.get(r["market"], 0) + 1
        print("台账：%s，共 %d 条（%s）" % (
            args.csv, len(rows),
            " / ".join("%s %d" % (k, v) for k, v in sorted(by_mkt.items()))))
        for r in rows:
            print("  %s %s %s %s %s %s  %s/%s" % (
                _pad(r["market"], 3), _pad(r["code"], 7), _pad(r["name"], 14),
                _pad("%d股" % r["quantity"], 9, left=False),
                _pad("@%.3f" % r["cost_price"], 10, left=False),
                _pad(r["currency"], 4), _pad(r["style"] or "未标风格", 9), r["asset_type"]))
        if acc_cash:
            for an, cash in acc_cash.items():
                print("  账户 %s 可用资金 %.2f" % (an, cash))
        return 0

    user, pwd, src = load_credentials()
    api = PanWatch(args.url)
    try:
        api.login(user, pwd)
    except ApiError as e:
        print("[error] 登录失败（凭据来源：%s）- %s" % (src, e))
        return 1

    # 1) Account（含可用资金，来自 accounts.csv）
    cash_map = load_accounts_csv(args.accounts_csv)
    accounts = api.get("/api/accounts") or []
    acc_map = {a["name"]: a["id"] for a in accounts}
    acc_cash_now = {a["name"]: float(a.get("available_funds") or 0) for a in accounts}
    for an in dict.fromkeys([r["account"] for r in rows]):
        cash = cash_map.get(an)
        if an not in acc_map:
            created = api.post("/api/accounts", {"name": an, "available_funds": cash or 0})
            acc_map[an] = created["id"]
            acc_cash_now[an] = cash or 0
            print("[新建] 账户 %s -> id=%d" % (an, created["id"]))
            continue
        if cash is None:
            continue
        if abs(acc_cash_now.get(an, 0.0) - cash) > 0.01:
            api.put("/api/accounts/%d" % acc_map[an], {"available_funds": cash})
            print("[更新] 账户 %s 可用资金 %.2f -> %.2f" % (an, acc_cash_now.get(an, 0.0), cash))
            acc_cash_now[an] = cash

    # 2) Stock（进自选库才有实时行情）；港股代码已补满 5 位
    stocks = api.get("/api/stocks") or []
    for_type = {}
    for s in stocks:
        for_type[(s.get("symbol"), s.get("market"))] = s
    for r in rows:
        key = (r["code"], r["market"])
        if key in for_type:
            continue
        payload = {"symbol": r["code"], "name": r["name"],
                   "market": r["market"], "asset_type": r["asset_type"]}
        created = api.post("/api/stocks", payload)
        for_type[key] = created
        print("[新建] 自选 %s.%s %s -> id=%s" % (
            r["code"], r["market"], r["name"], created.get("id")))

    # 3) Position
    all_pos = api.get("/api/positions") or []
    pos_map = {(p["account_id"], p["stock_id"]): p for p in all_pos}

    created_n = updated_n = skipped_n = 0
    for r in rows:
        acc_id = acc_map[r["account"]]
        stock = for_type.get((r["code"], r["market"]))
        if not stock:
            print("[跳过] %s.%s 未找到 stock id" % (r["code"], r["market"]))
            continue
        sid = stock.get("id")
        payload = {
            "account_id": acc_id,
            "stock_id": sid,
            "cost_price": r["cost_price"],
            "quantity": r["quantity"],
            "trading_style": r["style"],
        }
        payload["invested_amount"] = round(r["cost_price"] * r["quantity"], 2)
        existing = pos_map.get((acc_id, sid))
        if existing is None:
            api.post("/api/positions", payload)
            print("[新建] 持仓 %s.%s %s %d股 @%.3f %s (%s)" % (
                r["code"], r["market"], r["name"], r["quantity"],
                r["cost_price"], r["currency"], r["style"] or "-"))
            created_n += 1
        else:
            changed = []
            if float(existing.get("cost_price") or 0) != r["cost_price"]:
                changed.append("成本 %.2f→%.2f" % (float(existing.get("cost_price") or 0), r["cost_price"]))
            if int(existing.get("quantity") or 0) != r["quantity"]:
                changed.append("数量 %d→%d" % (int(existing.get("quantity") or 0), r["quantity"]))
            if (existing.get("trading_style") or None) != r["style"]:
                changed.append("风格 %s→%s" % (existing.get("trading_style"), r["style"]))
            if not changed:
                skipped_n += 1
                continue
            api.put("/api/positions/%d" % existing["id"], {
                "cost_price": r["cost_price"],
                "quantity": r["quantity"],
                "invested_amount": payload["invested_amount"],
                "trading_style": r["style"],
            })
            print("[更新] %s %s：%s" % (r["code"], r["name"], "，".join(changed)))
            updated_n += 1

    # 4) prune
    pruned_n = 0
    if args.prune:
        want = set()
        for r in rows:
            stock = for_type.get((r["code"], r["market"]))
            if stock:
                want.add((acc_map[r["account"]], stock.get("id")))
        for (aid, sid), p in pos_map.items():
            if (aid, sid) in want:
                continue
            if aid not in set(acc_map.values()):
                continue
            api.delete("/api/positions/%d" % p["id"])
            print("[删除] %s（台账中已移除）" % (p.get("stock_symbol") or p["id"]))
            pruned_n += 1

    print("")
    print("完成：新建 %d / 更新 %d / 无变化 %d / 删除 %d / 台账共 %d 条" % (
        created_n, updated_n, skipped_n, pruned_n, len(rows)))
    print("打开 %s 的「持仓」页刷新查看。" % args.url)
    return 0


if __name__ == "__main__":
    sys.exit(main())

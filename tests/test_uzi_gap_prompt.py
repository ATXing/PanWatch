"""uzi_gap_prompt 的回归测试。

重点守住四条「补了也白补」的边界：
1. 该市场不适用(weight=0)的维度不能被列成待补；
2. 有缺失时必须按 A/B/C 分档，且每维带上打分器真正读取的字段；
3. UZI 缓存在不在都不影响可用性(降级到维度级描述)；
4. 库里 note 的市场写错时(uzi_sync 已知 bug)不能把错误信号传给 agent。
"""

import json
import sqlite3

import pytest

from src.modules.research import uzi_gap_prompt as gapmod


def _mk_db(path, rows, stocks=None):
    conn = sqlite3.connect(path)
    try:
        conn.execute("CREATE TABLE stocks (symbol TEXT, market TEXT, name TEXT)")
        conn.execute(
            "CREATE TABLE uzi_reports (symbol TEXT, market TEXT, ticker_raw TEXT, tier TEXT,"
            " as_of_date TEXT, dim_status_json TEXT, score_integrity_json TEXT)"
        )
        for s in stocks or []:
            conn.execute("INSERT INTO stocks VALUES (?,?,?)", s)
        for r in rows:
            conn.execute("INSERT INTO uzi_reports VALUES (?,?,?,?,?,?,?)", r)
        conn.commit()
    finally:
        conn.close()


def _integrity(missing, real_dims=12, total=19, score=57.5, pct=67.6):
    return json.dumps(
        {
            "real_dims": real_dims,
            "total_dims": total,
            "real_score": score,
            "real_weight_pct": pct,
            "trusted": True,
            "missing": missing,
        },
        ensure_ascii=False,
    )


@pytest.fixture
def db(tmp_path, monkeypatch):
    p = tmp_path / "panwatch.db"
    monkeypatch.setattr(gapmod, "PANWATCH_DB", str(p))
    # 指向空目录，确保不会读到真实 UZI 缓存
    monkeypatch.setattr(gapmod, "UZI_SCRIPTS", str(tmp_path / "scripts"))
    return p


def test_no_report_returns_reason(db):
    _mk_db(db, [], [("688363", "CN", "华熙生物")])
    res = gapmod.build("688363", "CN")
    assert res["ok"] is False
    assert "还没有 UZI 报告" in res["reason"]


def test_missing_split_by_tier(db):
    missing = [
        {"key": "10_valuation", "status": "none", "note": "本次未采集", "weight": 5},
        {"key": "14_moat", "status": "none", "note": "无实测", "weight": 3},
        {"key": "8_materials", "status": "none", "note": "无实测", "weight": 3},
    ]
    _mk_db(db, [("688363", "CN", "688363.SH", "medium", "20261030", "{}", _integrity(missing))])
    res = gapmod.build("688363", "CN")
    assert res["ok"] is True
    assert res["n_missing"] == 3
    assert res["tier_counts"] == {"A": 1, "B": 1, "C": 1}
    # 分档标题必须出现，且 A 档在 B 档之前
    assert res["prompt"].index("档 A") < res["prompt"].index("档 B") < res["prompt"].index("档 C")


def test_weight_zero_excluded_as_skipped(db):
    """港股 16_lhb 权重为 0（该市场不适用），绝不能派给 agent 去补。"""
    missing = [
        {"key": "16_lhb", "status": "none", "note": "该市场不适用", "weight": 0},
        {"key": "10_valuation", "status": "none", "note": "本次未采集", "weight": 5},
    ]
    _mk_db(db, [("01951", "HK", "01951.HK", "medium", "20261030", "{}", _integrity(missing))])
    res = gapmod.build("01951", "HK")
    assert res["n_missing"] == 1
    assert "### 16_lhb" not in res["prompt"]
    assert "已剔除：16_lhb" in res["prompt"]


def test_zero_missing_says_no_need(db):
    _mk_db(
        db,
        [("600887", "CN", "600887.SH", "medium", "20261030", "{}", _integrity([], real_dims=19, score=70.0, pct=100.0))],
    )
    res = gapmod.build("600887", "CN")
    assert res["n_missing"] == 0
    assert "不需要补数" in res["prompt"]
    assert "档 A" not in res["prompt"]


def test_raw_data_absent_degrades_gracefully(db):
    """UZI 缓存被清理时仍要能生成 prompt，并说明字段明细缺失。"""
    missing = [{"key": "10_valuation", "status": "none", "note": "本次未采集", "weight": 5}]
    _mk_db(db, [("688363", "CN", "688363.SH", "medium", "20261030", "{}", _integrity(missing))])
    res = gapmod.build("688363", "CN")
    assert res["ok"] is True
    assert res["raw_note"]  # 有降级说明
    assert "字段级明细" in res["prompt"]
    assert "pe_quantile" in res["prompt"]  # 打分字段仍要给出


def test_raw_data_supplies_field_gaps(db, tmp_path):
    """有缓存时要把 UZI 已试过的查询与失败原因带进去，避免 agent 重复踩坑。"""
    ticker = "688363.SH"
    cache = tmp_path / "scripts" / ".cache" / ticker
    cache.mkdir(parents=True)
    (cache / "raw_data.json").write_text(
        json.dumps(
            {
                "dimensions": {
                    "8_materials": {
                        "fallback": True,
                        "data": {"_autofill_failed": {"query": "华熙生物 主要原材料", "reason": "MX/ddgs 都没返回"}},
                        "_pipeline": {"quality": "missing", "data_gaps": ["core_material", "cost_share"]},
                    }
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    missing = [{"key": "8_materials", "status": "none", "note": "无实测", "weight": 3}]
    _mk_db(db, [("688363", "CN", ticker, "medium", "20261030", "{}", _integrity(missing))])
    res = gapmod.build("688363", "CN")
    p = res["prompt"]
    assert res["raw_note"] == ""
    assert "华熙生物 主要原材料" in p
    assert "MX/ddgs 都没返回" in p
    assert "core_material" in p
    assert "每次运行都会重新抓取" in p


def test_note_market_mismatch_is_fixed(db):
    """uzi_sync 把「港股」写死在 11_governance 文案里，A 股命中时要换成中性说法。"""
    missing = [
        {
            "key": "11_governance",
            "status": "none",
            "note": "港股没有 A 股的股权质押/高管持股接口，本次两个核心字段全空——这是「没拿到」",
            "weight": 4,
        }
    ]
    _mk_db(db, [("688363", "CN", "688363.SH", "medium", "20261030", "{}", _integrity(missing))])
    res = gapmod.build("688363", "CN")
    assert "港股没有 A 股" not in res["prompt"]
    assert "本次没拿到股权质押与高管持股" in res["prompt"]


def test_prompt_carries_execution_chain(db):
    """命令链必须完整且带原档位——少了 --depth 会 BLOCKED by self-review。"""
    missing = [{"key": "10_valuation", "status": "none", "note": "本次未采集", "weight": 5}]
    _mk_db(db, [("688363", "CN", "688363.SH", "medium", "20261030", "{}", _integrity(missing))])
    p = gapmod.build("688363", "CN")["prompt"]
    assert "python tdx_prefill.py apply 688363.SH" in p
    assert "--from-modeling --no-browser --depth medium" in p
    assert "/api/uzi/resync?symbol=688363&market=CN" in p
    assert "data/tdx_prefill/688363.SH.json" in p
    assert "BLOCKED by self-review" in p
    assert "verified" in p and "绝不编造" in p


@pytest.mark.parametrize(
    "key,needle",
    [
        ("12_capital_flow", "主力净流入-净额"),   # 键名写错就永远 0 分
        ("16_lhb", "verified"),                   # 非 bool true 整维权重归 0
        ("10_valuation", "pe_quantile"),          # 唯一影响分数的字段
        ("19_contests", "summary.xueqiu_cubes_total"),
    ],
)
def test_hard_field_requirements_are_stated(db, key, needle):
    missing = [{"key": key, "status": "none", "note": "本次未采集", "weight": 4}]
    _mk_db(db, [("688363", "CN", "688363.SH", "medium", "20261030", "{}", _integrity(missing))])
    p = gapmod.build("688363", "CN")["prompt"]
    assert needle in p

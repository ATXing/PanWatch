"""18_trap label 与实测档位对齐的回归测试。

背景（2026-11-02 紫金矿业）：UZI 的 score_fns 把 18_trap 的 label 写死成
「🟢 未发现推广痕迹（实测 命中 N/8…）」，分数恒 9；而 one-liner 末行的
「{emoji} {trap_level}」按实测档位渲染。手工快照若把 trap_level 写成裸词
「低 / 中 / 高」，UZI 的 emoji 映射认不出、一律落到默认 🔴，于是出现
「体检结果框里 🔴 低、下方杀猪盘扫描 🟢 未发现推广痕迹」的自相矛盾。

约束：分数口径不动（18_trap 恒 9），只改 label 文案。
"""

from __future__ import annotations

import pytest

from src.modules.research.uzi_sync import _align_trap_label, _trap_bucket

GREEN_LABEL = "🟢 未发现推广痕迹（实测 命中 0/8 信号 · 已扫 4 组公开帖）"
HIT_LABEL = "🟢 未发现推广痕迹（实测 命中 3/8 信号 · 已扫 4 组公开帖）"


def _dims(label: str) -> dict:
    return {"18_trap": {"score": 9, "weight": 5, "label": label}}


def _raw(level: str) -> dict:
    return {"18_trap": {"data": {"trap_level": level}}}


@pytest.mark.parametrize(
    "level,expected_bucket",
    [
        ("🟢 安全", "green"),
        ("🟡 注意", "yellow"),
        ("🟠 警惕", "orange"),
        ("🔴 高度可疑", "red"),
        ("⚪ 未取证", "unknown"),
        ("低", "green"),
        ("中", "yellow"),
        ("高", "red"),
        ("低风险", "green"),
        ("风险高", "red"),
        ("", None),
        (None, None),
        ("看不懂的档位", None),
    ],
)
def test_trap_bucket_normalizes_variants(level, expected_bucket):
    assert _trap_bucket(level) == expected_bucket


def test_safe_level_keeps_uzi_label():
    """实测安全档时不动 UZI 原文（避免把「已扫描」的表述改掉）。"""
    dims = _dims(GREEN_LABEL)
    _align_trap_label(dims, _raw("🟢 安全"))
    assert dims["18_trap"]["label"] == GREEN_LABEL


@pytest.mark.parametrize(
    "level,prefix",
    [
        ("🟡 注意", "🟡 注意"),
        ("🟠 警惕", "🟠 警惕"),
        ("🔴 高度可疑", "🔴 高度可疑"),
        ("中", "🟡 注意"),  # 手工快照的裸词也要归一
        ("高", "🔴 高度可疑"),
    ],
)
def test_non_safe_level_rewrites_prefix_but_keeps_evidence(level, prefix):
    dims = _dims(HIT_LABEL)
    _align_trap_label(dims, _raw(level))
    label = dims["18_trap"]["label"]
    assert label.startswith(prefix), label
    # 括号里的实测证据原样保留
    assert label.endswith("（实测 命中 3/8 信号 · 已扫 4 组公开帖）"), label
    # 分数口径不动
    assert dims["18_trap"]["score"] == 9


def test_unscanned_becomes_unverified_not_green():
    """没扫到公开帖时不能留绿点，改 ⚪ 未取证。"""
    dims = _dims("🟢 未发现推广痕迹（未取证：没扫到公开帖，不能据此判安全）")
    _align_trap_label(dims, _raw("⚪ 未取证"))
    assert dims["18_trap"]["label"].startswith("⚪ 未取证")
    assert "🟢" not in dims["18_trap"]["label"]


def test_missing_dim_or_unknown_level_is_noop():
    """维度缺失 / 认不出的档位都不该抛异常，也不该乱改。"""
    _align_trap_label({}, _raw("🟡 注意"))  # 不抛即可
    dims = _dims(GREEN_LABEL)
    _align_trap_label(dims, _raw("看不懂的档位"))
    assert dims["18_trap"]["label"] == GREEN_LABEL

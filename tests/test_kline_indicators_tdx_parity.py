"""K 线指标口径回归：与通达信 / 同花顺 对齐。

背景：指标口径一错，整条下游都会被污染——前端技术评分
（``frontend/src/lib/kline-scorer.ts``）与入场候选评分
（``src/modules/strategy/entry_candidates.py``）都读这里算出来的字段。

fixture 是 600887 伊利股份的 260 根前复权日线（通达信 MCP ``tdx_kline`` 导出），
``truth`` 是同一天同一批 K 线在通达信技术指标接口上的返回值
（``tdx_technical_indicator_query``，2026-10-26 收盘后取）。

历史事故（别让它们重演）：

* RSI 曾用「最近 N 日涨跌幅简单平均」（Cutler's RSI），伊利 RSI6 = 59.01，
  通达信 71.79，差 12.78 ⇒ 把「偏强」判成「中性」，技术评分少 1 分。
* BOLL 曾用总体标准差（除 N 而非 N-1），上下轨系统偏窄 2.6%，
  临界位置会把「贴轨 / 突破上轨」判反。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.platform.marketdata.collectors import kline_collector as kc

FIXTURE = Path(__file__).parent / 'fixtures' / 'tdx_600887_daily.json'


@pytest.fixture(scope='module')
def tdx():
    raw = json.loads(FIXTURE.read_text(encoding='utf-8'))
    klines = [
        kc.KlineData(
            date=b['date'],
            open=b['open'],
            close=b['close'],
            high=b['high'],
            low=b['low'],
            volume=b['volume'],
        )
        for b in raw['bars']
    ]
    return raw['truth'], klines, [k.close for k in klines]


def test_moving_averages_match_tdx(tdx):
    truth, _, closes = tdx
    assert kc._calculate_ma(closes, 5) == pytest.approx(truth['ma5'], abs=0.01)
    assert kc._calculate_ma(closes, 10) == pytest.approx(truth['ma10'], abs=0.01)
    assert kc._calculate_ma(closes, 20) == pytest.approx(truth['ma20'], abs=0.01)
    assert kc._calculate_ma(closes, 60) == pytest.approx(truth['ma60'], abs=0.01)


def test_macd_matches_tdx(tdx):
    truth, _, closes = tdx
    dif, dea, hist = kc._calculate_macd(closes)
    assert dif[-1] == pytest.approx(truth['dif'], abs=0.01)
    assert dea[-1] == pytest.approx(truth['dea'], abs=0.01)
    assert hist[-1] == pytest.approx(truth['macd'], abs=0.01)


def test_kdj_matches_tdx(tdx):
    truth, klines, _ = tdx
    k_list, d_list, j_list = kc._calculate_kdj(klines)
    assert k_list[-1] == pytest.approx(truth['k'], abs=0.05)
    assert d_list[-1] == pytest.approx(truth['d'], abs=0.05)
    assert j_list[-1] == pytest.approx(truth['j'], abs=0.10)


def test_rsi_matches_tdx(tdx):
    """必须用通达信 SMA(X,N,1) 递推，不能用简单平均（见模块 docstring）。"""
    truth, _, closes = tdx
    assert kc._calculate_rsi(closes, 6) == pytest.approx(truth['rsi6'], abs=0.05)
    assert kc._calculate_rsi(closes, 12) == pytest.approx(truth['rsi12'], abs=0.05)
    assert kc._calculate_rsi(closes, 24) == pytest.approx(truth['rsi24'], abs=0.05)


def test_boll_matches_tdx(tdx):
    """必须用样本标准差（除 N-1），不能除 N（见模块 docstring）。"""
    truth, _, closes = tdx
    upper, mid, lower, _ = kc._calculate_boll(closes)
    assert upper == pytest.approx(truth['boll_upper'], abs=0.01)
    assert mid == pytest.approx(truth['boll_mid'], abs=0.01)
    assert lower == pytest.approx(truth['boll_lower'], abs=0.01)


def test_atr_matches_tdx(tdx):
    truth, klines, _ = tdx
    assert kc._calculate_atr(klines, 14) == pytest.approx(truth['atr14'], abs=0.01)


def test_rsi_status_thresholds_unchanged(tdx):
    """rsi_status 的分档阈值是产品约定（80/70/20/30），改口径时不动它。

    伊利 2026-10-26 的 RSI6 = 71.79，落在 (70, 80] ⇒ 「偏强」⇒ 技术评分 +1。
    改口径前是 59.01 ⇒「中性」⇒ +0，这是本次修复最直接的行为变化。
    """
    truth, _, closes = tdx
    rsi6 = kc._calculate_rsi(closes, 6)
    assert 70 < rsi6 <= 80, f'RSI6={rsi6} 应落在「偏强」区间'
    assert rsi6 == pytest.approx(truth['rsi6'], abs=0.05)

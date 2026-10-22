"""持仓净盈亏费用模型 —— 把毛盈亏(纯价差)换算为券商含费口径(≈同花顺"到手钱")。

两种口径的分工:
- **毛盈亏**(accounts.py 既有口径): (现价 − 成本价) × 数量, 不含任何费用
  → 用于 −8% 硬止损等纪律判断(费用占比通常仅 0.1% 量级, 不影响阈值决策);
- **净盈亏**(本模块): 市值 − 含买入费成本 − 预估卖出费
  → 对齐券商 App 的到手钱口径, 用于对账与"实际净赚"。

  净盈亏 = 市值 − 含买入费成本 − 预估卖出费
  含费成本价 = (成本价 × 数量 + 买入费) ÷ 数量   (≈ 券商 App 显示的"成本价")

与 strategy/backtest/cost_model.py 的分工: 回测成本模型面向"一买一卖"完整回合(含滑点),
本模块面向"持有浮盈"的时点快照(买入费沉入成本价, 卖出费按现价预估)。净盈亏是**预估**口径,
实际费用以下单时券商收取为准; 佣金费率按自己券商修改 .env 的 fee_* 参数即可精确对齐。

费率默认值见 src/platform/runtime/config.py 的 Settings 字段(支持 .env 覆盖, 重启生效)。
"""

from __future__ import annotations

from dataclasses import dataclass

from src.platform.runtime.config import Settings


@dataclass(frozen=True)
class FeeRule:
    """单列费用规则。

    sides: "both"=买卖双边收取; "buy"/"sell"=仅该边收取(如 A 股印花税仅卖出)。
    min_amount: 单笔最低费用(元/原币种), 仅佣金有意义。
    """

    rate: float
    sides: str = "both"
    min_amount: float = 0.0

    def fee(self, side: str, notional: float) -> float:
        if notional <= 0:
            return 0.0
        if self.sides not in ("both", side):
            return 0.0
        if self.rate <= 0 and self.min_amount <= 0:
            return 0.0
        return max(notional * self.rate, self.min_amount)


@dataclass(frozen=True)
class MarketFeeProfile:
    """一个市场的完整费用 profile。"""

    market: str
    commission: FeeRule
    stamp_duty: FeeRule
    transfer: FeeRule
    misc: FeeRule  # 经手费/证管费/交易征费/SEC 费等杂项规费

    def buy_fees(self, notional: float) -> float:
        return (
            self.commission.fee("buy", notional)
            + self.stamp_duty.fee("buy", notional)
            + self.transfer.fee("buy", notional)
            + self.misc.fee("buy", notional)
        )

    def sell_fees(self, notional: float) -> float:
        return (
            self.commission.fee("sell", notional)
            + self.stamp_duty.fee("sell", notional)
            + self.transfer.fee("sell", notional)
            + self.misc.fee("sell", notional)
        )

    def to_payload(self) -> dict:
        """扁平化字典, 随持仓接口下发前端(前端按实时价重算净盈亏, 与毛盈亏同源)。"""
        return {
            "commission_rate": self.commission.rate,
            "min_commission": self.commission.min_amount,
            "stamp_duty_rate": self.stamp_duty.rate,
            "stamp_duty_sides": self.stamp_duty.sides,
            "transfer_fee_rate": self.transfer.rate,
            "misc_fee_rate": self.misc.rate,
            "misc_fee_sides": self.misc.sides,
        }


def get_fee_profile(market: str | None) -> MarketFeeProfile:
    """按市场构造费用 profile(未知市场按 A 股口径, 最常用)。"""
    s = Settings()
    m = (market or "CN").upper()
    if m == "HK":
        return MarketFeeProfile(
            market="HK",
            commission=FeeRule(s.fee_hk_commission_rate, "both", s.fee_hk_min_commission),
            stamp_duty=FeeRule(s.fee_hk_stamp_duty_rate, "both"),
            transfer=FeeRule(0.0, "both"),
            misc=FeeRule(s.fee_hk_misc_fee_rate, "both"),
        )
    if m == "US":
        return MarketFeeProfile(
            market="US",
            commission=FeeRule(s.fee_us_commission_rate, "both", s.fee_us_min_commission),
            stamp_duty=FeeRule(0.0, "sell"),
            transfer=FeeRule(0.0, "both"),
            misc=FeeRule(s.fee_us_misc_fee_rate, "sell"),
        )
    return MarketFeeProfile(
        market="CN",
        commission=FeeRule(s.fee_cn_commission_rate, "both", s.fee_cn_min_commission),
        stamp_duty=FeeRule(s.fee_cn_stamp_duty_rate, "sell"),
        transfer=FeeRule(s.fee_cn_transfer_fee_rate, "both"),
        misc=FeeRule(0.0, "both"),
    )


def fee_profiles_payload() -> dict[str, dict]:
    """三个市场的费用 profile(前端重算净盈亏用; 单一真相源在后端配置)。"""
    return {m: get_fee_profile(m).to_payload() for m in ("CN", "HK", "US")}


def net_pnl_breakdown(
    market: str | None,
    cost_price: float,
    quantity: int,
    current_price: float,
) -> dict:
    """单只持仓的净盈亏拆解(**原币种**; 调用方需要人民币口径时自行乘汇率)。

    Returns:
        buy_fees / sell_fees / total_fees: 费用(原币种)
        net_cost: 含买入费成本(原币种)
        net_cost_price: 含费成本价(原币种, ≈券商 App 的"成本价")
        net_pnl / net_pnl_pct: 净盈亏与百分比(pct 与币种无关, 汇率上下约掉)
    """
    profile = get_fee_profile(market)
    qty = int(quantity or 0)
    buy_notional = float(cost_price) * qty
    buy_fees = profile.buy_fees(buy_notional)
    net_cost = buy_notional + buy_fees
    net_cost_price = net_cost / qty if qty > 0 else float(cost_price)
    sell_notional = float(current_price) * qty
    sell_fees = profile.sell_fees(sell_notional)
    net_pnl = sell_notional - sell_fees - net_cost
    net_pnl_pct = (net_pnl / net_cost * 100.0) if net_cost > 0 else 0.0
    return {
        "buy_fees": buy_fees,
        "sell_fees": sell_fees,
        "total_fees": buy_fees + sell_fees,
        "net_cost": net_cost,
        "net_cost_price": net_cost_price,
        "net_pnl": net_pnl,
        "net_pnl_pct": net_pnl_pct,
    }

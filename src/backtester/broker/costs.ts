/**
 * Commissions and the decimal rules of the funds checks: commissions and the sizing equity kept to 10 significant
 * digits, as the reference app reports them.
 */
import type { StrategyProperties } from '../types';
import { EPS } from './types';

/** Significant digits of the equity the fill funds checks count (see fillEquity). */
const FUNDS_DIGITS = 10;

/**
 * The equity the funds checks at a fill count: rounded to 10 significant digits (a stop entry valued 45,000 fills
 * with a capital of 44,999.999999, not 44,999.99999; at 450: 449.99999999 / 449.9999999; volatility expansion-close
 * AAPL 1D bar 1129: 0.07999999998719431 does not cover 0.08).
 */
export function fillEquity(equity: number): number {
  return Number(equity.toPrecision(FUNDS_DIGITS));
}

/**
 * A commission (an order's, or the part of an entry commission a partial close takes) is kept to 10 significant
 * digits: 1.25 x 1,000 / 1,500 = 0.8333333333, 1.25 x 500 / 3,500 = 0.1785714286 (the reference app's trade
 * commissions, and its gross loss / net profit built from them).
 */
export function roundCommission(cm: number): number {
  return cm === 0 ? 0 : Number(cm.toPrecision(FUNDS_DIGITS));
}

/**
 * Commission of `qty` at `price`, rounded to 10 significant digits (see roundCommission). `orderFillQty`: quantity
 * of the order being filled (a cash-per-order commission is split over the trades it touches).
 */
export function commission(p: StrategyProperties, pointValue: number, qty: number, price: number, orderFillQty: number): number {
  switch (p.commissionType) {
    case 'percent':
      // Commission value first (0.1 % of 5,000 at 0.07: 0.35 as 0.1 x 5,000 x 0.07 / 100, as the reference app).
      return roundCommission((p.commissionValue * qty * price * pointValue) / 100);
    case 'cash_per_contract':
      return roundCommission(qty * p.commissionValue);
    case 'cash_per_order':
      return roundCommission(orderFillQty > EPS ? p.commissionValue * (qty / orderFillQty) : p.commissionValue);
  }
}

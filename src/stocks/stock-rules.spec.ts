import { validateStockDecision, STOCK_RULES } from './stock-rules';
import { computeLimits } from '../trading/rules';

const ctx = { budget: 500, killSwitch: false, limits: computeLimits([]), livePrice: 100 };
const good = {
  decision: 'TRADE', ticker: 'NVDA', direction: 'LONG', entry: 100, stop_loss: 96,
  take_profit: 108, take_profit_2: 112, confidence: 8, reasoning: 'Trend yukarı.',
};

describe('validateStockDecision', () => {
  it('accepts valid long, 500$ position, max loss <= 25$', () => {
    const r = validateStockDecision(good, ctx);
    expect(r.status).toBe('TRADE');
    if (r.status !== 'TRADE') return;
    expect(r.card.shares).toBe(5);
    expect(r.card.positionUsd).toBe(500);
    expect(r.card.lossUsd).toBe(20);
    expect(r.card.profitUsd).toBe(40);
    expect(r.card.profit2Usd).toBe(60);
    expect(r.card.rr).toBe(2);
  });
  it('rejects SHORT', () => {
    expect(validateStockDecision({ ...good, direction: 'SHORT' }, ctx).status).toBe('NO_TRADE');
  });
  it('rejects missing/wrong-side SL/TP', () => {
    expect(validateStockDecision({ ...good, stop_loss: undefined }, ctx).status).toBe('NO_TRADE');
    expect(validateStockDecision({ ...good, take_profit: undefined }, ctx).status).toBe('NO_TRADE');
    expect(validateStockDecision({ ...good, stop_loss: 101 }, ctx).status).toBe('NO_TRADE');
  });
  it('rejects low R/R', () => {
    expect(validateStockDecision({ ...good, take_profit: 105 }, ctx).status).toBe('NO_TRADE');
  });
  it('shrinks position when SL is wide', () => {
    const r = validateStockDecision({ ...good, stop_loss: 90, take_profit: 120, take_profit_2: null }, ctx);
    expect(r.status).toBe('TRADE');
    if (r.status !== 'TRADE') return;
    expect(r.card.lossUsd).toBeLessThanOrEqual(500 * STOCK_RULES.MAX_LOSS_PCT / 100);
    expect(r.card.positionUsd).toBeLessThan(500);
    expect(r.card.adjustments.length).toBeGreaterThan(0);
  });
  it('6.5 passes auto threshold, 6 does not', () => {
    expect(validateStockDecision({ ...good, confidence: 6.5 }, { ...ctx, minConfidenceOverride: STOCK_RULES.AUTO_CARD_MIN_CONFIDENCE }).status).toBe('TRADE');
    expect(validateStockDecision({ ...good, confidence: 6 }, { ...ctx, minConfidenceOverride: STOCK_RULES.AUTO_CARD_MIN_CONFIDENCE }).status).toBe('NO_TRADE');
  });
  it('low confidence => no trade', () => {
    expect(validateStockDecision({ ...good, confidence: 5 }, ctx).status).toBe('NO_TRADE');
  });
  it('martingale rejected', () => {
    expect(validateStockDecision({ ...good, adds_to_existing_position: true }, ctx).status).toBe('NO_TRADE');
  });
  it('kill switch below 250', () => {
    expect(validateStockDecision(good, { ...ctx, budget: 240 }).status).toBe('KILL_SWITCH');
  });
  it('entry far from live price rejected', () => {
    expect(validateStockDecision(good, { ...ctx, livePrice: 110 }).status).toBe('NO_TRADE');
  });
  it('fractional shares for expensive stock', () => {
    const r = validateStockDecision({ ...good, entry: 1000, stop_loss: 970, take_profit: 1060, take_profit_2: null }, { ...ctx, livePrice: 1000 });
    expect(r.status).toBe('TRADE');
    if (r.status !== 'TRADE') return;
    expect(r.card.fractional).toBe(true);
    expect(r.card.shares).toBe(0.5);
  });
});

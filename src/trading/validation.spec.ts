import { validateDecision, mentionsMartingale, roundToStep } from './validation';
import { computeLimits } from './rules';

const base = { balance: 200, killSwitch: false, limits: computeLimits([]), livePrice: 100 };
const good = {
  decision: 'TRADE', symbol: 'SOL', direction: 'LONG', leverage: 5, margin_usdt: 40,
  entry: 100, stop_loss: 97, take_profit: 106, confidence: 8, reasoning: 'Trend yukarı.',
};

describe('validateDecision (immutable rules)', () => {
  it('accepts a valid long and computes P/L', () => {
    const r = validateDecision(good, base);
    expect(r.status).toBe('TRADE');
    if (r.status !== 'TRADE') return;
    expect(r.card.leverage).toBe(5);
    expect(r.card.lossUsdt).toBeLessThanOrEqual(20);
    expect(r.card.profitUsdt).toBeGreaterThan(r.card.lossUsdt);
  });
  it('kill switch blocks', () => {
    expect(validateDecision(good, { ...base, balance: 90 }).status).toBe('KILL_SWITCH');
    expect(validateDecision(good, { ...base, killSwitch: true }).status).toBe('KILL_SWITCH');
  });
  it('rejects missing SL / TP and wrong sides', () => {
    expect(validateDecision({ ...good, stop_loss: undefined }, base).status).toBe('NO_TRADE');
    expect(validateDecision({ ...good, take_profit: undefined }, base).status).toBe('NO_TRADE');
    expect(validateDecision({ ...good, stop_loss: 101 }, base).status).toBe('NO_TRADE');
    expect(validateDecision({ ...good, direction: 'SHORT' }, base).status).toBe('NO_TRADE');
  });
  it('clamps leverage and margin, enforces max loss', () => {
    const r = validateDecision({ ...good, leverage: 25, margin_usdt: 500 }, base);
    expect(r.status).toBe('TRADE');
    if (r.status !== 'TRADE') return;
    expect(r.card.leverage).toBeLessThanOrEqual(10);
    expect(r.card.margin).toBeLessThanOrEqual(100);
    expect(r.card.lossUsdt).toBeLessThanOrEqual(20.01);
  });
  it('low confidence => no trade', () => {
    expect(validateDecision({ ...good, confidence: 5 }, base).status).toBe('NO_TRADE');
  });
  it('martingale rejected', () => {
    expect(validateDecision({ ...good, adds_to_existing_position: true }, base).status).toBe('NO_TRADE');
    expect(validateDecision({ ...good, reasoning: 'Zarardaki pozisyona ekle, ortalama düşür.' }, base).status).toBe('NO_TRADE');
    expect(mentionsMartingale('Martingale yok, disiplin var.')).toBe(false);
  });
  it('user instructions tighten, never loosen', () => {
    const limits = computeLimits([{ max_leverage: 3 }, { max_leverage: 50 }, { banned_coins: ['sol'] }, { max_margin_pct: 90 }]);
    expect(limits.maxLeverage).toBe(3);
    expect(limits.maxMarginPct).toBe(50);
    expect(validateDecision(good, { ...base, limits }).status).toBe('NO_TRADE'); // SOL banned
    const r = validateDecision({ ...good, symbol: 'ETH' }, { ...base, limits });
    expect(r.status === 'TRADE' && r.card.leverage).toBe(3);
  });
  it('rejects stale entry far from live price and poor RR', () => {
    expect(validateDecision(good, { ...base, livePrice: 110 }).status).toBe('NO_TRADE');
    expect(validateDecision({ ...good, take_profit: 101 }, base).status).toBe('NO_TRADE');
  });
  it('reduces leverage so SL triggers before isolated liquidation', () => {
    const r = validateDecision({ ...good, leverage: 10, stop_loss: 90, take_profit: 120 }, base);
    expect(r.status === 'TRADE' && r.card.leverage).toBeLessThanOrEqual(8);
  });

  describe('Binance filters', () => {
    const fx = { symbol: 'SOLUSDT', tickSize: 0.01, stepSize: 0.01, minQty: 0.01, minNotional: 5 };
    it('rounds levels to tick (SL never widens) and qty to step', () => {
      const r = validateDecision({ ...good, entry: 100.004, stop_loss: 96.987, take_profit: 106.019 }, { ...base, exchangeFilters: fx, checkListing: true });
      expect(r.status).toBe('TRADE');
      if (r.status !== 'TRADE') return;
      expect(r.card.exchangeSymbol).toBe('SOLUSDT');
      expect(r.card.stopLoss).toBe(96.99); // rounded UP for long = tighter
      expect(r.card.takeProfit).toBe(106.01); // toward entry
      expect(r.card.entry).toBe(100);
      expect(Number.isInteger(Math.round(r.card.quantity! * 100))).toBe(true);
      expect(Math.abs(r.card.quantity! * 100 - Math.round(r.card.quantity! * 100))).toBeLessThan(1e-9);
      expect(r.card.lossUsdt).toBeLessThanOrEqual(20.01);
    });
    it('short SL rounds DOWN (tighter)', () => {
      const r = validateDecision({ ...good, direction: 'SHORT', entry: 100, stop_loss: 103.017, take_profit: 93.003 }, { ...base, exchangeFilters: fx, checkListing: true });
      expect(r.status).toBe('TRADE');
      if (r.status !== 'TRADE') return;
      expect(r.card.stopLoss).toBe(103.01);
      expect(r.card.takeProfit).toBe(93.01);
    });
    it('rejects symbol not listed on Binance', () => {
      expect(validateDecision(good, { ...base, exchangeFilters: undefined, checkListing: true }).status).toBe('NO_TRADE');
    });
    it('Binance unreachable (null) still works', () => {
      expect(validateDecision(good, { ...base, exchangeFilters: null, checkListing: true }).status).toBe('TRADE');
    });
    it('rejects below Binance min notional', () => {
      const big = { ...fx, minNotional: 100000 };
      expect(validateDecision(good, { ...base, exchangeFilters: big, checkListing: true }).status).toBe('NO_TRADE');
    });
    it('roundToStep', () => {
      expect(roundToStep(0.123456, 0.001, 'down')).toBe(0.123);
      expect(roundToStep(0.123456, 0.001, 'up')).toBe(0.124);
      expect(roundToStep(77021.46, 0.1, 'nearest')).toBe(77021.5);
      expect(roundToStep(0.00001234, 0.0000001, 'down')).toBe(0.0000123);
    });
  });
});

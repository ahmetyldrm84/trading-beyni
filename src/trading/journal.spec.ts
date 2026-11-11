import { cleanPosition, levelHit, pnlAt, toNumber, totals } from './journal';

describe('işlem defteri', () => {
  it('sayı yazımlarını çözer', () => {
    expect(toNumber('+12,45 USDT')).toBe(12.45);
    expect(toNumber('−3.2')).toBe(-3.2);
    expect(toNumber('74.150,5')).toBe(74150.5);
    expect(toNumber('74,150.5')).toBe(74150.5);
    expect(toNumber('1,234,567')).toBe(1234567);
    expect(toNumber(null)).toBeNull();
    expect(toNumber('yok')).toBeNull();
  });

  it('ham kaydı temizler, büyüklüğü margin x kaldıraçtan çıkarır', () => {
    const c = cleanPosition({ symbol: 'BTCUSDT', direction: 'Long', entry: '74000', margin_usdt: 20, leverage: '5x', stop_loss: 73000 })!;
    expect(c).toMatchObject({ symbol: 'BTC', direction: 'LONG', status: 'OPEN', size: 100, stopLoss: 73000, pnl: null });
  });

  it('coin ya da yön yoksa kaydı reddeder', () => {
    expect(cleanPosition({ symbol: '', direction: 'LONG' })).toBeNull();
    expect(cleanPosition({ symbol: 'ETH', direction: '?' })).toBeNull();
  });

  it('kapanmış işlemde ekrandaki PnL esas alınır, yoksa hesaplanır', () => {
    expect(cleanPosition({ symbol: 'SOL_USDT', direction: 'SHORT', status: 'CLOSED', entry: 200, exit: 190, size_usdt: 100, pnl_usdt: '4,7' })!.pnl).toBe(4.7);
    expect(cleanPosition({ symbol: 'SOL', direction: 'SHORT', status: 'CLOSED', entry: 200, exit: 190, size_usdt: 100 })!.pnl).toBe(5);
    expect(cleanPosition({ symbol: 'SOL', direction: 'LONG', status: 'CLOSED', entry: 200, exit: 190 })!.pnl).toBeNull();
  });

  it('yöne göre kâr/zarar hesaplar', () => {
    expect(pnlAt({ direction: 'LONG', entry: 100, size: 50 }, 110)).toBe(5);
    expect(pnlAt({ direction: 'SHORT', entry: 100, size: 50 }, 110)).toBe(-5);
    expect(pnlAt({ direction: 'LONG', entry: 100, size: null }, 110)).toBeNull();
  });

  it('TP/SL seviyesini yöne göre yakalar', () => {
    const long = { direction: 'LONG', stopLoss: 95, takeProfit: 110 };
    expect(levelHit(long, 111)).toBe('TP');
    expect(levelHit(long, 94)).toBe('SL');
    expect(levelHit(long, 100)).toBeNull();
    const short = { direction: 'SHORT', stopLoss: 105, takeProfit: 90 };
    expect(levelHit(short, 89)).toBe('TP');
    expect(levelHit(short, 106)).toBe('SL');
    expect(levelHit({ direction: 'LONG', stopLoss: null, takeProfit: null }, 1)).toBeNull();
  });

  it('toplamı ve isabet oranını çıkarır, bilinmeyeni toplama katmaz', () => {
    const t = totals([10, -4, 6.5, null, 0]);
    expect(t).toMatchObject({ count: 5, wins: 2, losses: 1, flat: 1, unknown: 1, total: 12.5, winRate: 67, best: 10, worst: -4, avgWin: 8.25, avgLoss: -4 });
    expect(totals([])).toMatchObject({ count: 0, total: 0, winRate: null, best: null });
  });
});

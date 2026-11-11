import { adverseMove, cleanPosition, emergency, levelHit, pnlAt, toNumber, totals } from './journal';

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

  describe('acil durum', () => {
    const now = 1_000_000_000;
    const h = (...p: Array<[number, number]>) => p.map(([dkOnce, price]) => ({ t: now - dkOnce * 60_000, price }));
    const long = { symbol: 'SOL', direction: 'LONG', entry: 100, leverage: 5, stopLoss: 95 };
    const short = { symbol: 'SOL', direction: 'SHORT', entry: 100, leverage: 5, stopLoss: 105 };

    it('aleyhe hareketi pencere içindeki tepe/dipten ölçer', () => {
      expect(adverseMove('LONG', h([4, 100], [2, 102], [1, 101]), now, 5 * 60_000, 99.96)).toBeCloseTo(2, 1);
      expect(adverseMove('SHORT', h([4, 100], [2, 98]), now, 5 * 60_000, 99.96)).toBeCloseTo(2, 1);
      expect(adverseMove('LONG', h([20, 110]), now, 5 * 60_000, 100)).toBe(0); // pencere dışı
    });

    it('sakin piyasada ve lehe harekette susar', () => {
      expect(emergency(long, 100.2, h([5, 100], [3, 100.1], [1, 100.3]), now)).toBeNull();
      expect(emergency(long, 104, h([5, 100], [1, 103]), now)).toBeNull();
      expect(emergency(short, 96, h([5, 100], [1, 97]), now)).toBeNull();
    });

    it('5 dakikada sert ters hareketi yakalar', () => {
      expect(emergency(long, 98.3, h([4, 100], [1, 99.5]), now)?.kind).toBe('SERT');
      expect(emergency(short, 101.7, h([4, 100], [1, 100.5]), now)?.kind).toBe('SERT');
      expect(emergency(long, 99, h([4, 100]), now)).toBeNull(); // %1 yetmez
    });

    it('15 dakikaya yayılan kırılımı yakalar; BTC için eşik daha düşük', () => {
      expect(emergency(long, 97.4, h([14, 100], [9, 99], [4, 98.2], [1, 97.8]), now)?.kind).toBe('SERT');
      const btc = { symbol: 'BTC', direction: 'LONG', entry: 75000, leverage: 3, stopLoss: null };
      expect(emergency(btc, 74200, h([4, 75000]), now)?.kind).toBe('SERT'); // %1,07 ≥ 1,05
      expect(emergency({ ...btc, symbol: 'SOL' }, 74200, h([4, 75000]), now)).toBeNull();
    });

    it('stop aşıldıysa ve teminat eriyorsa önce onları söyler', () => {
      expect(emergency(long, 94.5, h([1, 94.6]), now)?.kind).toBe('STOP');
      expect(emergency(short, 105.5, h([1, 105.4]), now)?.kind).toBe('STOP');
      const stopsuz = { symbol: 'SOL', direction: 'LONG', entry: 100, leverage: 10, stopLoss: null };
      expect(emergency(stopsuz, 94.9, h([1, 95]), now)?.kind).toBe('MARJIN'); // %5,1 x 10 = %51
      expect(emergency(stopsuz, 96, h([1, 96]), now)).toBeNull();
    });
  });
});

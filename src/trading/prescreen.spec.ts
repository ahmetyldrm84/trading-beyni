import type { CoinFeatures } from '../market/market.service';
import { preScreen, quietSummary, screenCoin, trendOf } from './prescreen';

const f = (o: Partial<CoinFeatures>): CoinFeatures => ({
  symbol: 'SOL',
  price: 100,
  chg1h: 0,
  chg4h: 0,
  chg24h: 0,
  rsi14_1h: 50,
  ema20_1h: 100,
  ema50_1h: 100,
  high24h: 102,
  low24h: 98,
  atr14_1h_pct: 0.8,
  last12_closes_1h: [100, 100.2, 99.9, 100.1, 100, 99.8, 100.2, 100.1, 99.9, 100, 100.1, 100],
  ...o,
});
const up = { price: 104, ema20_1h: 102, ema50_1h: 100, rsi14_1h: 62 };
const down = { price: 96, ema20_1h: 98, ema50_1h: 100, rsi14_1h: 38 };

describe('ön eleme', () => {
  it('trendi EMA dizilimine göre okur', () => {
    expect(trendOf(f(up))).toBe('UP');
    expect(trendOf(f(down))).toBe('DOWN');
    expect(trendOf(f({ price: 101, ema20_1h: 102, ema50_1h: 100 }))).toBe('FLAT');
    expect(trendOf(f({ ema20_1h: null }))).toBe('FLAT');
  });

  it('yatay piyasada aday çıkarmaz', () => {
    expect(screenCoin(f({}))).toBeNull();
    expect(preScreen([f({}), f({ symbol: 'BTC' })])).toEqual([]);
  });

  it('trend var ama kırılım ve ivme yoksa aday çıkarmaz', () => {
    expect(screenCoin(f({ ...up, last12_closes_1h: [103, 104.5, 104.2, 104.4, 104.1, 104.3, 104.6, 104.2, 104.1, 104.3, 104.2, 104] }))).toBeNull();
  });

  it('yükselen trendde kapanış zirvesi kırılımını LONG aday yapar', () => {
    const c = screenCoin(f({ ...up, last12_closes_1h: [101, 101.5, 102, 102.2, 102.1, 102.6, 103, 102.8, 103.1, 103.3, 103.2, 104] }));
    expect(c).toMatchObject({ symbol: 'SOL', direction: 'LONG' });
  });

  it('düşen trendde kapanış dibi kırılımını SHORT aday yapar', () => {
    const c = screenCoin(f({ ...down, last12_closes_1h: [99, 98.6, 98.8, 98.1, 98.3, 97.9, 97.5, 97.7, 97.2, 97, 97.1, 96] }));
    expect(c).toMatchObject({ direction: 'SHORT' });
  });

  it('kırılım olmasa da güçlü 4 saatlik ivmeyi aday yapar', () => {
    const closes = [103, 105, 104.8, 104.6, 104.2, 104.4, 104.1, 104.3, 104.2, 104.4, 104.3, 104];
    expect(screenCoin(f({ ...up, chg4h: 1.6, last12_closes_1h: closes }))).toMatchObject({ direction: 'LONG' });
    expect(screenCoin(f({ ...up, chg4h: 0.9, last12_closes_1h: closes }))).toBeNull();
  });

  it('aşırı alım/satım ve aşırı oynak coini eler', () => {
    const kirilim = [101, 101.5, 102, 102.2, 102.1, 102.6, 103, 102.8, 103.1, 103.3, 103.2, 104];
    expect(screenCoin(f({ ...up, rsi14_1h: 80, last12_closes_1h: kirilim }))).toBeNull();
    expect(screenCoin(f({ ...up, atr14_1h_pct: 7, last12_closes_1h: kirilim }))).toBeNull();
    const dip = [99, 98.6, 98.8, 98.1, 98.3, 97.9, 97.5, 97.7, 97.2, 97, 97.1, 96];
    expect(screenCoin(f({ ...down, rsi14_1h: 20, last12_closes_1h: dip }))).toBeNull();
  });

  it('sessiz özet majörlerin durumunu yazar', () => {
    expect(quietSummary([f({ symbol: 'BTC' }), f({ ...up, symbol: 'ETH' })])).toBe('2 adayda trend + kırılım yok: BTC yatay (RSI 50), ETH yukarı (RSI 62)');
  });
});

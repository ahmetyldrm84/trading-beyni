// Yeni varsayılanlar: sabit %2 risk, ödül/risk en az 1,5, kill switch 700, azami kayıp %3.
process.env.KILL_SWITCH = '700';
process.env.AZAMI_KAYIP_YUZDE = '3';
process.env.ISLEM_RISK_YUZDE = '2';
process.env.MIN_ODUL_RISK = '1.5';
import { validateDecision } from './validation';
import { computeLimits, entryLimit } from './rules';
import { openR, resolveCard } from './journal';

const ctx = { balance: 1000, killSwitch: false, limits: computeLimits([]), livePrice: 100 };
const kart = { decision: 'TRADE', symbol: 'SOL', direction: 'LONG', leverage: 5, margin_usdt: 0, entry: 100, stop_loss: 97, take_profit: 106, confidence: 6, reasoning: 'x' };

describe('sabit risk ve ödül/risk', () => {
  it('her kartta stop kaybı bakiyenin %2si olur, modelin marjı dikkate alınmaz', () => {
    for (const m of [0, 5, 80, 400, 5000]) {
      const r = validateDecision({ ...kart, margin_usdt: m }, ctx);
      expect(r.status).toBe('TRADE');
      if (r.status !== 'TRADE') return;
      expect(r.card.lossUsdt).toBeGreaterThan(19.4);
      expect(r.card.lossUsdt).toBeLessThanOrEqual(20.01);
    }
  });

  it('dar stopta da geniş stopta da risk aynı kalır', () => {
    const dar = validateDecision({ ...kart, stop_loss: 99, take_profit: 102 }, ctx);
    const genis = validateDecision({ ...kart, stop_loss: 94, take_profit: 112 }, ctx);
    expect(dar.status === 'TRADE' && Math.round(dar.card.lossUsdt)).toBe(20);
    expect(genis.status === 'TRADE' && Math.round(genis.card.lossUsdt)).toBe(20);
    expect(dar.status === 'TRADE' && genis.status === 'TRADE' && dar.card.margin > genis.card.margin).toBe(true);
  });

  it('marj tavanına takılırsa risk hedefin altında kalır ve bunu söyler', () => {
    const r = validateDecision({ ...kart, leverage: 1, stop_loss: 99.5, take_profit: 101 }, ctx); // 1x, %0,5 stop → 4000 USDT marj gerekir
    expect(r.status).toBe('TRADE');
    if (r.status !== 'TRADE') return;
    expect(r.card.margin).toBeLessThanOrEqual(500);
    expect(r.card.lossUsdt).toBeLessThan(20);
    expect(r.card.adjustments.join(' ')).toMatch(/risk hedefin/);
  });

  it('talimatla sıkılaştırılan kayıp sınırı riski de düşürür', () => {
    const r = validateDecision(kart, { ...ctx, limits: computeLimits([{ max_loss_pct: 1 }]) });
    expect(r.status === 'TRADE' && Math.round(r.card.lossUsdt)).toBe(10);
  });

  it('ödül/risk 1,5in altındaki kartı reddeder', () => {
    expect(validateDecision({ ...kart, take_profit: 104.4 }, ctx).status).toBe('NO_TRADE'); // 1,47
    expect(validateDecision({ ...kart, take_profit: 104.5 }, ctx).status).toBe('TRADE'); // 1,50
  });

  it('giriş sınırını hesaplar: o fiyatta oran tam 1,5 olur', () => {
    const long = entryLimit(97, 106, 1.5); // (106 + 1,5*97) / 2,5 = 100,6
    expect(long).toBeCloseTo(100.6, 6);
    expect((106 - long) / (long - 97)).toBeCloseTo(1.5, 6);
    const short = entryLimit(103, 94, 1.5); // 99,4
    expect((short - 94) / (103 - short)).toBeCloseTo(1.5, 6);
    const r = validateDecision(kart, ctx);
    expect(r.status === 'TRADE' && r.card.entryLimit).toBeCloseTo(100.6, 4);
  });
});

describe('kart sonucu', () => {
  const long = { direction: 'LONG', entry: 100, stopLoss: 97, takeProfit: 106 };
  const short = { direction: 'SHORT', entry: 100, stopLoss: 103, takeProfit: 94 };
  const m = (t: number, h: number, l: number, c = (h + l) / 2) => ({ t, h, l, c });

  it('önce hedef gelirse TP ve R katsayısı', () => {
    expect(resolveCard(long, [m(1, 101, 99), m(2, 106.2, 100)])).toMatchObject({ status: 'TP', r: 2, at: 2 });
    expect(resolveCard(short, [m(1, 101, 99), m(2, 100, 93.9)])).toMatchObject({ status: 'TP', r: 2 });
  });
  it('önce stop gelirse SL', () => {
    expect(resolveCard(long, [m(1, 101, 96.9), m(2, 107, 100)])).toMatchObject({ status: 'SL', r: -1, at: 1 });
    expect(resolveCard(short, [m(1, 103.1, 99)])).toMatchObject({ status: 'SL', r: -1 });
  });
  it('aynı mumda ikisi de varsa temkinli taraf: SL', () => {
    expect(resolveCard(long, [m(1, 107, 96)])).toMatchObject({ status: 'SL' });
  });
  it('ikisi de gelmediyse sonuç yok; anlık R hesaplanır', () => {
    expect(resolveCard(long, [m(1, 102, 98)])).toBeNull();
    expect(openR(long, 101.5)).toBe(0.5);
    expect(openR(short, 101.5)).toBe(-0.5);
  });
});

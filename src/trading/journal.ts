/**
 * İşlem defteri: ekran görüntüsünden okunan pozisyonların saf hesapları (veritabanı ve ağ yok).
 */
import { normalizeCoin } from './rules';

export interface ShotPosition {
  symbol?: string;
  direction?: string;
  status?: string;
  entry?: number | string | null;
  exit?: number | string | null;
  leverage?: number | string | null;
  margin_usdt?: number | string | null;
  size_usdt?: number | string | null;
  stop_loss?: number | string | null;
  take_profit?: number | string | null;
  pnl_usdt?: number | string | null;
}

export interface CleanPosition {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  status: 'OPEN' | 'CLOSED';
  entry: number | null;
  exit: number | null;
  leverage: number | null;
  margin: number | null;
  size: number | null; // pozisyon büyüklüğü (USDT, kaldıraçlı)
  stopLoss: number | null;
  takeProfit: number | null;
  pnl: number | null;
}

/** "1.234,5", "+12.4 USDT", "−3,2" gibi yazımları sayıya çevirir. */
export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[−–—]/g, '-').replace(/[^0-9.,+-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lastComma > -1) s = /,\d{3}$/.test(s) && s.indexOf(',') !== lastComma ? s.replace(/,/g, '') : s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const pos = (v: unknown): number | null => {
  const n = toNumber(v);
  return n !== null && n > 0 ? n : null;
};

/** Modelin okuduğu ham kaydı temizler; coin ya da yön okunamadıysa null. */
export function cleanPosition(p: ShotPosition): CleanPosition | null {
  const symbol = normalizeCoin(p.symbol || '');
  const d = String(p.direction || '').toUpperCase();
  const direction = /LONG|BUY|AL/.test(d) ? 'LONG' : /SHORT|SELL|SAT/.test(d) ? 'SHORT' : null;
  if (!symbol || !direction) return null;
  const leverage = pos(p.leverage);
  const margin = pos(p.margin_usdt);
  let size = pos(p.size_usdt);
  if (!size && margin && leverage) size = margin * leverage;
  const c: CleanPosition = {
    symbol,
    direction,
    status: /CLOSED|KAPA/i.test(String(p.status || '')) ? 'CLOSED' : 'OPEN',
    entry: pos(p.entry),
    exit: pos(p.exit),
    leverage,
    margin,
    size,
    stopLoss: pos(p.stop_loss),
    takeProfit: pos(p.take_profit),
    pnl: toNumber(p.pnl_usdt),
  };
  if (c.status === 'CLOSED' && c.pnl === null) c.pnl = pnlAt(c, c.exit);
  return c;
}

/** Verilen fiyatta kâr/zarar (USDT). Büyüklük ya da giriş bilinmiyorsa null. Komisyon dahil değildir. */
export function pnlAt(p: { direction: string; entry: number | null; size: number | null }, price: number | null): number | null {
  if (!p.entry || !p.size || !price) return null;
  const move = (price - p.entry) / p.entry;
  return Math.round(p.size * move * (p.direction === 'SHORT' ? -1 : 1) * 100) / 100;
}

/** Fiyat TP ya da SL seviyesine ulaştı mı? */
export function levelHit(p: { direction: string; stopLoss: number | null; takeProfit: number | null }, price: number): 'TP' | 'SL' | null {
  const long = p.direction !== 'SHORT';
  if (p.takeProfit && (long ? price >= p.takeProfit : price <= p.takeProfit)) return 'TP';
  if (p.stopLoss && (long ? price <= p.stopLoss : price >= p.stopLoss)) return 'SL';
  return null;
}

export interface Totals {
  count: number;
  wins: number;
  losses: number;
  flat: number;
  unknown: number;
  total: number;
  winRate: number | null;
  best: number | null;
  worst: number | null;
  avgWin: number | null;
  avgLoss: number | null;
}

/** Kapanmış işlemlerin toplamı. PnL'i bilinmeyenler toplama girmez, ayrıca sayılır. */
export function totals(pnls: Array<number | null>): Totals {
  const known = pnls.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  const wins = known.filter((x) => x > 0);
  const losses = known.filter((x) => x < 0);
  const sum = (a: number[]) => Math.round(a.reduce((s, x) => s + x, 0) * 100) / 100;
  const decided = wins.length + losses.length;
  return {
    count: pnls.length,
    wins: wins.length,
    losses: losses.length,
    flat: known.length - decided,
    unknown: pnls.length - known.length,
    total: sum(known),
    winRate: decided ? Math.round((wins.length / decided) * 100) : null,
    best: known.length ? Math.max(...known) : null,
    worst: known.length ? Math.min(...known) : null,
    avgWin: wins.length ? Math.round((sum(wins) / wins.length) * 100) / 100 : null,
    avgLoss: losses.length ? Math.round((sum(losses) / losses.length) * 100) / 100 : null,
  };
}

export const fmtPnl = (n: number | null): string => (n === null ? '?' : `${n > 0 ? '+' : ''}${n.toFixed(2)} USDT`);

// ---------- Acil durum nöbeti ----------
export interface PricePoint {
  t: number; // ms
  price: number;
}
export interface EmergencyConfig {
  move5: number; // 5 dakikada aleyhe % hareket
  move15: number; // 15 dakikada aleyhe % hareket
  marginLossPct: number; // teminatın yüzde kaçı eridiğinde
}
export const EMERGENCY_DEFAULTS: EmergencyConfig = { move5: 1.5, move15: 2.5, marginLossPct: 50 };

export interface Emergency {
  kind: 'SERT' | 'STOP' | 'MARJIN';
  text: string;
}

/** Pencere içindeki en kötü referansa göre aleyhe hareket yüzdesi (LONG: tepeden düşüş, SHORT: dipten yükseliş). */
export function adverseMove(direction: string, history: PricePoint[], now: number, windowMs: number, price: number): number {
  const w = history.filter((h) => now - h.t <= windowMs).map((h) => h.price);
  if (!w.length) return 0;
  const ref = direction === 'SHORT' ? Math.min(...w) : Math.max(...w);
  if (!ref) return 0;
  return direction === 'SHORT' ? ((price - ref) / ref) * 100 : ((ref - price) / ref) * 100;
}

/**
 * Açık pozisyon için acil durum var mı?
 *  STOP   : fiyat stop seviyesinin ötesine geçmiş ama pozisyon hâlâ açık görünüyor
 *  MARJIN : teminatın büyük kısmı erimiş (giriş ve kaldıraç biliniyorsa)
 *  SERT   : kısa sürede pozisyonun aleyhine sert hareket
 */
export function emergency(
  p: { symbol: string; direction: string; entry: number | null; leverage: number | null; stopLoss: number | null },
  price: number,
  history: PricePoint[],
  now: number,
  cfg: EmergencyConfig = EMERGENCY_DEFAULTS,
): Emergency | null {
  const short = p.direction === 'SHORT';
  if (p.stopLoss) {
    const asim = short ? ((price - p.stopLoss) / p.stopLoss) * 100 : ((p.stopLoss - price) / p.stopLoss) * 100;
    if (asim >= 0.2) return { kind: 'STOP', text: `fiyat stop seviyesini %${asim.toFixed(2)} aştı, pozisyon hâlâ açık görünüyor` };
  }
  if (p.entry && p.leverage) {
    const aleyhe = short ? ((price - p.entry) / p.entry) * 100 : ((p.entry - price) / p.entry) * 100;
    const erime = aleyhe * p.leverage;
    if (erime >= cfg.marginLossPct) return { kind: 'MARJIN', text: `teminatın yaklaşık %${Math.round(erime)}'i eridi (${p.leverage}x), likidasyon yaklaşıyor` };
  }
  // BTC ve ETH daha az oynak: eşik biraz düşük tutulur
  const k = p.symbol === 'BTC' || p.symbol === 'ETH' ? 0.7 : 1;
  const m5 = adverseMove(p.direction, history, now, 5 * 60_000 + 15_000, price);
  if (m5 >= cfg.move5 * k) return { kind: 'SERT', text: `son 5 dakikada aleyhine %${m5.toFixed(2)} sert hareket` };
  const m15 = adverseMove(p.direction, history, now, 15 * 60_000 + 15_000, price);
  if (m15 >= cfg.move15 * k) return { kind: 'SERT', text: `son 15 dakikada aleyhine %${m15.toFixed(2)} sert hareket` };
  return null;
}

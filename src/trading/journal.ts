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

/**
 * Ön eleme: modeli çağırmadan önce kural tabanlı hızlı bakış (ücretsiz).
 * Aday coinlerde "trend + kırılım/ivme" yoksa otomatik taramada model çağrılmaz.
 * Karar yine modelindir; ön eleme yalnızca "bakmaya değer bir şey var mı" sorusunu yanıtlar.
 */
import type { CoinFeatures } from '../market/market.service';

export interface PreCandidate {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  why: string;
}

export const PRESCREEN = {
  MAX_ATR_PCT: 5, // 1 saatlik ATR bunun üstündeyse coin fazla oynak sayılır
  RSI_LONG_MAX: 72,
  RSI_SHORT_MIN: 28,
  MOMENTUM_ATR_MULT: 1.5, // 4 saatlik hareket en az 1,5 ATR
  MOMENTUM_MIN_PCT: 1,
};

export function trendOf(f: CoinFeatures): 'UP' | 'DOWN' | 'FLAT' {
  if (!f.ema20_1h || !f.ema50_1h) return 'FLAT';
  if (f.price > f.ema20_1h && f.ema20_1h > f.ema50_1h) return 'UP';
  if (f.price < f.ema20_1h && f.ema20_1h < f.ema50_1h) return 'DOWN';
  return 'FLAT';
}

/** Tek coin için aday mı? Değilse null. */
export function screenCoin(f: CoinFeatures): PreCandidate | null {
  const trend = trendOf(f);
  if (trend === 'FLAT') return null;
  if (f.atr14_1h_pct !== null && f.atr14_1h_pct > PRESCREEN.MAX_ATR_PCT) return null;
  const closes = f.last12_closes_1h || [];
  if (closes.length < 6) return null;
  const last = closes[closes.length - 1];
  const prev = closes.slice(0, -1);
  const rsi = f.rsi14_1h;
  const esik = Math.max(PRESCREEN.MOMENTUM_MIN_PCT, (f.atr14_1h_pct ?? 1) * PRESCREEN.MOMENTUM_ATR_MULT);
  if (trend === 'UP') {
    if (rsi !== null && rsi > PRESCREEN.RSI_LONG_MAX) return null;
    if (last >= Math.max(...prev)) return { symbol: f.symbol, direction: 'LONG', why: `yükselen trend + ${prev.length} saatlik kapanış zirvesi kırılımı` };
    if (f.chg4h >= esik) return { symbol: f.symbol, direction: 'LONG', why: `yükselen trend + 4 saatte %${f.chg4h} ivme` };
    return null;
  }
  if (rsi !== null && rsi < PRESCREEN.RSI_SHORT_MIN) return null;
  if (last <= Math.min(...prev)) return { symbol: f.symbol, direction: 'SHORT', why: `düşen trend + ${prev.length} saatlik kapanış dibi kırılımı` };
  if (f.chg4h <= -esik) return { symbol: f.symbol, direction: 'SHORT', why: `düşen trend + 4 saatte %${f.chg4h} ivme` };
  return null;
}

export function preScreen(features: CoinFeatures[]): PreCandidate[] {
  return features.map(screenCoin).filter((c): c is PreCandidate => !!c);
}

/** Aday yokken gönderilecek tek satırlık durum özeti. */
export function quietSummary(features: CoinFeatures[]): string {
  const ad = { UP: 'yukarı', DOWN: 'aşağı', FLAT: 'yatay' } as const;
  const majors = ['BTC', 'ETH', 'SOL']
    .map((s) => features.find((f) => f.symbol === s))
    .filter((f): f is CoinFeatures => !!f)
    .map((f) => `${f.symbol} ${ad[trendOf(f)]}${f.rsi14_1h !== null ? ` (RSI ${Math.round(f.rsi14_1h)})` : ''}`);
  return `${features.length} adayda trend + kırılım yok${majors.length ? `: ${majors.join(', ')}` : ''}`;
}

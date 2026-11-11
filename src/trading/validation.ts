import { EffectiveLimits, RULES, normalizeCoin } from './rules';

export interface LlmDecision {
  decision?: string;
  symbol?: string;
  direction?: string;
  leverage?: number;
  margin_usdt?: number;
  entry?: number;
  stop_loss?: number;
  take_profit?: number;
  confidence?: number;
  reasoning?: string;
  no_trade_reason?: string;
  adds_to_existing_position?: boolean;
  market_comment?: string;
  image_assessment?: string;
}

export interface TradeCard {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  leverage: number;
  margin: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  reasoning: string;
  positionSize: number;
  profitUsdt: number;
  profitPctMargin: number;
  lossUsdt: number;
  lossPctMargin: number;
  lossPctBalance: number;
  rr: number;
  adjustments: string[];
  exchange: 'BINANCE';
  exchangeSymbol: string; // e.g. SOLUSDT
  quantity: number | null; // coin amount for Binance order (step-size rounded)
}

/** Binance USDⓈ-M order filters (subset). */
export interface ExchangeFilters {
  symbol: string;
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

export type ValidationResult =
  | { status: 'TRADE'; card: TradeCard }
  | { status: 'NO_TRADE'; reason: string; rejected: boolean }
  | { status: 'KILL_SWITCH' };

export interface ValidationContext {
  balance: number;
  killSwitch: boolean;
  limits: EffectiveLimits;
  livePrice?: number | null;
  minConfidenceOverride?: number;
  /** Binance filters: object = listed, undefined = NOT listed on Binance, null = unknown (Binance unreachable). */
  exchangeFilters?: ExchangeFilters | null | undefined;
  checkListing?: boolean;
}

const decimalsOf = (step: number) => {
  const s = step.toString();
  if (s.includes('e-')) return parseInt(s.split('e-')[1], 10);
  return s.includes('.') ? s.split('.')[1].length : 0;
};
/** Round to exchange step. mode: 'down' | 'up' | 'nearest'. */
export function roundToStep(v: number, step: number, mode: 'down' | 'up' | 'nearest' = 'nearest'): number {
  if (!step || step <= 0) return v;
  const q = v / step;
  const k = mode === 'down' ? Math.floor(q + 1e-9) : mode === 'up' ? Math.ceil(q - 1e-9) : Math.round(q);
  return +(k * step).toFixed(decimalsOf(step));
}

const MARTINGALE_RE =
  /(martingale|average\s*down|averaging\s*down|ortalama\s*(d[uü][sş][uü]r|maliyet)|maliyet\s*d[uü][sş][uü]r|zarar(da|daki)\s*pozisyon(a|u)\s*(ekle|b[uü]y[uü]t)|pozisyona\s*ekle|kat\s*kat\s*art)/i;
const NEGATION_RE = /(yok|de[gğ]il|yasak|asla|yapma|kullanma|önerilmez|no\b|never)/i;

export function mentionsMartingale(text: string): boolean {
  if (!text) return false;
  return text
    .split(/[.!?\n]/)
    .some((sentence) => MARTINGALE_RE.test(sentence) && !NEGATION_RE.test(sentence));
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const toNum = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(',', '.'));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

/**
 * CODE-LEVEL ENFORCEMENT of immutable rules on the LLM output.
 * Never widens SL; may lower leverage / margin to fit limits; rejects anything unsafe.
 */
export function validateDecision(raw: LlmDecision, ctx: ValidationContext): ValidationResult {
  if (ctx.killSwitch || ctx.balance < RULES.KILL_SWITCH_THRESHOLD) return { status: 'KILL_SWITCH' };

  const reject = (reason: string): ValidationResult => ({ status: 'NO_TRADE', reason, rejected: true });
  const decision = String(raw?.decision || '').toUpperCase();
  if (decision !== 'TRADE') {
    return { status: 'NO_TRADE', reason: raw?.no_trade_reason || 'Net bir kurulum yok.', rejected: false };
  }

  const L = ctx.limits;
  const adjustments: string[] = [];
  const symbol = normalizeCoin(raw.symbol || '');
  const direction = String(raw.direction || '').toUpperCase() as 'LONG' | 'SHORT';
  let entry = toNum(raw.entry);
  let sl = toNum(raw.stop_loss);
  let tp = toNum(raw.take_profit);
  const fx = ctx.exchangeFilters;
  let lev = toNum(raw.leverage) ?? 1;
  let margin = toNum(raw.margin_usdt) ?? 0;
  const confidence = Math.round((toNum(raw.confidence) ?? 0) * 2) / 2;
  const minConf = Math.max(L.minConfidence, ctx.minConfidenceOverride ?? 0);

  if (!symbol) return reject('Parite belirtilmemiş.');
  if (direction !== 'LONG' && direction !== 'SHORT') return reject('Yön (LONG/SHORT) geçersiz.');
  if (raw.adds_to_existing_position || mentionsMartingale(`${raw.reasoning || ''}`))
    return reject('Martingale / zarardaki pozisyona ekleme YASAK. Bu kurulum reddedildi.');
  if (confidence < minConf) return { status: 'NO_TRADE', reason: `Güven skoru ${confidence}/10 (min ${minConf}). ${raw.reasoning || ''}`.trim(), rejected: false };
  if (L.bannedCoins.includes(symbol)) return reject(`${symbol} talimatınla yasaklı coin listesinde.`);
  if (L.allowedCoins && !L.allowedCoins.includes(symbol)) return reject(`${symbol} izin verilen coin listende yok.`);
  if (!L.allowedDirections.includes(direction)) return reject(`${direction} yönü talimatlarınla kapalı.`);
  if (!isNum(entry)) return reject('Giriş fiyatı yok/geçersiz.');
  if (!isNum(sl)) return reject('Stop-loss YOK — SL’siz işlem asla.');
  if (!isNum(tp)) return reject('Take-profit YOK — TP’siz işlem asla.');
  if (direction === 'LONG' && !(sl < entry && entry < tp)) return reject('LONG için SL < giriş < TP olmalı; seviyeler ters.');
  if (direction === 'SHORT' && !(tp < entry && entry < sl)) return reject('SHORT için TP < giriş < SL olmalı; seviyeler ters.');
  if (ctx.checkListing && fx === undefined) return reject(`${symbol}USDT Binance USDⓈ-M Futures'ta işlem görmüyor.`);

  // Binance tick-size rounding — SL only ever TIGHTENS, TP rounds toward entry (conservative)
  if (fx && fx.tickSize > 0) {
    const long = direction === 'LONG';
    entry = roundToStep(entry, fx.tickSize, 'nearest');
    sl = roundToStep(sl, fx.tickSize, long ? 'up' : 'down');
    tp = roundToStep(tp, fx.tickSize, long ? 'down' : 'up');
    if (long ? !(sl < entry && entry < tp) : !(tp < entry && entry < sl))
      return reject('Binance fiyat adımına yuvarlayınca seviyeler çakıştı; kurulum çok dar.');
  }

  if (isNum(ctx.livePrice)) {
    const dev = (Math.abs(entry - ctx.livePrice) / ctx.livePrice) * 100;
    if (dev > RULES.MAX_ENTRY_DEVIATION_PCT)
      return reject(`Giriş (${entry}) canlı fiyattan (${ctx.livePrice}) %${dev.toFixed(1)} uzak — güncel değil.`);
  }

  const slPct = Math.abs(entry - sl) / entry;
  const tpPct = Math.abs(tp - entry) / entry;
  const rr = tpPct / slPct;
  if (rr < RULES.MIN_RR) return reject(`Risk/ödül 1:${rr.toFixed(2)} — en az 1:${RULES.MIN_RR} olmalı.`);

  // leverage clamp
  const rawLev = lev;
  lev = Math.max(RULES.MIN_LEVERAGE, Math.min(L.maxLeverage, Math.floor(lev)));
  if (lev !== rawLev) adjustments.push(`Kaldıraç ${rawLev}x → ${lev}x (limit ${L.maxLeverage}x)`);
  // isolated liquidation buffer: SL must trigger well before liquidation
  if (slPct >= RULES.LIQ_SAFETY / lev) {
    const safeLev = Math.floor(RULES.LIQ_SAFETY / slPct);
    if (safeLev < 1) return reject('SL mesafesi çok geniş; 1x’te bile güvenli değil.');
    adjustments.push(`Kaldıraç ${lev}x → ${safeLev}x (SL likidasyondan önce tetiklensin)`);
    lev = safeLev;
  }
  // margin clamp
  const maxMargin = (ctx.balance * L.maxMarginPct) / 100;
  if (!isNum(margin)) margin = maxMargin * 0.25;
  if (margin > maxMargin) {
    adjustments.push(`Margin ${margin.toFixed(1)} → ${maxMargin.toFixed(1)} USDT (max %${L.maxMarginPct} bakiye)`);
    margin = maxMargin;
  }
  // max loss per trade
  const maxLoss = (ctx.balance * L.maxLossPct) / 100;
  if (margin * lev * slPct > maxLoss) {
    const m2 = maxLoss / (lev * slPct);
    adjustments.push(`Margin ${margin.toFixed(1)} → ${m2.toFixed(1)} USDT (SL kaybı ≤ bakiyenin %${L.maxLossPct}'u)`);
    margin = m2;
  }
  margin = Math.floor(margin * 10) / 10;
  if (margin < RULES.MIN_MARGIN_USDT) return reject(`Kurallara sığdırınca margin ${margin} USDT kalıyor — anlamsız küçük.`);

  let positionSize = margin * lev;
  let quantity: number | null = null;
  if (fx && fx.stepSize > 0) {
    quantity = roundToStep(positionSize / entry, fx.stepSize, 'down');
    if (quantity < fx.minQty) return reject(`Miktar ${quantity} < Binance minimumu ${fx.minQty} ${symbol}.`);
    if (quantity * entry < fx.minNotional) return reject(`Pozisyon ${(quantity * entry).toFixed(2)} USDT < Binance minimumu ${fx.minNotional} USDT.`);
    positionSize = quantity * entry;
    margin = Math.floor((positionSize / lev) * 100) / 100;
  } else {
    quantity = +(positionSize / entry).toPrecision(4);
  }
  const profitUsdt = positionSize * tpPct;
  const lossUsdt = positionSize * slPct;
  // final hard assertions
  if (lev > L.maxLeverage || lev > RULES.MAX_LEVERAGE || margin > maxMargin + 1e-9 || lossUsdt > maxLoss + 0.01)
    return reject('Son kontrol başarısız (limit aşımı).');

  return {
    status: 'TRADE',
    card: {
      symbol,
      direction,
      leverage: lev,
      margin,
      entry,
      stopLoss: sl,
      takeProfit: tp,
      confidence,
      reasoning: String(raw.reasoning || '').trim(),
      positionSize: +positionSize.toFixed(2),
      profitUsdt: +profitUsdt.toFixed(2),
      profitPctMargin: +((profitUsdt / margin) * 100).toFixed(1),
      lossUsdt: +lossUsdt.toFixed(2),
      lossPctMargin: +((lossUsdt / margin) * 100).toFixed(1),
      lossPctBalance: +((lossUsdt / ctx.balance) * 100).toFixed(1),
      rr: +rr.toFixed(2),
      adjustments,
      exchange: 'BINANCE',
      exchangeSymbol: fx?.symbol ?? `${symbol}USDT`,
      quantity,
    },
  };
}

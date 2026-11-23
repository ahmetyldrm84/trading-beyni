// Otomatik taramanın kart eşiği: OTO_MIN_GUVEN ile ayarlanır, temel eşiğin (6) altına inemez.
const otoMinGuven = Math.min(10, Math.max(6, Number(process.env.OTO_MIN_GUVEN) || 6));

// İşlem başına stop'taki azami kayıp (bakiyenin yüzdesi). AZAMI_KAYIP_YUZDE ile ayarlanır: 0,5-10, varsayılan 3.
const azamiKayip = Math.min(10, Math.max(0.5, Number(process.env.AZAMI_KAYIP_YUZDE) || 3));

// Kill switch eşiği (USDT): bakiye bunun altına inerse yeni kart verilmez. KILL_SWITCH ile ayarlanır, varsayılan 700.
const killEsik = Math.max(1, Number(process.env.KILL_SWITCH) || 700);

const sayi = (ad: string, varsayilan: number, min: number, max: number): number => {
  const v = process.env[ad];
  const n = v === undefined || v === '' ? varsayilan : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : varsayilan;
};
// İşlem başına SABİT risk (bakiyenin yüzdesi): marjı model değil sistem hesaplar. ISLEM_RISK_YUZDE, varsayılan 2.
const islemRisk = Math.min(azamiKayip, sayi('ISLEM_RISK_YUZDE', 2, 0.25, 10));
// En düşük ödül/risk oranı. MIN_ODUL_RISK, varsayılan 1,5.
const minRR = sayi('MIN_ODUL_RISK', 1.5, 1, 5);

// IMMUTABLE RULES — user instructions can only TIGHTEN these, never loosen.
export const RULES = {
  DEFAULT_BALANCE: 1000,
  KILL_SWITCH_THRESHOLD: killEsik,
  MIN_LEVERAGE: 1,
  MAX_LEVERAGE: 10,
  MAX_MARGIN_PCT: 50, // % of balance
  MAX_LOSS_PCT: azamiKayip, // max loss at SL as % of balance
  RISK_PCT: islemRisk, // fixed risk per trade as % of balance (margin is derived from it)
  MIN_CONFIDENCE: 6, // below => "Şu an işlem yok"
  AUTO_CARD_MIN_CONFIDENCE: otoMinGuven, // proactive cards from automatic scan
  MIN_RR: minRR, // TP distance / SL distance
  MIN_MARGIN_USDT: 5,
  MAX_ENTRY_DEVIATION_PCT: 3, // entry vs live price
  LIQ_SAFETY: 0.8, // SL distance % must be < LIQ_SAFETY / leverage (isolated liq buffer)
  TRADE_DEDUP_HOURS: 8,
  ALERT_DEDUP_HOURS: 6,
};

export interface UserConstraints {
  max_leverage?: number | null;
  max_margin_pct?: number | null;
  max_loss_pct?: number | null;
  min_confidence?: number | null;
  banned_coins?: string[] | null;
  allowed_coins?: string[] | null;
  allowed_directions?: ('LONG' | 'SHORT')[] | null;
}

export interface EffectiveLimits {
  maxLeverage: number;
  maxMarginPct: number;
  maxLossPct: number;
  minConfidence: number;
  bannedCoins: string[];
  allowedCoins: string[] | null;
  allowedDirections: ('LONG' | 'SHORT')[];
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

export function normalizeCoin(s: string): string {
  return String(s || '')
    .toUpperCase()
    .replace(/[-_/ ]?(USDT|USD|PERP|SWAP)+$/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

/** Merge immutable rules with user constraints; only ever tightens. */
export function computeLimits(list: UserConstraints[]): EffectiveLimits {
  const l: EffectiveLimits = {
    maxLeverage: RULES.MAX_LEVERAGE,
    maxMarginPct: RULES.MAX_MARGIN_PCT,
    maxLossPct: RULES.MAX_LOSS_PCT,
    minConfidence: RULES.MIN_CONFIDENCE,
    bannedCoins: [],
    allowedCoins: null,
    allowedDirections: ['LONG', 'SHORT'],
  };
  for (const c of list) {
    if (!c) continue;
    const lev = num(c.max_leverage);
    if (lev) l.maxLeverage = Math.max(RULES.MIN_LEVERAGE, Math.min(l.maxLeverage, Math.floor(lev)));
    const mm = num(c.max_margin_pct);
    if (mm) l.maxMarginPct = Math.min(l.maxMarginPct, mm);
    const ml = num(c.max_loss_pct);
    if (ml) l.maxLossPct = Math.min(l.maxLossPct, ml);
    const mc = num(c.min_confidence);
    if (mc) l.minConfidence = Math.min(10, Math.max(l.minConfidence, Math.round(mc)));
    if (Array.isArray(c.banned_coins))
      for (const b of c.banned_coins) {
        const n = normalizeCoin(b);
        if (n && !l.bannedCoins.includes(n)) l.bannedCoins.push(n);
      }
    if (Array.isArray(c.allowed_coins) && c.allowed_coins.length) {
      const set = c.allowed_coins.map(normalizeCoin).filter(Boolean);
      l.allowedCoins = l.allowedCoins ? l.allowedCoins.filter((x) => set.includes(x)) : set;
    }
    if (Array.isArray(c.allowed_directions) && c.allowed_directions.length) {
      const d = c.allowed_directions.map((x) => String(x).toUpperCase());
      l.allowedDirections = l.allowedDirections.filter((x) => d.includes(x));
    }
  }
  return l;
}

/**
 * Ödül/risk oranının hâlâ en az `minRR` kaldığı EN KÖTÜ giriş fiyatı.
 * LONG için bundan yukarıda, SHORT için bundan aşağıda girilmez.
 */
export function entryLimit(sl: number, tp: number, minRR: number = RULES.MIN_RR): number {
  return (tp + minRR * sl) / (1 + minRR);
}

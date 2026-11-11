import { EffectiveLimits } from '../trading/rules';
import { mentionsMartingale } from '../trading/validation';
import { esc } from '../trading/render';

// IMMUTABLE STOCK RULES — user instructions can only TIGHTEN these.
export const STOCK_RULES = {
  DEFAULT_BUDGET: 500, // USD per trade
  KILL_SWITCH_THRESHOLD: 250, // stock budget below => no stock cards
  ALLOW_SHORT: false, // spot cash account: LONG only
  MAX_LOSS_PCT: 5, // max loss at SL as % of budget (25 USD @ 500)
  MIN_SL_PCT: 0.5, // SL distance must be at least 0.5% (noise)
  MAX_SL_PCT: 12, // wider SL => reject
  MIN_RR: 1.5,
  MIN_CONFIDENCE: 6,
  AUTO_CARD_MIN_CONFIDENCE: 6.5,
  MAX_ENTRY_DEVIATION_PCT: 3,
  TRADE_DEDUP_HOURS: 24,
  ALERT_DEDUP_HOURS: 6,
  QQQ_ALERT_PCT: 1.5,
  STOCK_ALERT_PCT: 7,
};

export interface StockDecision {
  decision?: string;
  ticker?: string;
  direction?: string;
  entry?: number;
  stop_loss?: number;
  take_profit?: number;
  take_profit_2?: number | null;
  confidence?: number;
  reasoning?: string;
  exit_plan?: string;
  holding_period?: string;
  no_trade_reason?: string;
  adds_to_existing_position?: boolean;
  market_comment?: string;
  image_assessment?: string;
}

export interface StockCard {
  ticker: string;
  name?: string;
  direction: 'LONG';
  entry: number;
  stopLoss: number;
  takeProfit: number;
  takeProfit2: number | null;
  shares: number;
  fractional: boolean;
  positionUsd: number;
  budget: number;
  profitUsd: number;
  profitPct: number;
  profit2Usd: number | null;
  lossUsd: number;
  lossPct: number;
  lossPctBudget: number;
  rr: number;
  confidence: number;
  reasoning: string;
  exitPlan: string;
  holdingPeriod: string;
  adjustments: string[];
  earningsWarning?: string;
}

export type StockValidation =
  | { status: 'TRADE'; card: StockCard }
  | { status: 'NO_TRADE'; reason: string; rejected: boolean }
  | { status: 'KILL_SWITCH' };

export interface StockValidationCtx {
  budget: number;
  killSwitch: boolean;
  limits: EffectiveLimits;
  livePrice: number | null;
  name?: string;
  minConfidenceOverride?: number;
}

const n = (v: unknown): number | null => {
  const x = typeof v === 'string' ? parseFloat(v) : (v as number);
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

export function normalizeTicker(s: string): string {
  return String(s || '').toUpperCase().replace(/^(NASDAQ|NYSE)[:\s]+/, '').replace(/[^A-Z.]/g, '');
}

export function stockKillActive(budget: number, killSwitch: boolean) {
  return killSwitch || budget < STOCK_RULES.KILL_SWITCH_THRESHOLD;
}

export function validateStockDecision(raw: StockDecision, ctx: StockValidationCtx): StockValidation {
  if (stockKillActive(ctx.budget, ctx.killSwitch)) return { status: 'KILL_SWITCH' };
  const reject = (reason: string) => ({ status: 'NO_TRADE' as const, reason, rejected: true });
  if (!raw || String(raw.decision || '').toUpperCase() !== 'TRADE') {
    return { status: 'NO_TRADE', reason: raw?.no_trade_reason || 'Net bir kurulum yok.', rejected: false };
  }
  if (raw.adds_to_existing_position || mentionsMartingale(`${raw.reasoning || ''} ${raw.exit_plan || ''}`))
    return reject('Zarardaki pozisyona ekleme / ortalama düşürme (martingale) yasak.');

  const ticker = normalizeTicker(raw.ticker || '');
  if (!ticker) return reject('Hisse sembolü yok.');
  if (ctx.limits.bannedCoins.includes(ticker)) return reject(`${ticker} talimatın gereği yasaklı.`);

  const dir = String(raw.direction || '').toUpperCase();
  if (dir !== 'LONG' && !(STOCK_RULES.ALLOW_SHORT && dir === 'SHORT'))
    return reject('Hisse modülü sadece LONG (spot alım) önerir; açığa satış yok.');
  if (!ctx.limits.allowedDirections.includes('LONG')) return reject('Talimatın gereği LONG yön kapalı.');

  const entry = n(raw.entry);
  const sl = n(raw.stop_loss);
  const tp = n(raw.take_profit);
  if (!entry || !sl || !tp) return reject('Giriş, stop-loss ve take-profit zorunlu.');
  if (!(sl < entry && entry < tp)) return reject('Seviyeler hatalı: LONG için SL < giriş < TP olmalı.');

  const minConf = Math.max(ctx.limits.minConfidence, STOCK_RULES.MIN_CONFIDENCE, ctx.minConfidenceOverride ?? 0);
  const conf = Math.round((n(raw.confidence) ?? 0) * 2) / 2;
  if (conf < minConf) return { status: 'NO_TRADE', reason: raw.no_trade_reason || `Güven ${conf}/10 — eşik ${minConf}. Belirsizken işlem yok.`, rejected: false };

  if (ctx.livePrice) {
    const dev = (Math.abs(entry - ctx.livePrice) / ctx.livePrice) * 100;
    if (dev > STOCK_RULES.MAX_ENTRY_DEVIATION_PCT)
      return reject(`Giriş (${entry}) canlı fiyattan (${ctx.livePrice}) %${dev.toFixed(1)} uzak.`);
  }

  const slPct = ((entry - sl) / entry) * 100;
  if (slPct < STOCK_RULES.MIN_SL_PCT) return reject(`Stop çok dar (%${slPct.toFixed(2)}); gürültüde tetiklenir.`);
  if (slPct > STOCK_RULES.MAX_SL_PCT) return reject(`Stop çok geniş (%${slPct.toFixed(1)}).`);
  const rr = (tp - entry) / (entry - sl);
  if (rr < STOCK_RULES.MIN_RR) return reject(`Risk/ödül 1:${rr.toFixed(2)} — en az 1:${STOCK_RULES.MIN_RR} gerekli.`);

  const adjustments: string[] = [];
  const maxLossPct = Math.min(STOCK_RULES.MAX_LOSS_PCT, ctx.limits.maxLossPct);
  const maxLoss = (ctx.budget * maxLossPct) / 100;
  let position = ctx.budget;
  if ((position * slPct) / 100 > maxLoss) {
    position = (maxLoss / slPct) * 100;
    adjustments.push(`SL mesafesi %${slPct.toFixed(1)} olduğu için pozisyon ${ctx.budget}$ → ${position.toFixed(0)}$ küçültüldü (max kayıp ${maxLoss.toFixed(0)}$).`);
  }
  let shares = Math.floor(position / entry);
  let fractional = false;
  if (shares < 1) {
    shares = Math.floor((position / entry) * 1000) / 1000;
    fractional = true;
    if (shares <= 0) return reject('Pozisyon büyüklüğü hesaplanamadı.');
  }
  const positionUsd = shares * entry;

  let tp2 = n(raw.take_profit_2);
  if (tp2 && tp2 <= tp) {
    tp2 = null;
    adjustments.push('TP2, TP1’in altında olduğu için kaldırıldı.');
  }

  return {
    status: 'TRADE',
    card: {
      ticker,
      name: ctx.name,
      direction: 'LONG',
      entry,
      stopLoss: sl,
      takeProfit: tp,
      takeProfit2: tp2,
      shares,
      fractional,
      positionUsd: r2(positionUsd),
      budget: ctx.budget,
      profitUsd: r2(shares * (tp - entry)),
      profitPct: r2(((tp - entry) / entry) * 100),
      profit2Usd: tp2 ? r2(shares * (tp2 - entry)) : null,
      lossUsd: r2(shares * (entry - sl)),
      lossPct: r2(slPct),
      lossPctBudget: r2(((shares * (entry - sl)) / ctx.budget) * 100),
      rr: r2(rr),
      confidence: conf,
      reasoning: String(raw.reasoning || '').slice(0, 900),
      exitPlan: String(raw.exit_plan || 'TP’de kâr al, SL’de çık; plan dışı tutma yok.').slice(0, 500),
      holdingPeriod: String(raw.holding_period || '').slice(0, 100),
      adjustments,
    },
  };
}

export const fmtUsd = (p: number) => (Number.isFinite(p) ? `$${p >= 100 ? p.toFixed(2) : p.toFixed(p >= 1 ? 2 : 4)}` : '-');

export function renderStockCard(c: StockCard, meta: { source?: string; model?: string; title?: string; marketComment?: string; imageNote?: string; session?: string }): string {
  const lines = [
    `🏦 <b>${esc(meta.title || 'NASDAQ HİSSE KARTI')}</b>`,
    '',
    `📊 <b>Hisse:</b> ${esc(c.ticker)}${c.name ? ` — ${esc(c.name)}` : ''} — 🟢 <b>LONG (alım)</b>`,
    `💵 <b>Pozisyon:</b> ${c.shares}${c.fractional ? ' (kesirli)' : ''} adet ≈ <b>${fmtUsd(c.positionUsd)}</b> (bütçe ${fmtUsd(c.budget)}, kaldıraçsız)`,
    `🚪 <b>Giriş:</b> ${fmtUsd(c.entry)} (limit emir önerilir)`,
    `🛑 <b>Stop-loss:</b> ${fmtUsd(c.stopLoss)} (-%${c.lossPct})`,
    `✅ <b>Take-profit 1:</b> ${fmtUsd(c.takeProfit)} (+%${c.profitPct})`,
    c.takeProfit2 ? `🎯 <b>Take-profit 2:</b> ${fmtUsd(c.takeProfit2)} (TP1’de yarısını sat, kalanın stopunu girişe çek)` : '',
    `🚶 <b>Çıkış planı:</b> ${esc(c.exitPlan)}`,
    c.holdingPeriod ? `⏳ <b>Tahmini süre:</b> ${esc(c.holdingPeriod)}` : '',
    `🧠 <b>Güven skoru:</b> ${c.confidence}/10`,
    `📈 <b>Potansiyel kazanç (TP1):</b> +${fmtUsd(c.profitUsd)}${c.profit2Usd ? ` • TP2: +${fmtUsd(c.profit2Usd)}` : ''}`,
    `📉 <b>Potansiyel kayıp (SL):</b> -${fmtUsd(c.lossUsd)} (bütçenin %${c.lossPctBudget}'i)`,
    `⚖️ <b>Risk/Ödül:</b> 1:${c.rr}`,
    '',
    `📝 <b>Gerekçe:</b> ${esc(c.reasoning)}`,
  ].filter((x) => x !== '');
  if (c.earningsWarning) lines.push('', `⚠️ <b>Bilanço:</b> ${esc(c.earningsWarning)}`);
  if (meta.imageNote) lines.push('', `🖼 <b>Grafik yorumu:</b> ${esc(meta.imageNote)}`);
  if (meta.marketComment) lines.push('', `🌍 <b>Piyasa:</b> ${esc(meta.marketComment)}`);
  if (c.adjustments.length) lines.push('', `🔧 <b>Kural motoru düzeltti:</b>\n• ${c.adjustments.map(esc).join('\n• ')}`);
  lines.push(
    '',
    `🔒 Stop’u ASLA aşağı çekme • Düşene ekleme YOK • Giriş %1’den fazla kaçtıysa kovalama.`,
    `<i>📡 Veri: ${esc(meta.source || '-')}${meta.session ? ` • Seans: ${esc(meta.session)}` : ''} • Model: ${esc(meta.model || '-')} • Bu bir öneridir, emir gönderilmez. Komisyon hariç yaklaşık hesap.</i>`,
  );
  return lines.join('\n');
}

export function renderStockNoTrade(reason: string, meta: { source?: string; model?: string; marketComment?: string; imageNote?: string; rejected?: boolean; session?: string }): string {
  const lines = ['⏸ <b>Şu an hisse işlemi yok.</b>', '', `${meta.rejected ? '🛡 <b>Kural motoru reddetti:</b> ' : '💡 <b>Sebep:</b> '}${esc(reason)}`];
  if (meta.imageNote) lines.push('', `🖼 <b>Grafik yorumu:</b> ${esc(meta.imageNote)}`);
  if (meta.marketComment) lines.push('', `🌍 <b>Piyasa:</b> ${esc(meta.marketComment)}`);
  lines.push('', 'Nakit de bir pozisyondur. İyi kurulum gelince saldırırız. 🧠💪');
  lines.push(`<i>📡 Veri: ${esc(meta.source || '-')}${meta.session ? ` • Seans: ${esc(meta.session)}` : ''} • Model: ${esc(meta.model || '-')}</i>`);
  return lines.join('\n');
}

export function renderStockKill(budget: number): string {
  return [
    '🛑 <b>HİSSE KILL SWITCH AKTİF</b>',
    '',
    `Hisse bütçesi: <b>${fmtUsd(budget)}</b> (eşik: ${fmtUsd(STOCK_RULES.KILL_SWITCH_THRESHOLD)}).`,
    'Sermayeyi korumak için yeni hisse kartı VERMİYORUM. Mola ver, işlemlerini gözden geçir.',
    `Bütçe tekrar ≥${STOCK_RULES.KILL_SWITCH_THRESHOLD}$ olursa /hisse_bakiye ile güncelle, /hisse_reset ile aç.`,
  ].join('\n');
}

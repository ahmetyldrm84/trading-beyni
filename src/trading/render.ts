import { TradeCard } from './validation';

export const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function fmtPrice(p: number): string {
  if (!Number.isFinite(p)) return '-';
  const a = Math.abs(p);
  const d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return p.toFixed(d).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

export function renderCard(
  c: TradeCard,
  meta: { source?: string; model?: string; title?: string; marketComment?: string; imageNote?: string },
): string {
  const dirEmoji = c.direction === 'LONG' ? '🟢' : '🔴';
  const qty = c.quantity != null ? `${c.quantity} ${esc(c.symbol)}` : '-';
  const lines = [
    `🎯 <b>${esc(meta.title || 'İŞLEM KARTI')}</b>`,
    '',
    `🏛 <b>Borsa:</b> Binance USDⓈ-M Futures — <code>${esc(c.exchangeSymbol)}</code> Perpetual`,
    `📊 <b>Parite:</b> ${esc(c.symbol)}/USDT — ${dirEmoji} <b>${c.direction}</b>`,
    `⚙️ <b>Kaldıraç:</b> ${c.leverage}x — ⚠️ <b>Marj modu: ISOLATED</b> (Cross ASLA!)`,
    `💰 <b>Margin:</b> ${c.margin.toFixed(2)} USDT (pozisyon ≈ ${c.positionSize.toFixed(2)} USDT)`,
    `🔢 <b>Miktar:</b> <code>${qty}</code>`,
    `🚪 <b>Giriş:</b> ${fmtPrice(c.entry)}`,
    `🛑 <b>Stop-loss:</b> ${fmtPrice(c.stopLoss)}`,
    `✅ <b>Take-profit:</b> ${fmtPrice(c.takeProfit)}`,
    `🧠 <b>Güven skoru:</b> ${c.confidence}/10`,
    `📈 <b>Potansiyel kazanç (TP):</b> +${c.profitUsdt.toFixed(2)} USDT (+%${c.profitPctMargin} margin)`,
    `📉 <b>Potansiyel kayıp (SL):</b> -${c.lossUsdt.toFixed(2)} USDT (-%${c.lossPctMargin} margin, bakiyenin %${c.lossPctBalance}'i)`,
    `⚖️ <b>Risk/Ödül:</b> 1:${c.rr}`,
    '',
    `📝 <b>Gerekçe:</b> ${esc(c.reasoning)}`,
  ];
  if (meta.imageNote) lines.push('', `🖼 <b>Grafik yorumu:</b> ${esc(meta.imageNote)}`);
  if (meta.marketComment) lines.push('', `🌍 <b>Piyasa:</b> ${esc(meta.marketComment)}`);
  if (c.adjustments.length) lines.push('', `🔧 <b>Kural motoru düzeltti:</b>\n• ${c.adjustments.map(esc).join('\n• ')}`);
  const side = c.direction === 'LONG' ? 'Buy/Long (Al)' : 'Sell/Short (Sat)';
  lines.push(
    '',
    `🧭 <b>Binance'te aç:</b>`,
    `1) Futures → USDⓈ-M → <code>${esc(c.exchangeSymbol)}</code>`,
    `2) Marj: <b>Isolated</b> • Kaldıraç: <b>${c.leverage}x</b>`,
    `3) Limit • Fiyat <code>${fmtPrice(c.entry)}</code> • Miktar <code>${c.quantity ?? '-'}</code> ${esc(c.symbol)}`,
    `4) TP/SL kutusunu işaretle: TP <code>${fmtPrice(c.takeProfit)}</code> • SL <code>${fmtPrice(c.stopLoss)}</code> (tetik: Mark Price)`,
    `5) <b>${side}</b>`,
  );
  lines.push(
    '',
    `🔒 SL’yi ASLA genişletme • Zarardaki pozisyona ekleme YOK • Fiyat girişten %1’den fazla kaçtıysa kovalamak yok.`,
    `<i>📡 Veri: ${esc(meta.source || '-')} • Model: ${esc(meta.model || '-')} • Bu bir öneridir, emir gönderilmez. Komisyon/funding hariç yaklaşık hesap.</i>`,
  );
  return lines.join('\n');
}

export function renderNoTrade(reason: string, meta: { source?: string; model?: string; marketComment?: string; imageNote?: string; rejected?: boolean }): string {
  const lines = [
    `⏸ <b>Şu an işlem yok.</b>`,
    '',
    `${meta.rejected ? '🛡 <b>Kural motoru reddetti:</b> ' : '💡 <b>Sebep:</b> '}${esc(reason)}`,
  ];
  if (meta.imageNote) lines.push('', `🖼 <b>Grafik yorumu:</b> ${esc(meta.imageNote)}`);
  if (meta.marketComment) lines.push('', `🌍 <b>Piyasa:</b> ${esc(meta.marketComment)}`);
  lines.push('', `Sabır da bir pozisyondur. Kurşun atılmaz, iyi kurulum beklenir. 🧠💪`);
  lines.push(`<i>📡 Veri: ${esc(meta.source || '-')} • Model: ${esc(meta.model || '-')}</i>`);
  return lines.join('\n');
}

export function renderKillSwitch(balance: number): string {
  return [
    `🛑 <b>KILL SWITCH AKTİF</b>`,
    '',
    `Takip edilen bakiye: <b>${balance.toFixed(2)} USDT</b> (eşik: 100 USDT).`,
    `Kural net: bakiye 100 USDT’nin altına düştüğü için yeni işlem kartı VERMİYORUM. Bu seni korumak için.`,
    '',
    `Mola ver, günlüğüne bak, hataları analiz et. Bakiye tekrar ≥100 USDT olursa /bakiye ile güncelle ve /killswitch_reset ile sistemi aç.`,
  ].join('\n');
}

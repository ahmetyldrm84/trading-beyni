import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { card_result, position } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { MarketService } from '../market/market.service';
import { CleanPosition, EMERGENCY_DEFAULTS, PricePoint, ShotPosition, cleanPosition, emergency, fmtPnl, levelHit, openR, pnlAt, resolveCard, totals } from './journal';
import { RULES, normalizeCoin } from './rules';
import { esc, fmtPrice } from './render';

const SHOT_PROMPT = `Sana bir ekran görüntüsü veriliyor. Önce türünü belirle:
- "POSITIONS": borsa uygulamasında (Binance, Gate.io vb.) açık pozisyon, emir/işlem detayı, kapanmış pozisyon ya da gerçekleşen kâr-zarar ekranı.
- "CHART": fiyat grafiği (mumlar, göstergeler). Grafiğin üstünde pozisyon çizgisi olsa bile ağırlık grafikteyse CHART.
- "OTHER": hiçbiri.

POSITIONS ise ekrandaki HER pozisyonu oku. Yalnızca ekranda gördüğün değerleri yaz; göremediğin alanı null bırak, tahmin etme.
- status: pozisyon hâlâ açıksa "OPEN"; kapanmışsa (Closed / Kapandı / Realized PnL / Kapanış fiyatı varsa) "CLOSED".
- pnl_usdt: SADECE kapanmış işlemin gerçekleşen kâr/zararı (zarar negatif). Açık pozisyonun anlık (unrealized) kârını yazma.
- size_usdt: pozisyonun USDT cinsinden toplam büyüklüğü (kaldıraçlı). Coin adedi verilmişse giriş fiyatıyla çarp.
- margin_usdt: yatırılan teminat. leverage: sadece sayı.

SADECE şu JSON'u döndür:
{"kind":"POSITIONS|CHART|OTHER","positions":[{"symbol":"BTC","direction":"LONG|SHORT","status":"OPEN|CLOSED","entry":0,"exit":null,"leverage":null,"margin_usdt":null,"size_usdt":null,"stop_loss":null,"take_profit":null,"pnl_usdt":null}]}`;

@Injectable()
export class JournalService {
  private readonly logger = new Logger(JournalService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly market: MarketService,
  ) {}

  /** Görsel bir işlem/pozisyon ekranıysa pozisyonları döndürür; grafik ya da başka bir şeyse null. */
  async readScreenshot(imageDataUrl: string, caption: string): Promise<CleanPosition[] | null> {
    try {
      const res = await this.llm.chat(
        [
          { role: 'system', content: SHOT_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: caption ? `Kullanıcının notu: "${caption}"` : 'Ekran görüntüsü:' },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
        { json: true, maxTokens: 3000 },
      );
      const out = LlmService.parseJson<{ kind?: string; positions?: ShotPosition[] }>(res.content, res.truncated);
      if (String(out.kind || '').toUpperCase() !== 'POSITIONS' || !Array.isArray(out.positions)) return null;
      return out.positions.map(cleanPosition).filter((p): p is CleanPosition => !!p);
    } catch (e) {
      this.logger.warn(`Screenshot classify failed: ${(e as Error).message}`);
      return null; // emin değilsek eski davranış: grafik analizi
    }
  }

  private open(): Promise<position[]> {
    return this.prisma.position.findMany({ where: { status: 'OPEN' }, orderBy: { created_at: 'asc' } });
  }

  /** Ekrandan okunan pozisyonları deftere işler; kullanıcıya gösterilecek satırları döndürür. */
  async record(list: CleanPosition[]): Promise<string[]> {
    const lines: string[] = [];
    for (const p of list) {
      const acik = (await this.open()).filter((o) => o.symbol === p.symbol && o.direction === p.direction);
      if (p.status === 'OPEN') {
        const same = acik.find((o) => !o.entry || !p.entry || Math.abs(o.entry - p.entry) / p.entry < 0.005);
        if (same) {
          const r = await this.prisma.position.update({
            where: { id: same.id },
            data: {
              entry: p.entry ?? same.entry,
              leverage: p.leverage ?? same.leverage,
              margin: p.margin ?? same.margin,
              size: p.size ?? same.size,
              stop_loss: p.stopLoss ?? same.stop_loss,
              take_profit: p.takeProfit ?? same.take_profit,
            },
          });
          lines.push(`🔄 <b>#${r.id} ${esc(r.symbol)} ${r.direction}</b> zaten takipte, bilgileri güncelledim.${this.detay(r)}`);
        } else {
          const r = await this.prisma.position.create({
            data: {
              symbol: p.symbol,
              direction: p.direction,
              status: 'OPEN',
              entry: p.entry,
              leverage: p.leverage,
              margin: p.margin,
              size: p.size,
              stop_loss: p.stopLoss,
              take_profit: p.takeProfit,
              opened_at: new Date(),
            },
          });
          lines.push(`📌 <b>#${r.id} ${esc(r.symbol)} ${r.direction}</b> takibe alındı.${this.detay(r)}${r.stop_loss ? '' : '\n   ⚠️ Stop-loss görünmüyor. Kural: stopsuz işlem yok.'}${await this.girisUyarisi(r)}`);
        }
        continue;
      }
      // Kapanmış işlem: aynı ekran ikinci kez gönderildiyse tekrar yazma
      const since = new Date(Date.now() - 7 * 24 * 3600_000);
      // Aynı işlem ikinci kez gönderildiyse tekrar yazma. Coin adı farklı okunmuş olabilir (EVA / EVAA):
      // aynı coin + aynı kâr/zarar, ya da aynı yön + aynı kâr/zarar + aynı giriş fiyatı tekrar sayılır.
      const kapali = await this.prisma.position.findMany({ where: { status: 'CLOSED', direction: p.direction, created_at: { gte: since } } });
      const ayniGiris = (k: position) => !!k.entry && !!p.entry && Math.abs(k.entry - p.entry) / p.entry < 0.0005;
      if (!acik.length && p.pnl !== null && kapali.some((k) => k.pnl === p.pnl && (k.symbol === p.symbol ? !k.entry || !p.entry || Math.abs(k.entry - p.entry) / p.entry < 0.005 : ayniGiris(k)))) {
        lines.push(`↩️ ${esc(p.symbol)} ${p.direction} ${fmtPnl(p.pnl)} zaten defterde, tekrar eklemedim.`);
        continue;
      }
      const hedef = acik.find((o) => !o.entry || !p.entry || Math.abs(o.entry - p.entry) / p.entry < 0.005) ?? acik[acik.length - 1];
      if (hedef) {
        const size = p.size ?? hedef.size;
        const entry = p.entry ?? hedef.entry;
        const pnl = p.pnl ?? pnlAt({ direction: p.direction, entry, size }, p.exit);
        const r = await this.prisma.position.update({
          where: { id: hedef.id },
          data: { status: 'CLOSED', exit: p.exit, pnl, entry, size, leverage: p.leverage ?? hedef.leverage, margin: p.margin ?? hedef.margin, closed_at: new Date() },
        });
        lines.push(this.kapanisSatiri(r));
      } else {
        const r = await this.prisma.position.create({
          data: {
            symbol: p.symbol,
            direction: p.direction,
            status: 'CLOSED',
            entry: p.entry,
            exit: p.exit,
            leverage: p.leverage,
            margin: p.margin,
            size: p.size,
            stop_loss: p.stopLoss,
            take_profit: p.takeProfit,
            pnl: p.pnl,
            opened_at: new Date(),
            closed_at: new Date(),
          },
        });
        lines.push(this.kapanisSatiri(r));
      }
    }
    return lines;
  }

  /** Açılan pozisyonun girişi ve büyüklüğü kurallara uyuyor mu? Uymuyorsa uyarı satırı döndürür. */
  private async girisUyarisi(r: position): Promise<string> {
    const out: string[] = [];
    if (r.entry && r.stop_loss && r.take_profit) {
      const risk = Math.abs(r.entry - r.stop_loss);
      const rr = risk ? Math.abs(r.take_profit - r.entry) / risk : 0;
      if (rr && rr < RULES.MIN_RR - 0.005)
        out.push(`⚠️ Bu girişle ödül/risk 1:${rr.toFixed(2)}; kural en az 1:${RULES.MIN_RR}. Giriş karttaki sınırın dışında kalmış.`);
    }
    if (r.entry && r.stop_loss && r.size) {
      const owner = await this.prisma.owner.findFirst({ where: { id: 1 } });
      const hedef = owner ? (owner.balance * RULES.RISK_PCT) / 100 : 0;
      const kayip = (r.size * Math.abs(r.entry - r.stop_loss)) / r.entry;
      if (hedef && kayip > hedef * 1.25)
        out.push(`⚠️ Stop'ta kayıp ${kayip.toFixed(1)} USDT; kural işlem başına ${hedef.toFixed(1)} USDT (bakiyenin %${RULES.RISK_PCT}'i). Pozisyon karttakinden büyük.`);
    }
    return out.map((x) => `\n   ${x}`).join('');
  }

  // ===================== Kart sonucu takibi =====================
  /** Verilen her işlem kartını (alınsın alınmasın) sonucu izlenmek üzere kaydeder. */
  async registerCard(c: { symbol: string; direction: string; entry: number; stopLoss: number; takeProfit: number; rr?: number }, origin: string, signalId?: number | null, createdAt?: Date) {
    await this.prisma.card_result.create({
      data: { signal_id: signalId ?? null, origin, symbol: c.symbol, direction: c.direction, entry: c.entry, stop_loss: c.stopLoss, take_profit: c.takeProfit, rr: c.rr ?? null, status: 'OPEN', created_at: createdAt },
    });
  }

  /** Bu özellikten önce verilmiş kartları da takibe alır (bir kez). */
  private async backfillCards(): Promise<void> {
    const kartlar = await this.prisma.sent_signal.findMany({ where: { kind: 'TRADE', market: 'CRYPTO' }, orderBy: { created_at: 'asc' } });
    if (!kartlar.length) return;
    const var_ = new Set((await this.prisma.card_result.findMany({})).map((r) => r.signal_id));
    for (const k of kartlar) {
      if (var_.has(k.id)) continue;
      const p = (k.payload || {}) as any;
      if (!(p.entry > 0 && p.stopLoss > 0 && p.takeProfit > 0)) continue;
      await this.registerCard({ symbol: k.symbol!, direction: k.direction!, entry: p.entry, stopLoss: p.stopLoss, takeProfit: p.takeProfit, rr: p.rr }, k.origin || 'AUTO', k.id, k.created_at);
    }
  }

  /**
   * Sonuçlanmamış kartlarda önce stop mu hedef mi geldi, 15 dakikalık mumlardan bakar (model çağrısı yok).
   * 72 saatte sonuçlanmayan kart "süresi doldu" sayılır. Aynı mumda ikisi de görülürse SL sayılır.
   */
  async trackCards(): Promise<number> {
    await this.backfillCards();
    const acik = await this.prisma.card_result.findMany({ where: { status: 'OPEN' }, orderBy: { created_at: 'asc' }, take: 12 });
    const M15 = 15 * 60_000;
    const now = Date.now();
    let n = 0;
    for (const k of acik) {
      const bas = Math.max(k.created_at.getTime(), k.checked_at?.getTime() ?? 0);
      const gerek = Math.min(1500, Math.max(30, Math.ceil((now - bas) / M15) + 3));
      const r = await this.market.getKlines(k.symbol, undefined, gerek, '15m').catch(() => null);
      if (!r || !r.klines.length) continue;
      const kapanmis = r.klines.filter((c) => c.t + M15 <= now); // yalnızca tamamlanmış mumlar
      if (!kapanmis.length) continue;
      // Kartın verildiği mum kısmen kart öncesine ait: bir sonraki mumdan başla.
      const mumlar = kapanmis.filter((c) => c.t >= bas);
      const levels = { direction: k.direction, entry: k.entry, stopLoss: k.stop_loss, takeProfit: k.take_profit };
      // Veri kartın tarihine kadar inmiyorsa (çok eski kart) sonucu bilemeyiz.
      if (!k.checked_at && kapanmis[0].t > k.created_at.getTime() + 2 * M15) {
        await this.prisma.card_result.update({ where: { id: k.id }, data: { status: 'UNKNOWN', resolved_at: new Date() } });
        n++;
        continue;
      }
      const sonuc = resolveCard(levels, mumlar);
      const son = kapanmis[kapanmis.length - 1];
      if (sonuc) {
        await this.prisma.card_result.update({ where: { id: k.id }, data: { status: sonuc.status, exit: sonuc.exit, r: sonuc.r, resolved_at: new Date(sonuc.at + M15), checked_at: new Date(son.t + M15) } });
        n++;
      } else if (now - k.created_at.getTime() > 72 * 3600_000) {
        await this.prisma.card_result.update({ where: { id: k.id }, data: { status: 'EXPIRED', exit: son.c, r: openR(levels, son.c), resolved_at: new Date(), checked_at: new Date(son.t + M15) } });
        n++;
      } else {
        await this.prisma.card_result.update({ where: { id: k.id }, data: { checked_at: new Date(son.t + M15) } });
      }
    }
    return n;
  }

  private async cardStats(): Promise<{ line: string; rows: card_result[] }> {
    const rows = await this.prisma.card_result.findMany({ orderBy: { created_at: 'desc' } });
    const tp = rows.filter((r) => r.status === 'TP');
    const sl = rows.filter((r) => r.status === 'SL');
    const ex = rows.filter((r) => r.status === 'EXPIRED');
    const acik = rows.filter((r) => r.status === 'OPEN').length;
    const biten = tp.length + sl.length + ex.length;
    if (!biten) return { line: acik ? `🤖 Bot kartları: ${acik} kart izleniyor, henüz sonuçlanan yok.` : '', rows };
    const topR = [...tp, ...sl, ...ex].reduce((a, r) => a + (r.r ?? 0), 0);
    const kesin = tp.length + sl.length;
    return {
      line: `🤖 <b>Bot kartları</b> (alsan da almasan da): ${biten} sonuçlandı • hedef ${tp.length} • stop ${sl.length}${ex.length ? ` • süresi doldu ${ex.length}` : ''}${kesin ? ` • isabet %${Math.round((tp.length / kesin) * 100)}` : ''} • toplam ${topR >= 0 ? '+' : ''}${topR.toFixed(1)}R${acik ? ` • izlenen ${acik}` : ''}`,
      rows,
    };
  }

  /** /kartlar: son kartların sonucu */
  async cardsText(): Promise<string> {
    const { line, rows } = await this.cardStats();
    if (!rows.length) return '🤖 Henüz izlenen kart yok. Bot bir işlem kartı verdiğinde sonucunu burada görürsün.';
    const ad: Record<string, string> = { TP: '✅ hedef', SL: '❌ stop', EXPIRED: '⌛ süresi doldu', OPEN: '👀 izleniyor', UNKNOWN: '❔ veri yok' };
    const out = ['🤖 <b>KART SONUÇLARI</b>', ''];
    for (const r of rows.slice(0, 15))
      out.push(`• ${this.gun(r.created_at)} ${esc(r.symbol)} ${r.direction} ${fmtPrice(r.entry)} → ${ad[r.status] || r.status}${r.r !== null && r.status !== 'OPEN' ? ` (${r.r >= 0 ? '+' : ''}${r.r}R)` : ''}`);
    out.push('', line || '', '', '<i>Sonuç 15 dakikalık mumlardan okunur; kartın giriş fiyatından girildiği varsayılır. 1R = stop\'ta kaybedilecek tutar.</i>');
    return out.join('\n');
  }

  private kapanisSatiri(r: position): string {
    if (r.pnl === null)
      return `📕 <b>#${r.id} ${esc(r.symbol)} ${r.direction}</b> kapandı, ama kâr/zarar ekranda okunamadı. Yaz: <code>/kapat ${r.id} -4.2</code>`;
    return `${r.pnl >= 0 ? '✅' : '❌'} <b>#${r.id} ${esc(r.symbol)} ${r.direction}</b> kapandı: <b>${fmtPnl(r.pnl)}</b>`;
  }

  private detay(r: position): string {
    const p: string[] = [];
    if (r.entry) p.push(`giriş ${fmtPrice(r.entry)}`);
    if (r.leverage) p.push(`${r.leverage}x`);
    if (r.margin) p.push(`margin ${r.margin.toFixed(2)}`);
    else if (r.size) p.push(`büyüklük ${r.size.toFixed(2)}`);
    if (r.stop_loss) p.push(`SL ${fmtPrice(r.stop_loss)}`);
    if (r.take_profit) p.push(`TP ${fmtPrice(r.take_profit)}`);
    return p.length ? `\n   ${p.join(' • ')}` : '';
  }

  /** /kapat <id|coin> <kâr/zarar> */
  async closeManual(arg: string): Promise<string> {
    const m = arg.trim().match(/^#?(\S+)\s+([+\-−]?[0-9]+(?:[.,][0-9]+)?)\s*(?:usdt|\$)?$/i);
    if (!m) return 'Kullanım: <code>/kapat 3 12.5</code> ya da <code>/kapat BTC -4.2</code> (sayı = kâr/zarar, USDT)';
    const pnl = Number(m[2].replace('−', '-').replace(',', '.'));
    const acik = await this.open();
    const hedef = /^\d+$/.test(m[1])
      ? (await this.prisma.position.findFirst({ where: { id: Number(m[1]) } }))
      : acik.filter((o) => o.symbol === normalizeCoin(m[1])).pop();
    if (!hedef) return `Bu kayıt bulunamadı: ${esc(m[1])}. /islemler ile listeye bak.`;
    const r = await this.prisma.position.update({ where: { id: hedef.id }, data: { status: 'CLOSED', pnl, closed_at: hedef.closed_at ?? new Date() } });
    return `${this.kapanisSatiri(r)}\n\n${await this.summaryLine()}`;
  }

  /** /islem_sil <id> */
  async remove(arg: string): Promise<string> {
    const id = Number(arg.replace('#', '').trim());
    if (!Number.isInteger(id) || id <= 0) return 'Kullanım: <code>/islem_sil 3</code>';
    const r = await this.prisma.position.deleteMany({ where: { id } });
    return r.count ? `🗑 #${id} defterden silindi.\n\n${await this.summaryLine()}` : `#${id} bulunamadı.`;
  }

  private async prices(): Promise<Map<string, number>> {
    try {
      const { tickers } = await this.market.getTickers();
      return new Map(tickers.map((t) => [t.symbol, t.price]));
    } catch {
      return new Map();
    }
  }

  async summaryLine(): Promise<string> {
    const kapali = await this.prisma.position.findMany({ where: { status: 'CLOSED' } });
    const t = totals(kapali.map((k) => k.pnl));
    if (!t.count) return '📒 Defterde kapanmış işlem yok.';
    return `📒 Toplam: <b>${fmtPnl(t.total)}</b> • ${t.count} işlem (${t.wins} kâr / ${t.losses} zarar${t.winRate !== null ? `, isabet %${t.winRate}` : ''})`;
  }

  /** /islemler: açık pozisyonlar + son kapananlar + toplam */
  async listText(): Promise<string> {
    const acik = await this.open();
    const kapali = await this.prisma.position.findMany({ where: { status: 'CLOSED' }, orderBy: { closed_at: 'desc' }, take: 10 });
    if (!acik.length && !kapali.length)
      return '📒 Defter boş. Borsadaki pozisyonunun ya da kapanan işleminin ekran görüntüsünü gönder, deftere ekleyeyim.';
    const px = acik.length ? await this.prices() : new Map<string, number>();
    const out: string[] = ['📒 <b>İŞLEM DEFTERİ</b>', ''];
    out.push(`<b>Açık (${acik.length})</b>`);
    if (!acik.length) out.push('• yok');
    let anlik = 0;
    let anlikVar = false;
    for (const o of acik) {
      const fiyat = px.get(o.symbol) ?? null;
      const u = pnlAt({ direction: o.direction, entry: o.entry, size: o.size }, fiyat);
      if (u !== null) {
        anlik += u;
        anlikVar = true;
      }
      out.push(`• #${o.id} <b>${esc(o.symbol)} ${o.direction}</b>${this.detay(o).replace('\n   ', ' — ')}${fiyat ? `\n   şimdi ${fmtPrice(fiyat)}${u !== null ? ` → anlık <b>${fmtPnl(u)}</b>` : ''}` : ''}`);
    }
    if (anlikVar) out.push(`   Açık pozisyonların anlık toplamı: <b>${fmtPnl(Math.round(anlik * 100) / 100)}</b>`);
    out.push('', `<b>Son kapananlar</b>`);
    if (!kapali.length) out.push('• yok');
    for (const k of kapali) out.push(`• #${k.id} ${k.pnl === null ? '❔' : k.pnl >= 0 ? '✅' : '❌'} ${esc(k.symbol)} ${k.direction} → <b>${fmtPnl(k.pnl)}</b> <i>${this.gun(k.closed_at)}</i>`);
    out.push('', await this.summaryLine(), '', '<i>Kapatmak: /kapat 3 12.5 • Silmek: /islem_sil 3 • Özet: /karzarar</i>');
    return out.join('\n');
  }

  private gun(d: Date | null): string {
    return d ? d.toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit' }) : '';
  }

  /** /karzarar: kapanmış işlemlerin toplamı */
  async pnlText(): Promise<string> {
    const kapali = await this.prisma.position.findMany({ where: { status: 'CLOSED' }, orderBy: { closed_at: 'asc' } });
    if (!kapali.length) return '📊 Henüz kapanmış işlem yok. Kapanan işlemin ekran görüntüsünü gönder ya da <code>/kapat BTC 12.5</code> yaz.';
    const t = totals(kapali.map((k) => k.pnl));
    const gunStr = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
    const bugun = gunStr(new Date());
    const yedi = Date.now() - 7 * 24 * 3600_000;
    const tBugun = totals(kapali.filter((k) => k.closed_at && gunStr(k.closed_at) === bugun).map((k) => k.pnl));
    const tHafta = totals(kapali.filter((k) => k.closed_at && k.closed_at.getTime() >= yedi).map((k) => k.pnl));
    const out = [
      '📊 <b>KÂR / ZARAR</b>',
      '',
      `Toplam: <b>${fmtPnl(t.total)}</b>`,
      `Bugün: ${fmtPnl(tBugun.total)} (${tBugun.count} işlem) • Son 7 gün: ${fmtPnl(tHafta.total)} (${tHafta.count} işlem)`,
      '',
      `İşlem: ${t.count} • Kâr: ${t.wins} • Zarar: ${t.losses}${t.flat ? ` • Başabaş: ${t.flat}` : ''}${t.winRate !== null ? ` • İsabet: %${t.winRate}` : ''}`,
    ];
    if (t.avgWin !== null || t.avgLoss !== null) out.push(`Ortalama kâr: ${fmtPnl(t.avgWin)} • Ortalama zarar: ${fmtPnl(t.avgLoss)}`);
    if (t.best !== null) out.push(`En iyi: ${fmtPnl(t.best)} • En kötü: ${fmtPnl(t.worst)}`);
    if (t.unknown) out.push(`⚠️ ${t.unknown} işlemin kâr/zararı bilinmiyor, toplama girmedi (/islemler → /kapat ile tamamla).`);
    const kart = (await this.cardStats()).line;
    if (kart) out.push('', kart, '<i>Ayrıntı: /kartlar</i>');
    out.push('', '<i>Rakamlar ekran görüntülerinden okunur; komisyon ve funding ekranda görünen kadar dahildir.</i>');
    return out.join('\n');
  }

  private readonly gecmis = new Map<string, PricePoint[]>();
  private readonly sonAcil = new Map<string, number>();

  private flags(o: position): string[] {
    return (o.alerted || '').split(',').filter(Boolean);
  }

  /**
   * Dakikalık pozisyon nöbeti (model çağrısı yok). Açık pozisyon yoksa hiçbir şey yapmaz.
   *  - Fiyat TP/SL seviyesine geldiyse bir kez haber verir.
   *  - Aleyhe sert kırılım, aşılmış stop ya da eriyen teminatta ACİL uyarısı gönderir.
   */
  async track(): Promise<string[]> {
    const acik = await this.open();
    if (!acik.length) {
      this.gecmis.clear();
      return [];
    }
    let px: Map<string, number>;
    try {
      const { tickers } = await this.market.getTickers(true);
      px = new Map(tickers.map((t) => [t.symbol, t.price]));
    } catch {
      return [];
    }
    const now = Date.now();
    const cfg = {
      move5: Number(process.env.ACIL_5DK) || EMERGENCY_DEFAULTS.move5,
      move15: Number(process.env.ACIL_15DK) || EMERGENCY_DEFAULTS.move15,
      marginLossPct: Number(process.env.ACIL_TEMINAT) || EMERGENCY_DEFAULTS.marginLossPct,
    };
    const acilAcik = (process.env.ACIL_UYARI || 'acik').toLowerCase() !== 'kapali';
    const out: string[] = [];
    for (const o of acik) {
      const fiyat = px.get(o.symbol);
      if (!fiyat) continue;
      const h = (this.gecmis.get(o.symbol) || []).filter((x) => now - x.t <= 16 * 60_000);
      const bayrak = this.flags(o);
      const anlik = pnlAt({ direction: o.direction, entry: o.entry, size: o.size }, fiyat);

      const acil = acilAcik ? emergency({ symbol: o.symbol, direction: o.direction, entry: o.entry, leverage: o.leverage, stopLoss: o.stop_loss }, fiyat, h, now, cfg) : null;
      const anahtar = `${o.id}:${acil?.kind}`;
      const kalici = acil && acil.kind !== 'SERT'; // STOP ve MARJIN pozisyon başına bir kez
      if (acil && !(kalici && bayrak.includes(acil.kind)) && now - (this.sonAcil.get(anahtar) || 0) > 30 * 60_000) {
        this.sonAcil.set(anahtar, now);
        if (kalici) await this.prisma.position.update({ where: { id: o.id }, data: { alerted: [...bayrak, acil.kind, 'SL'].filter((v, i, a) => a.indexOf(v) === i).join(',') } });
        out.push(
          [
            `🚨🚨 <b>ACİL — #${o.id} ${esc(o.symbol)} ${o.direction}</b>`,
            `Fiyat ${fmtPrice(fiyat)}: ${esc(acil.text)}.${anlik !== null ? ` Anlık: <b>${fmtPnl(anlik)}</b>` : ''}`,
            o.stop_loss
              ? `Stop ${fmtPrice(o.stop_loss)}. Borsada stop emrin duruyor mu hemen kontrol et; durmuyorsa <b>pozisyonu kapat</b>.`
              : `<b>Bu pozisyonda stop görünmüyor. Pozisyonu kapat</b> ya da hemen stop koy.`,
            `Kapattıysan ekran görüntüsünü gönder ya da <code>/kapat ${o.id} ${anlik ?? 0}</code> yaz.`,
          ].join('\n'),
        );
        continue;
      }

      const hit = levelHit({ direction: o.direction, stopLoss: o.stop_loss, takeProfit: o.take_profit }, fiyat);
      if (hit && !bayrak.includes(hit)) {
        await this.prisma.position.update({ where: { id: o.id }, data: { alerted: [...bayrak, hit].join(',') } });
        const tahmini = pnlAt({ direction: o.direction, entry: o.entry, size: o.size }, hit === 'TP' ? o.take_profit : o.stop_loss);
        out.push(
          `${hit === 'TP' ? '🎯' : '🛑'} <b>#${o.id} ${esc(o.symbol)} ${o.direction}</b>: fiyat ${fmtPrice(fiyat)}, ${hit} seviyesine (${fmtPrice((hit === 'TP' ? o.take_profit : o.stop_loss)!)}) geldi${tahmini !== null ? `, tahmini ${fmtPnl(tahmini)}` : ''}.\nBorsada kapandıysa kapanış ekran görüntüsünü gönder ya da <code>/kapat ${o.id} ${tahmini ?? 0}</code> yaz.`,
        );
      }
    }
    // Fiyat geçmişi: açık pozisyonu olan coinler için son 16 dakika
    const semboller = new Set(acik.map((o) => o.symbol));
    for (const sym of semboller) {
      const fiyat = px.get(sym);
      if (!fiyat) continue;
      const h = (this.gecmis.get(sym) || []).filter((x) => now - x.t <= 16 * 60_000 && x.t !== now);
      h.push({ t: now, price: fiyat });
      this.gecmis.set(sym, h);
    }
    for (const sym of [...this.gecmis.keys()]) if (!semboller.has(sym)) this.gecmis.delete(sym);
    return out;
  }
}

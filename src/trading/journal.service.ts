import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { position } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { MarketService } from '../market/market.service';
import { CleanPosition, EMERGENCY_DEFAULTS, PricePoint, ShotPosition, cleanPosition, emergency, fmtPnl, levelHit, pnlAt, totals } from './journal';
import { normalizeCoin } from './rules';
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
        { json: true, maxTokens: 900 },
      );
      const out = LlmService.parseJson<{ kind?: string; positions?: ShotPosition[] }>(res.content);
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
          lines.push(`📌 <b>#${r.id} ${esc(r.symbol)} ${r.direction}</b> takibe alındı.${this.detay(r)}${r.stop_loss ? '' : '\n   ⚠️ Stop-loss görünmüyor. Kural: stopsuz işlem yok.'}`);
        }
        continue;
      }
      // Kapanmış işlem: aynı ekran ikinci kez gönderildiyse tekrar yazma
      const since = new Date(Date.now() - 7 * 24 * 3600_000);
      const kapali = await this.prisma.position.findMany({ where: { status: 'CLOSED', symbol: p.symbol, direction: p.direction, created_at: { gte: since } } });
      if (!acik.length && p.pnl !== null && kapali.some((k) => k.pnl === p.pnl && (!k.entry || !p.entry || Math.abs(k.entry - p.entry) / p.entry < 0.005))) {
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

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmMessage, LlmService } from '../llm/llm.service';
import { ScanService } from '../trading/scan.service';
import { EffectiveLimits } from '../trading/rules';
import { StockMarketService, StockSnapshot, NDX_FALLBACK } from './stock-market.service';
import {
  STOCK_RULES,
  StockCard,
  StockDecision,
  normalizeTicker,
  renderStockCard,
  renderStockKill,
  renderStockNoTrade,
  stockKillActive,
  validateStockDecision,
} from './stock-rules';

export interface StockScanRequest {
  trigger: 'MANUAL' | 'AUTO' | 'PHOTO';
  userQuery?: string;
  imageDataUrl?: string;
  minConfidence?: number;
}
export interface StockScanResult {
  status: 'TRADE' | 'NO_TRADE' | 'KILL_SWITCH' | 'ERROR';
  text: string;
  card?: StockCard;
  model?: string;
  source?: string;
  snapshot?: StockSnapshot;
}

// Words that look like tickers but are common in Turkish/English chat
const TICKER_STOP = new Set(['ON', 'A', 'TP', 'SL', 'LONG', 'SHORT', 'USD', 'USDT', 'ET', 'VE', 'BU', 'NE', 'MI', 'MU', 'TARA', 'HISSE', 'NASDAQ', 'AL', 'SAT', 'ABD', 'RSI', 'ATR', 'SMA', 'EMA', 'OK', 'TEAM']);

@Injectable()
export class StockScanService {
  private readonly logger = new Logger(StockScanService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly market: StockMarketService,
    private readonly llm: LlmService,
    private readonly core: ScanService,
  ) {}

  /** Extract tickers written in UPPERCASE in the original text that are in the NDX universe (or given with $). */
  async extractTickers(text: string): Promise<string[]> {
    if (!text) return [];
    let universe = new Set(NDX_FALLBACK);
    try {
      const { quotes } = await this.market.getQuotes();
      universe = new Set([...quotes.map((q) => q.symbol), ...NDX_FALLBACK]);
    } catch {
      /* fallback list */
    }
    const out: string[] = [];
    for (const m of text.matchAll(/\$([A-Za-z]{1,5})\b/g)) out.push(m[1].toUpperCase());
    for (const m of text.matchAll(/\b([A-Z]{1,5})\b/g)) {
      const t = m[1];
      if (!TICKER_STOP.has(t) && universe.has(t)) out.push(t);
    }
    return Array.from(new Set(out)).slice(0, 3);
  }

  private systemPrompt(budget: number, limits: EffectiveLimits, instructions: string[]): string {
    const maxLossPct = Math.min(STOCK_RULES.MAX_LOSS_PCT, limits.maxLossPct);
    return `Sen "Trading Beyni"nin NASDAQ hisse modülüsün: NASDAQ-100 hisselerinde kısa vadeli (swing, birkaç gün–birkaç hafta) disiplinli bir işlem analisti. Sadece ÖNERİ verirsin, emir göndermezsin.
Kullanıcının işlem başı hisse bütçesi: ${budget.toFixed(0)} USD (kaldıraçsız, spot alım).

DEĞİŞMEZ KURALLAR (kod da denetler; ihlal eden öneri reddedilir):
- Sadece LONG (alım). Açığa satış yok. Düşüş beklentisi varsa NO_TRADE.
- entry, stop_loss, take_profit zorunlu: stop_loss < entry < take_profit. İstersen take_profit_2 (> take_profit) ver.
- SL mesafesi %${STOCK_RULES.MIN_SL_PCT}–%${STOCK_RULES.MAX_SL_PCT}; SL'de kayıp bütçenin en fazla %${maxLossPct}'i olmalı (≈ ${((budget * maxLossPct) / 100).toFixed(0)} USD). Yani tercihen SL mesafesi ≤ %${maxLossPct}; daha genis SL gerekiyorsa kod pozisyonu küçültür.
- Risk/ödül (TP1) en az 1:${STOCK_RULES.MIN_RR}.
- Entry canlı fiyata yakın (≤%${STOCK_RULES.MAX_ENTRY_DEVIATION_PCT}). Piyasa kapalıysa son fiyatı baz al ve bunu belirt.
- Düşene ekleme / ortalama düşürme (martingale) YASAK. adds_to_existing_position her zaman false.
- Güven < ${limits.minConfidence} ise decision = "NO_TRADE". Emin değilsen NO_TRADE de; bu geçerli bir cevaptır.
- Bilanço açıklamasına çok yakın hisselerde dikkatli ol; exit_plan'da "bilanço öncesi çık" gibi kural yaz.
${limits.bannedCoins.length ? `- Yasaklı semboller: ${limits.bannedCoins.join(', ')}\n` : ''}
KULLANICININ KALICI TALIMATLARI (sadece SIKILAŞTIRIR; kripto kaldıraç talimatları hisseler için geçersizdir çünkü kaldıraç yok):
${instructions.length ? instructions.map((t, i) => `${i + 1}. ${t}`).join('\n') : '(yok)'}

Analiz: QQQ/SPY yönü ve VIX, hissenin trendi (SMA20/50), RSI14, ATR%, hacim oranı, 20 günlük / 6 aylık aralık konumu, momentum. SL'yi yapısal seviyeye (son dip / ATR) koy. Aşırı uzamış (RSI>75, günlük +%8 üstü) hisseyi kovalama.
Tüm metin alanları Türkçe, enerjik ama disiplinli; kısa.

SADECE şu yapıda ham JSON döndür (markdown yok):
{"decision":"TRADE veya NO_TRADE","ticker":"NVDA","direction":"LONG","entry":0,"stop_loss":0,"take_profit":0,"take_profit_2":null,"confidence":7 (1-10, yarım puan olabilir: 6.5),"reasoning":"2-4 cümle gerekçe","exit_plan":"çıkış kuralları (TP/SL dışında: süre stopu, bilanço öncesi çıkış, trailing vb.)","holding_period":"ör. 3-10 işlem günü","no_trade_reason":"NO_TRADE ise kısa sebep","adds_to_existing_position":false,"market_comment":"1-2 cümle genel piyasa","image_assessment":"görsel varsa 1-3 cümle, yoksa boş"}`;
  }

  private block(s: StockSnapshot): string {
    return JSON.stringify({
      veri_kaynagi: s.source,
      zaman_utc: s.fetchedAt,
      seans: `${s.session.labelTr} (${s.session.etTime})`,
      endeksler: s.indices,
      nasdaq100: s.quotes.map((q) => [q.symbol, q.price, q.changePct]),
      nasdaq100_format: '[sembol, fiyat USD, günlük %]',
      aday_hisse_gunluk_teknik: s.features,
    });
  }

  async scan(req: StockScanRequest): Promise<StockScanResult> {
    const t0 = Date.now();
    const owner = await this.core.getOwner();
    if (stockKillActive(owner.stock_budget, owner.stock_kill_switch)) {
      await this.log(req.trigger, null, null, 'KILL_SWITCH', 'hisse kill switch aktif', null, t0);
      return { status: 'KILL_SWITCH', text: renderStockKill(owner.stock_budget) };
    }
    let snapshot: StockSnapshot | undefined;
    let model: string | undefined;
    try {
      const ins = await this.core.getActiveInstructions();
      const limits = await this.core.getLimits();
      const mentioned = await this.extractTickers(req.userQuery || '');
      snapshot = await this.market.getSnapshot(mentioned);

      const recent = await this.prisma.sent_signal.findMany({
        where: { kind: 'TRADE', market: 'STOCK', created_at: { gte: new Date(Date.now() - 3 * 24 * 3600_000) } },
        orderBy: { created_at: 'desc' },
        take: 10,
      });
      const parts = [
        `CANLI PİYASA VERİSİ (json):\n${this.block(snapshot)}`,
        recent.length ? `Son 3 günde verilen hisse kartları (tekrar etme, açık olabilirler — aynı hisseye ekleme önerme): ${recent.map((r) => `${r.symbol} @${r.entry}`).join('; ')}` : '',
        req.trigger === 'AUTO'
          ? `GÖREV: Otomatik tarama. Sadece net ve güçlü (güven ≥${STOCK_RULES.AUTO_CARD_MIN_CONFIDENCE}) fırsat varsa TRADE, yoksa NO_TRADE.`
          : 'GÖREV: NASDAQ-100 + endeks bağlamını tara, EN İYİ TEK hisse işlemini ver ya da NO_TRADE.',
        req.userQuery ? `Kullanıcının mesajı: "${req.userQuery}"${mentioned.length ? ` (sorduğu hisse: ${mentioned.join(', ')} — öncelikle onu değerlendir)` : ''}` : '',
        req.imageDataUrl ? 'Kullanıcı bir hisse grafiği ekran görüntüsü gönderdi: hisseyi/zaman dilimini/seviyeleri oku, canlı veriyle birleştir; canlı fiyatı esas al.' : '',
      ].filter(Boolean);
      const content: LlmMessage['content'] = req.imageDataUrl
        ? [
            { type: 'text', text: parts.join('\n\n') },
            { type: 'image_url', image_url: { url: req.imageDataUrl } },
          ]
        : parts.join('\n\n');

      const res = await this.llm.chat(
        [
          { role: 'system', content: this.systemPrompt(owner.stock_budget, limits, ins.map((i) => i.text)) },
          { role: 'user', content },
        ],
        { json: true, maxTokens: 1500 },
      );
      model = res.model;
      const raw = LlmService.parseJson<StockDecision>(res.content);
      const ticker = normalizeTicker(raw.ticker || '');
      const live = ticker ? await this.market.livePrice(ticker) : null;
      const v = validateStockDecision(raw, {
        budget: owner.stock_budget,
        killSwitch: owner.stock_kill_switch,
        limits,
        livePrice: live?.price ?? null,
        name: live?.name,
        minConfidenceOverride: req.minConfidence,
      });
      const meta = {
        source: `${snapshot.source}${snapshot.klineSource && snapshot.klineSource !== snapshot.source ? ` (günlük mum: ${snapshot.klineSource})` : ''}`,
        model,
        session: `${snapshot.session.labelTr}, ${snapshot.session.etTime}`,
        marketComment: raw.market_comment,
        imageNote: req.imageDataUrl ? raw.image_assessment : undefined,
      };
      await this.prisma.owner.update({ where: { id: 1 }, data: { last_stock_scan_at: new Date() } });

      if (v.status === 'TRADE') {
        const e = await this.market.getEarningsNote(v.card.ticker);
        if (e?.date) {
          const days = Math.round((e.date.getTime() - Date.now()) / 86400_000);
          if (days >= 0 && days <= 14)
            v.card.earningsWarning = `${e.date.toLocaleDateString('tr-TR')} tarihinde bilanço bekleniyor (~${days} gün). Bilanço öncesi pozisyonu kapatmayı düşün — gap riski SL’yi atlayabilir.`;
        }
        const text = renderStockCard(v.card, meta);
        await this.log(req.trigger, snapshot.source, model, 'TRADE', `${v.card.ticker} LONG conf=${v.card.confidence}`, null, t0);
        return { status: 'TRADE', text, card: v.card, model, source: snapshot.source, snapshot };
      }
      if (v.status === 'KILL_SWITCH') return { status: 'KILL_SWITCH', text: renderStockKill(owner.stock_budget) };
      await this.log(req.trigger, snapshot.source, model, v.rejected ? 'REJECTED' : 'NO_TRADE', v.reason.slice(0, 500), null, t0);
      return { status: 'NO_TRADE', text: renderStockNoTrade(v.reason, { ...meta, rejected: v.rejected }), model, source: snapshot.source, snapshot };
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.error(`Stock scan failed: ${msg}`);
      await this.log(req.trigger, snapshot?.source ?? null, model ?? null, 'ERROR', null, msg, t0);
      return { status: 'ERROR', text: `⚠️ Hisse taramasında hata: ${msg.slice(0, 300)}\nHata varken işlem yok. Birazdan tekrar dene.`, snapshot };
    }
  }

  private async log(trigger: string, source: string | null, model: string | null, result: string, summary: string | null, error: string | null, t0: number) {
    try {
      await this.prisma.scan_log.create({
        data: { trigger, market: 'STOCK', data_source: source, model, result, summary, error, duration_ms: Date.now() - t0 },
      });
    } catch (e) {
      this.logger.warn(`scan_log write failed: ${(e as Error).message}`);
    }
  }
}

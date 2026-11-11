import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { instruction, owner } from '../prisma/prisma.service';
import { MarketService, MarketSnapshot } from '../market/market.service';
import { LlmMessage, LlmService } from '../llm/llm.service';
import { RULES, UserConstraints, computeLimits, EffectiveLimits, normalizeCoin } from './rules';
import { LlmDecision, TradeCard, validateDecision } from './validation';
import { renderCard, renderKillSwitch, renderNoTrade } from './render';
import { PreCandidate, preScreen, quietSummary } from './prescreen';

export interface ScanRequest {
  trigger: 'MANUAL' | 'AUTO' | 'PHOTO';
  userQuery?: string;
  imageDataUrl?: string;
  minConfidence?: number;
  /** Ön elemenin bulduğu adaylar (modele bilgi olarak verilir). */
  hint?: string;
}

export interface ScanResult {
  status: 'TRADE' | 'NO_TRADE' | 'KILL_SWITCH' | 'ERROR';
  text: string;
  card?: TradeCard;
  model?: string;
  source?: string;
  snapshot?: MarketSnapshot;
  raw?: LlmDecision;
}

@Injectable()
export class ScanService {
  private readonly logger = new Logger(ScanService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly market: MarketService,
    private readonly llm: LlmService,
  ) {}

  async getOwner(): Promise<owner> {
    return this.prisma.owner.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  }

  async getActiveInstructions(): Promise<instruction[]> {
    return this.prisma.instruction.findMany({ where: { active: true }, orderBy: { id: 'asc' } });
  }

  async getLimits(): Promise<EffectiveLimits> {
    const ins = await this.getActiveInstructions();
    return computeLimits(ins.map((i) => (i.constraints || {}) as UserConstraints));
  }

  private systemPrompt(balance: number, limits: EffectiveLimits, instructions: string[]): string {
    return `Sen "Trading Beyni"sin: Binance USDⓈ-M (USDT perpetual) futures için disiplinli bir işlem analisti. Sadece ÖNERİ verirsin, emir göndermezsin.
Kullanıcı bakiyesi: ${balance.toFixed(2)} USDT.

DEĞİŞMEZ KURALLAR (kod da ayrıca denetler; ihlal eden öneri reddedilir):
- Her işlemde stop_loss VE take_profit zorunlu. LONG: stop_loss < entry < take_profit. SHORT: take_profit < entry < stop_loss.
- Marj modu her zaman ISOLATED.
- Martingale / zarardaki pozisyona ekleme / ortalama düşürme YASAK. adds_to_existing_position her zaman false.
- Kaldıraç 1x–${limits.maxLeverage}x (tam sayı).
- Margin ≤ bakiyenin %${limits.maxMarginPct}'i (${((balance * limits.maxMarginPct) / 100).toFixed(1)} USDT).
- SL'de kayıp (margin × kaldıraç × SL mesafesi%) ≤ bakiyenin %${limits.maxLossPct}'u (${((balance * limits.maxLossPct) / 100).toFixed(1)} USDT).
- SL mesafesi% < ${RULES.LIQ_SAFETY}/kaldıraç olmalı (likidasyondan önce SL).
- Risk/ödül en az 1:${RULES.MIN_RR}, tercihen 1:1.5+.
- Entry canlı fiyata yakın olmalı (≤%${RULES.MAX_ENTRY_DEVIATION_PCT}).
- Güven < ${limits.minConfidence} ise decision = "NO_TRADE". Emin değilsen NO_TRADE de; bu geçerli ve saygın bir cevaptır.
${limits.bannedCoins.length ? `- Yasaklı coinler: ${limits.bannedCoins.join(', ')}\n` : ''}${limits.allowedCoins ? `- Sadece şu coinler: ${limits.allowedCoins.join(', ')}\n` : ''}${limits.allowedDirections.length < 2 ? `- Sadece yön: ${limits.allowedDirections.join(', ')}\n` : ''}
KULLANICININ KALICI TALİMATLARI (kuralları sadece SIKILAŞTIRIR, asla gevşetemez):
${instructions.length ? instructions.map((t, i) => `${i + 1}. ${t}`).join('\n') : '(yok)'}

Analiz: trend (EMA20/50), RSI, momentum, 24s aralık konumu, hacim, funding, BTC yönü ve Fear&Greed. Likit (top hacimli) coinleri tercih et. SL'yi yapısal seviyeye (son swing / ATR) koy.
Tüm metin alanları Türkçe, enerjik ama disiplinli; kısa.

SADECE şu yapıda ham JSON döndür (markdown yok):
{"decision":"TRADE veya NO_TRADE","symbol":"SOL","direction":"LONG veya SHORT","leverage":5,"margin_usdt":30,"entry":0,"stop_loss":0,"take_profit":0,"confidence":7 (1-10, yarım puan olabilir: 6.5),"reasoning":"2-4 cümle gerekçe","no_trade_reason":"NO_TRADE ise kısa sebep, yoksa boş","adds_to_existing_position":false,"market_comment":"1-2 cümle genel piyasa","image_assessment":"görsel varsa 1-3 cümle grafik yorumu, yoksa boş"}`;
  }

  private marketBlock(s: MarketSnapshot): string {
    const compact = {
      veri_kaynagi: s.source,
      zaman: s.fetchedAt,
      fear_greed: s.fearGreed,
      majors: s.majors.map((m) => ({ s: m.symbol, p: m.price, ch24: +m.change24h.toFixed(2) })),
      top50_hacim: s.top50.map((t) => [t.symbol, t.price, t.change24h, Math.round(t.quoteVolume / 1e6) + 'M', t.funding ?? null]),
      top50_format: '[coin, fiyat, 24s%, 24s hacim USDT, funding]',
      aday_coin_1s_teknik: s.features,
    };
    return JSON.stringify(compact);
  }

  /**
   * Ön eleme: model çağırmadan aday var mı bakar. Veri alınamazsa null döner (o zaman model çağrılır).
   * Aday yoksa tarama kaydına "ELENDI" olarak işlenir.
   */
  async preScreen(): Promise<{ candidates: PreCandidate[]; summary: string } | null> {
    const t0 = Date.now();
    try {
      const snapshot = await this.market.getSnapshot();
      if (snapshot.features.length < 3) return null;
      const candidates = preScreen(snapshot.features);
      const summary = candidates.length ? candidates.map((c) => `${c.symbol} ${c.direction} (${c.why})`).join('; ') : quietSummary(snapshot.features);
      if (!candidates.length) {
        await this.prisma.owner.update({ where: { id: 1 }, data: { last_scan_at: new Date() } });
        await this.log('AUTO', snapshot.source, null, 'ELENDI', summary.slice(0, 500), null, t0);
      }
      return { candidates, summary };
    } catch (e) {
      this.logger.warn(`Pre-screen failed: ${(e as Error).message}`);
      return null;
    }
  }

  async scan(req: ScanRequest): Promise<ScanResult> {
    const t0 = Date.now();
    const owner = await this.getOwner();
    if (owner.kill_switch || owner.balance < RULES.KILL_SWITCH_THRESHOLD) {
      await this.log(req.trigger, null, null, 'KILL_SWITCH', 'kill switch aktif', null, t0);
      return { status: 'KILL_SWITCH', text: renderKillSwitch(owner.balance) };
    }
    let snapshot: MarketSnapshot | undefined;
    let model: string | undefined;
    try {
      const ins = await this.getActiveInstructions();
      const limits = computeLimits(ins.map((i) => (i.constraints || {}) as UserConstraints));
      const mentioned = this.extractCoins(req.userQuery || '');
      snapshot = await this.market.getSnapshot(mentioned);

      const recent = await this.prisma.sent_signal.findMany({
        where: { kind: 'TRADE', market: 'CRYPTO', created_at: { gte: new Date(Date.now() - 24 * 3600_000) } },
        orderBy: { created_at: 'desc' },
        take: 10,
      });
      const acik = await this.prisma.position.findMany({ where: { status: 'OPEN' } });
      const userParts: string[] = [
        `CANLI PİYASA VERİSİ (json):\n${this.marketBlock(snapshot)}`,
        recent.length
          ? `Son 24 saatte verilen kartlar (aynısını tekrar etme, açık olabilirler — aynı coine ekleme önerme): ${recent.map((r) => `${r.symbol} ${r.direction} @${r.entry}`).join('; ')}`
          : '',
        acik.length
          ? `Kullanıcının ŞU AN AÇIK pozisyonları (aynı coine ekleme önerme, korelasyonu hesaba kat): ${acik.map((o) => `${o.symbol} ${o.direction}${o.entry ? ` @${o.entry}` : ''}`).join('; ')}`
          : '',
        req.trigger === 'AUTO'
          ? `GÖREV: Otomatik periyodik tarama (zamanlamayı sistem yönetir; saat ya da gece yasağını gerekçe yapma). Güven ≥${RULES.AUTO_CARD_MIN_CONFIDENCE} olan EN İYİ TEK işlemi ver, yoksa NO_TRADE. NO_TRADE ise reasoning alanına tek cümlelik kısa gerekçe yaz.`
          : `GÖREV: 50 coin + piyasa bağlamını tara, EN İYİ TEK işlemi ver ya da NO_TRADE.`,
        req.hint ? `Kural tabanlı ön elemenin işaret ettiği adaylar (bağlayıcı değil, kendi değerlendirmeni yap): ${req.hint}` : '',
        req.userQuery ? `Kullanıcının mesajı: "${req.userQuery}" (belirli coin soruyorsa onu değerlendir).` : '',
        req.imageDataUrl
          ? 'Kullanıcı bir grafik ekran görüntüsü gönderdi: görseldeki coin/zaman dilimi/seviyeleri oku, canlı veriyle birleştir. Canlı fiyat görseldekinden farklıysa canlı fiyatı esas al.'
          : '',
      ].filter(Boolean);

      const userContent: LlmMessage['content'] = req.imageDataUrl
        ? [
            { type: 'text', text: userParts.join('\n\n') },
            { type: 'image_url', image_url: { url: req.imageDataUrl } },
          ]
        : userParts.join('\n\n');

      const res = await this.llm.chat(
        [
          { role: 'system', content: this.systemPrompt(owner.balance, limits, ins.map((i) => i.text)) },
          { role: 'user', content: userContent },
        ],
        { json: true, maxTokens: 1500 },
      );
      model = res.model;
      const raw = LlmService.parseJson<LlmDecision>(res.content);

      // live price lookup for entry sanity check
      let livePrice: number | null = null;
      let exchangeFilters: Awaited<ReturnType<MarketService['getBinanceFilters']>> = null;
      const sym = normalizeCoin(raw.symbol || '');
      if (sym) {
        const { tickers } = await this.market.getTickers();
        livePrice = tickers.find((t) => t.symbol === sym)?.price ?? null;
        exchangeFilters = await this.market.getBinanceFilters(sym);
      }
      const v = validateDecision(raw, {
        balance: owner.balance,
        killSwitch: owner.kill_switch,
        limits,
        livePrice,
        minConfidenceOverride: req.minConfidence,
        exchangeFilters,
        checkListing: true,
      });
      const meta = {
        source: `${snapshot.source}${snapshot.klineSource && snapshot.klineSource !== snapshot.source ? ` (mum: ${snapshot.klineSource})` : ''}`,
        model,
        marketComment: raw.market_comment,
        imageNote: req.imageDataUrl ? raw.image_assessment : undefined,
      };
      await this.prisma.owner.update({ where: { id: 1 }, data: { last_scan_at: new Date() } });

      if (v.status === 'TRADE') {
        const text = renderCard(v.card, meta);
        await this.log(req.trigger, snapshot.source, model, 'TRADE', `${v.card.symbol} ${v.card.direction} conf=${v.card.confidence}`, null, t0);
        return { status: 'TRADE', text, card: v.card, model, source: snapshot.source, snapshot, raw };
      }
      if (v.status === 'KILL_SWITCH') return { status: 'KILL_SWITCH', text: renderKillSwitch(owner.balance) };
      await this.log(req.trigger, snapshot.source, model, v.rejected ? 'REJECTED' : 'NO_TRADE', v.reason.slice(0, 500), null, t0);
      return { status: 'NO_TRADE', text: renderNoTrade(v.reason, { ...meta, rejected: v.rejected }), model, source: snapshot.source, snapshot, raw };
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.error(`Scan failed: ${msg}`);
      await this.log(req.trigger, snapshot?.source ?? null, model ?? null, 'ERROR', null, msg, t0);
      return {
        status: 'ERROR',
        text: `⚠️ Tarama sırasında hata: ${msg.slice(0, 300)}\nGüvenli taraf: hata varken işlem yok. Birazdan tekrar dene.`,
        snapshot,
      };
    }
  }

  extractCoins(text: string): string[] {
    const m = text.toUpperCase().match(/\b[A-Z0-9]{2,10}\b/g) || [];
    const stop = new Set(['VAR', 'MI', 'MU', 'BU', 'NE', 'TARA', 'LONG', 'SHORT', 'USDT', 'TP', 'SL', 'VE', 'IYI', 'ŞU']);
    return m.filter((x) => !stop.has(x) && /[A-Z]/.test(x)).slice(0, 3);
  }

  private async log(trigger: string, source: string | null, model: string | null, result: string, summary: string | null, error: string | null, t0: number) {
    try {
      await this.prisma.scan_log.create({
        data: { trigger, data_source: source, model, result, summary, error, duration_ms: Date.now() - t0 },
      });
    } catch (e) {
      this.logger.warn(`scan_log write failed: ${(e as Error).message}`);
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../prisma/prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService, stripHtml } from '../telegram/telegram.service';
import { ScanService, ScanResult } from '../trading/scan.service';
import { LlmService } from '../llm/llm.service';
import { MarketService } from '../market/market.service';
import { JournalService } from '../trading/journal.service';
import { RULES, UserConstraints, computeLimits } from '../trading/rules';
import { esc, fmtPrice } from '../trading/render';
import { StockScanService, StockScanResult } from '../stocks/stock-scan.service';
import { StockMarketService, etNow } from '../stocks/stock-market.service';
import { STOCK_RULES, fmtUsd, stockKillActive } from '../stocks/stock-rules';

const STOCK_WORD_RE = /(^|[^a-zçğıöşü])(hisse\w*|nasdaq|borsa|stock\w*|qqq|ndx)(?![a-zçğıöşü])/i;
const STOCK_ASK_RE = /tara|al[ıi]n[ıi]r|girilir|var\s*m[ıi]|ne\s*dersin|f[ıi]rsat|[oö]ner|analiz|al[ıi]ms?\b|girel[ıi]m/i;
const STOCK_BALANCE_RE = /hisse\s*(?:b[üu]t[çc]e(?:m|si)?|bakiye(?:m|si)?)\s*(?:[sş]u\s*an|art[ıi]k|oldu|:|=)?\s*([0-9]+(?:[.,][0-9]+)?)/i;

const SCAN_RE = /^\/?tara\b|var\s*m[ıi]\s*\??$|girilir\s*mi|i[sş]lem\s*var\s*m[ıi]|f[ıi]rsat\s*var|^\/?scan\b/i;
const JOURNAL_PNL_RE = /k[aâ]r\s*[\/-]?\s*zarar|\bpnl\b|ne\s*kadar\s*kazand[ıi]m/i;
const JOURNAL_LIST_RE = /^(a[çc][ıi]k\s*)?(i[sş]lemler(im)?|pozisyonlar(ım|im)?)\s*\??$|takip\s*listesi|i[sş]lem\s*defteri/i;
const BALANCE_RE = /bakiye(?:m|im)?\s*(?:[sş]u\s*an|art[ıi]k|oldu|:|=)?\s*([0-9]+(?:[.,][0-9]+)?)\s*(?:usdt|\$)?/i;

export interface AutoScanOptions {
  dryRun?: boolean;
  skipLlm?: boolean;
}

@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly tg: TelegramService,
    private readonly scanner: ScanService,
    private readonly llm: LlmService,
    private readonly market: MarketService,
    private readonly stocks: StockScanService,
    private readonly stockMarket: StockMarketService,
    private readonly journal: JournalService,
  ) {}

  // ===================== Webhook entry =====================
  async handleUpdate(update: any): Promise<void> {
    if (update?.update_id != null) {
      try {
        await this.prisma.processed_update.create({ data: { update_id: BigInt(update.update_id) } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          this.logger.log(`Duplicate update ${update.update_id} skipped`);
          return;
        }
        this.logger.warn(`processed_update write failed: ${(e as Error).message}`);
      }
    }
    const msg = update?.message || update?.edited_message;
    if (!msg?.chat?.id) return;
    const chatId = BigInt(msg.chat.id);
    const text: string = (msg.text || msg.caption || '').trim();
    this.logger.log(`Update ${update.update_id} type=${msg.photo ? 'photo' : msg.document ? 'document' : 'text'}`);

    const owner = await this.scanner.getOwner();
    if (owner.chat_id == null) {
      if (/^\/start\b/.test(text)) {
        await this.prisma.owner.update({
          where: { id: 1 },
          data: { chat_id: chatId, username: msg.from?.username ?? msg.from?.first_name ?? null },
        });
        this.logger.log('Owner registered');
        await this.reply(chatId, this.welcome(owner.balance), false);
      } else {
        await this.tg.send(chatId, 'Merhaba! Başlamak için /start yaz. 🚀');
      }
      return;
    }
    if (owner.chat_id !== chatId) {
      await this.tg.send(chatId, '🙏 Bu bot özel bir kişisel asistandır ve yalnızca sahibine hizmet verir. Anlayışın için teşekkürler!');
      return;
    }

    try {
      await this.route(chatId, msg, text);
    } catch (e) {
      this.logger.error(`Handler error: ${(e as Error).message}`);
      await this.tg.send(chatId, `⚠️ Bir hata oluştu: ${esc((e as Error).message.slice(0, 300))}`);
    }
  }

  private async route(chatId: bigint, msg: any, text: string) {
    // --- photos / image documents ---
    const photo = msg.photo?.length ? msg.photo[msg.photo.length - 1] : null;
    const imgDoc = msg.document && String(msg.document.mime_type || '').startsWith('image/') ? msg.document : null;
    if (photo || imgDoc) {
      await this.saveMsg('user', `[ekran görüntüsü] ${text}`);
      const isStockImg = STOCK_WORD_RE.test(text) || (await this.stocks.extractTickers(text)).length > 0;
      await this.tg.send(chatId, '🖼 Görseli aldım, bakıyorum... 🔍');
      await this.tg.typing(chatId);
      const dataUrl = await this.tg.fileAsDataUrl((photo || imgDoc).file_id);
      // İşlem / pozisyon ekranıysa deftere işle; grafikse aşağıda analiz et.
      if (!isStockImg) {
        const okunan = await this.journal.readScreenshot(dataUrl, text);
        if (okunan) {
          if (!okunan.length) return this.reply(chatId, 'Bu bir işlem ekranı gibi ama coin ve yönü okuyamadım. Daha net bir ekran görüntüsü gönderir misin?');
          const satirlar = await this.journal.record(okunan);
          return this.reply(chatId, [...satirlar, '', await this.journal.summaryLine(), '<i>Liste: /islemler • Özet: /karzarar</i>'].join('\n'));
        }
        await this.tg.send(chatId, '📈 Grafik olarak okudum, canlı veriyle birleştirip analiz ediyorum...');
        await this.tg.typing(chatId);
      }
      if (isStockImg) {
        const sres = await this.stocks.scan({ trigger: 'PHOTO', userQuery: text, imageDataUrl: dataUrl });
        await this.deliverStock(chatId, sres, 'MANUAL');
        return;
      }
      const res = await this.scanner.scan({ trigger: 'PHOTO', userQuery: text || 'Bu grafiği analiz et, işlem var mı?', imageDataUrl: dataUrl });
      await this.deliverScan(chatId, res, 'MANUAL');
      return;
    }
    if (!text) return;

    const cmd = text.match(/^\/([a-z_]+)(?:@\w+)?\s*([\s\S]*)$/i);
    if (cmd) {
      const name = cmd[1].toLowerCase();
      const arg = cmd[2].trim();
      switch (name) {
        case 'start':
          return this.reply(chatId, this.welcome((await this.scanner.getOwner()).balance), false);
        case 'yardim':
        case 'yardım':
        case 'help':
          return this.reply(chatId, this.help(), false);
        case 'tara':
        case 'scan':
          await this.saveMsg('user', text);
          return this.doScan(chatId, arg || undefined);
        case 'bakiye':
          if (arg) return this.setBalance(chatId, arg);
          return this.reply(chatId, `💼 Takip edilen bakiye: <b>${(await this.scanner.getOwner()).balance.toFixed(2)} USDT</b>\nGüncellemek için: <code>/bakiye 185</code>`, false);
        case 'durum':
          return this.reply(chatId, await this.status(), false);
        case 'talimatlar':
          return this.reply(chatId, await this.listInstructions(), false);
        case 'talimat_sil':
          return this.deleteInstruction(chatId, arg);
        case 'talimat':
          if (!arg) return this.reply(chatId, 'Kullanım: <code>/talimat kaldıracı 5x geçme</code>', false);
          await this.saveMsg('user', text);
          return this.freeChat(chatId, `Bunu kalıcı talimat olarak kaydet: ${arg}`, true);
        case 'islemler':
        case 'işlemler':
        case 'takip':
        case 'liste':
          return this.reply(chatId, await this.journal.listText(), false);
        case 'karzarar':
        case 'pnl':
        case 'ozet':
          return this.reply(chatId, await this.journal.pnlText(), false);
        case 'kapat':
          return this.reply(chatId, await this.journal.closeManual(arg), false);
        case 'islem_sil':
          return this.reply(chatId, await this.journal.remove(arg), false);
        case 'killswitch_reset':
          return this.resetKillSwitch(chatId);
        case 'hisse':
        case 'nasdaq':
        case 'hisse_tara':
          await this.saveMsg('user', text);
          return this.doStockScan(chatId, arg || undefined);
        case 'hisse_bakiye':
        case 'hisse_butce':
          if (arg) return this.setStockBudget(chatId, arg);
          return this.reply(chatId, `🏦 İşlem başı hisse bütçesi: <b>${fmtUsd((await this.scanner.getOwner()).stock_budget)}</b>\nGüncellemek için: <code>/hisse_bakiye 600</code>`, false);
        case 'hisse_reset':
          return this.resetStockKill(chatId);
        default:
          return this.reply(chatId, 'Bu komutu tanımıyorum. /yardim yaz, tüm komutları gör. 👍', false);
      }
    }

    await this.saveMsg('user', text);
    const sbal = text.match(STOCK_BALANCE_RE);
    if (sbal && text.length < 80) return this.setStockBudget(chatId, sbal[1]);
    if (text.length < 140) {
      const isStock = STOCK_WORD_RE.test(text) || (await this.stocks.extractTickers(text)).length > 0;
      if (isStock && (STOCK_ASK_RE.test(text) || SCAN_RE.test(text) || text.length <= 30)) return this.doStockScan(chatId, text);
    }
    if (text.length < 40 && JOURNAL_PNL_RE.test(text)) return this.reply(chatId, await this.journal.pnlText());
    if (text.length < 40 && JOURNAL_LIST_RE.test(text)) return this.reply(chatId, await this.journal.listText());
    const bal = text.match(BALANCE_RE);
    if (bal && text.length < 80) return this.setBalance(chatId, bal[1], true);
    if (SCAN_RE.test(text) && text.length < 120) return this.doScan(chatId, text);
    return this.freeChat(chatId, text, false);
  }

  // ===================== Scan =====================
  private async doScan(chatId: bigint, query?: string) {
    const o = await this.scanner.getOwner();
    if (o.kill_switch || o.balance < RULES.KILL_SWITCH_THRESHOLD) {
      const res = await this.scanner.scan({ trigger: 'MANUAL', userQuery: query });
      return this.deliverScan(chatId, res, 'MANUAL');
    }
    await this.tg.send(chatId, '🔍 Top 50 coin + piyasa bağlamı taranıyor... Disiplin modunda, sadece temiz kurulum! ⚡');
    await this.tg.typing(chatId);
    const res = await this.scanner.scan({ trigger: 'MANUAL', userQuery: query });
    await this.deliverScan(chatId, res, 'MANUAL');
  }

  // ===================== Stock scan =====================
  private async doStockScan(chatId: bigint, query?: string) {
    const o = await this.scanner.getOwner();
    if (!stockKillActive(o.stock_budget, o.stock_kill_switch)) {
      await this.tg.send(chatId, '🏦 NASDAQ-100 + QQQ/SPY/VIX bağlamı taranıyor... Sadece temiz kurulum, kovalamak yok! 📈');
      await this.tg.typing(chatId);
    }
    const res = await this.stocks.scan({ trigger: 'MANUAL', userQuery: query });
    await this.deliverStock(chatId, res, 'MANUAL');
  }

  private async deliverStock(chatId: bigint, res: StockScanResult, origin: 'MANUAL' | 'AUTO') {
    await this.tg.send(chatId, res.text);
    await this.saveMsg('assistant', this.stockSummary(res));
    if (res.status === 'TRADE' && res.card) await this.recordStock(res, origin);
  }

  private stockSummary(res: StockScanResult): string {
    if (res.status === 'TRADE' && res.card) {
      const c = res.card;
      return `[Hisse kartı verdim] ${c.ticker} LONG, ${c.shares} adet ≈ ${c.positionUsd}$, giriş ${c.entry}, SL ${c.stopLoss}, TP ${c.takeProfit}${c.takeProfit2 ? `/${c.takeProfit2}` : ''}, güven ${c.confidence}/10. Gerekçe: ${c.reasoning}`;
    }
    return stripHtml(res.text).slice(0, 800);
  }

  private async recordStock(res: StockScanResult, origin: 'MANUAL' | 'AUTO') {
    const c = res.card!;
    await this.prisma.sent_signal.create({
      data: { kind: 'TRADE', market: 'STOCK', origin, symbol: c.ticker, direction: 'LONG', entry: c.entry, confidence: c.confidence, payload: c as unknown as Prisma.InputJsonValue },
    });
  }

  private async setStockBudget(chatId: bigint, raw: string) {
    const v = parseFloat(raw.replace(',', '.'));
    if (!Number.isFinite(v) || v < 0 || v > 10_000_000) return this.reply(chatId, 'Geçerli bir sayı yaz: <code>/hisse_bakiye 600</code>', false);
    const before = await this.scanner.getOwner();
    const kill = v < STOCK_RULES.KILL_SWITCH_THRESHOLD ? true : before.stock_kill_switch;
    await this.prisma.owner.update({ where: { id: 1 }, data: { stock_budget: v, stock_kill_switch: kill } });
    const lines = [
      `🏦 Hisse bütçesi güncellendi: <b>${fmtUsd(v)}</b> (önceki ${fmtUsd(before.stock_budget)})`,
      `İşlem başı max kayıp: ${fmtUsd((v * STOCK_RULES.MAX_LOSS_PCT) / 100)} • kaldıraç yok • sadece LONG`,
    ];
    if (v < STOCK_RULES.KILL_SWITCH_THRESHOLD) lines.push('', `🛑 <b>HİSSE KILL SWITCH DEVREDE.</b> Bütçe ${fmtUsd(STOCK_RULES.KILL_SWITCH_THRESHOLD)} altında — yeni hisse kartı yok.`);
    else if (kill) lines.push('', '🔒 Hisse kill switch hâlâ aktif. Hazırsan /hisse_reset yaz.');
    return this.reply(chatId, lines.join('\n'));
  }

  private async resetStockKill(chatId: bigint) {
    const o = await this.scanner.getOwner();
    if (!o.stock_kill_switch) return this.reply(chatId, '✅ Hisse kill switch zaten kapalı.', false);
    if (o.stock_budget < STOCK_RULES.KILL_SWITCH_THRESHOLD)
      return this.reply(chatId, `❌ Reset reddedildi: hisse bütçesi ${fmtUsd(o.stock_budget)} (<${fmtUsd(STOCK_RULES.KILL_SWITCH_THRESHOLD)}).`, false);
    await this.prisma.owner.update({ where: { id: 1 }, data: { stock_kill_switch: false } });
    return this.reply(chatId, '🟢 Hisse kill switch sıfırlandı. Disiplinle devam! 📈', false);
  }

  private async deliverScan(chatId: bigint, res: ScanResult, origin: 'MANUAL' | 'AUTO') {
    await this.tg.send(chatId, res.text);
    await this.saveMsg('assistant', this.scanSummary(res));
    if (res.status === 'TRADE' && res.card) await this.recordTrade(res, origin);
  }

  private scanSummary(res: ScanResult): string {
    if (res.status === 'TRADE' && res.card) {
      const c = res.card;
      return `[İşlem kartı verdim] ${c.symbol} ${c.direction} ${c.leverage}x ISOLATED, margin ${c.margin} USDT, giriş ${c.entry}, SL ${c.stopLoss}, TP ${c.takeProfit}, güven ${c.confidence}/10. Gerekçe: ${c.reasoning}`;
    }
    return stripHtml(res.text).slice(0, 800);
  }

  private async recordTrade(res: ScanResult, origin: 'MANUAL' | 'AUTO') {
    const c = res.card!;
    await this.prisma.sent_signal.create({
      data: {
        kind: 'TRADE',
        origin,
        symbol: c.symbol,
        direction: c.direction,
        entry: c.entry,
        confidence: c.confidence,
        payload: c as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // ===================== Balance / kill switch =====================
  private async setBalance(chatId: bigint, raw: string, natural = false) {
    const v = parseFloat(raw.replace(',', '.'));
    if (!Number.isFinite(v) || v < 0 || v > 1_000_000) {
      return this.reply(chatId, 'Geçerli bir sayı yaz: <code>/bakiye 185</code>', false);
    }
    const before = await this.scanner.getOwner();
    const kill = v < RULES.KILL_SWITCH_THRESHOLD ? true : before.kill_switch;
    await this.prisma.owner.update({ where: { id: 1 }, data: { balance: v, kill_switch: kill } });
    const diff = v - before.balance;
    const lines = [
      `💼 Bakiye güncellendi: <b>${v.toFixed(2)} USDT</b> (${diff >= 0 ? '+' : ''}${diff.toFixed(2)})`,
      `Yeni limitler → max margin: ${((v * RULES.MAX_MARGIN_PCT) / 100).toFixed(1)} USDT • işlem başı max kayıp: ${((v * RULES.MAX_LOSS_PCT) / 100).toFixed(1)} USDT`,
    ];
    if (v < RULES.KILL_SWITCH_THRESHOLD) {
      lines.push('', '🛑 <b>KILL SWITCH DEVREYE GİRDİ.</b> Bakiye 100 USDT altında — yeni işlem kartı yok. Nefes al, sermayeyi koru. 🫁');
    } else if (kill) {
      lines.push('', '🔒 Kill switch hâlâ aktif. Hazırsan /killswitch_reset ile açabilirsin.');
    } else if (diff > 0) {
      lines.push('', 'Harika gidiyor! 🔥 Ama unutma: kazançtan sonra disiplin daha da önemli.');
    } else if (diff < 0) {
      lines.push('', 'Kayıp oyunun parçası. İntikam trade’i YOK, plana sadık kal. 💪');
    }
    if (natural) this.logger.log('Balance updated via natural language');
    return this.reply(chatId, lines.join('\n'));
  }

  private async resetKillSwitch(chatId: bigint) {
    const o = await this.scanner.getOwner();
    if (!o.kill_switch) return this.reply(chatId, '✅ Kill switch zaten kapalı. Sistem aktif.', false);
    if (o.balance < RULES.KILL_SWITCH_THRESHOLD)
      return this.reply(chatId, `❌ Reset reddedildi: bakiye ${o.balance.toFixed(2)} USDT (<100). Kural değişmez. Bakiye ≥100 olunca /bakiye ile güncelle.`, false);
    await this.prisma.owner.update({ where: { id: 1 }, data: { kill_switch: false } });
    return this.reply(chatId, '🟢 Kill switch sıfırlandı. Yeniden sahadayız — ama önce disiplin, sonra kâr! ⚡', false);
  }

  // ===================== Status / instructions =====================
  private async status(): Promise<string> {
    const o = await this.scanner.getOwner();
    const ins = await this.scanner.getActiveInstructions();
    const L = computeLimits(ins.map((i) => (i.constraints || {}) as UserConstraints));
    const lastScan = await this.prisma.scan_log.findFirst({ where: { market: 'CRYPTO' }, orderBy: { created_at: 'desc' } });
    const lastStock = await this.prisma.scan_log.findFirst({ where: { market: 'STOCK' }, orderBy: { created_at: 'desc' } });
    const fmtDate = (d?: Date | null) => (d ? d.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }) : '-');
    return [
      '📊 <b>DURUM</b>',
      `💼 Bakiye: <b>${o.balance.toFixed(2)} USDT</b>`,
      `🛑 Kill switch: ${o.kill_switch ? '<b>AKTİF</b> (kart yok)' : 'kapalı ✅'}`,
      `⚙️ Etkin limitler: kaldıraç ≤${L.maxLeverage}x • margin ≤%${L.maxMarginPct} • SL kaybı ≤%${L.maxLossPct} • min güven ${L.minConfidence}/10 • ISOLATED`,
      L.bannedCoins.length ? `🚫 Yasaklı: ${L.bannedCoins.join(', ')}` : '',
      L.allowedCoins ? `✅ Sadece: ${L.allowedCoins.join(', ')}` : '',
      L.allowedDirections.length < 2 ? `↕️ Sadece yön: ${L.allowedDirections.join(', ')}` : '',
      `📜 Aktif talimat: ${ins.length}${ins.length ? '\n' + ins.map((i) => `  #${i.id} ${esc(i.text)}`).join('\n') : ''}`,
      `🔍 Son kripto tarama: ${fmtDate(lastScan?.created_at)}${lastScan ? ` (${lastScan.trigger} → ${lastScan.result}${lastScan.data_source ? `, ${lastScan.data_source}` : ''})` : ''}`,
      '',
      '🏦 <b>NASDAQ HİSSE MODÜLÜ</b>',
      `💵 İşlem başı bütçe: <b>${fmtUsd(o.stock_budget)}</b> • kaldıraç yok • sadece LONG • SL kaybı ≤%${Math.min(STOCK_RULES.MAX_LOSS_PCT, L.maxLossPct)} • R/Ö ≥1:${STOCK_RULES.MIN_RR}`,
      `🛑 Hisse kill switch: ${stockKillActive(o.stock_budget, o.stock_kill_switch) ? '<b>AKTİF</b>' : 'kapalı ✅'}`,
      `🔍 Son hisse tarama: ${fmtDate(lastStock?.created_at)}${lastStock ? ` (${lastStock.trigger} → ${lastStock.result}${lastStock.data_source ? `, ${lastStock.data_source}` : ''})` : ''}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async listInstructions(): Promise<string> {
    const ins = await this.scanner.getActiveInstructions();
    if (!ins.length) return '📜 Henüz kalıcı talimat yok.\nÖrnek: "bundan sonra kaldıracı 5x geçme" yaz, kaydederim.';
    return ['📜 <b>KALICI TALİMATLAR</b>', ...ins.map((i) => `#${i.id} — ${esc(i.text)}`), '', 'Silmek için: <code>/talimat_sil ID</code>'].join('\n');
  }

  private async deleteInstruction(chatId: bigint, arg: string) {
    const id = parseInt(arg, 10);
    if (!id) return this.reply(chatId, 'Kullanım: <code>/talimat_sil 3</code> (ID için /talimatlar)', false);
    const r = await this.prisma.instruction.updateMany({ where: { id, active: true }, data: { active: false } });
    return this.reply(chatId, r.count ? `🗑 Talimat #${id} silindi.` : `#${id} numaralı aktif talimat bulunamadı.`, false);
  }

  // ===================== Free chat + instruction memory =====================
  private async freeChat(chatId: bigint, text: string, forceInstruction: boolean) {
    await this.tg.typing(chatId);
    const o = await this.scanner.getOwner();
    const ins = await this.scanner.getActiveInstructions();
    const history = (await this.prisma.chat_message.findMany({ orderBy: { id: 'desc' }, take: 21 })).reverse();
    // drop the just-saved current message from history (it is appended separately)
    if (history.length && history[history.length - 1].role === 'user') history.pop();
    let marketLine = '';
    try {
      const { source, tickers } = await this.market.getTickers();
      marketLine = `Canlı (${source}): ` + ['BTC', 'ETH', 'SOL']
        .map((s) => tickers.find((t) => t.symbol === s))
        .filter(Boolean)
        .map((t) => `${t!.symbol} ${fmtPrice(t!.price)} (${t!.change24h.toFixed(2)}%)`)
        .join(', ');
    } catch {
      marketLine = 'Canlı veri alınamadı.';
    }

    const system = `Sen "Trading Beyni"sin: kullanıcının kişisel Telegram trading asistanı. İki modülün var: (1) Binance USDⓈ-M kripto futures (kullanıcı işlemleri Binance'te elle açar), (2) NASDAQ-100 hisse (spot, kaldıraçsız, sadece LONG, işlem başı ${o.stock_budget.toFixed(0)} USD, SL kaybı ≤%${STOCK_RULES.MAX_LOSS_PCT}, R/Ö ≥1:${STOCK_RULES.MIN_RR}). Her zaman TÜRKÇE, enerjik, motive edici, cesur ama disiplinli konuş; kuralları asla çiğneme. Emir göndermezsin, sadece öneri verirsin.
Kripto bakiye: ${o.balance.toFixed(2)} USDT. Kill switch: ${o.kill_switch ? 'AKTİF' : 'kapalı'}. ${marketLine}
Değişmez kurallar: her işlemde SL+TP, SL asla genişletilmez, ISOLATED marj, martingale/zarardaki pozisyona ekleme yasak, kaldıraç 1-10x, margin ≤ bakiyenin %50'si, işlem başı SL kaybı ≤ %10, bakiye <100 USDT ise kill switch.
Aktif kalıcı talimatlar: ${ins.length ? ins.map((i) => `#${i.id} ${i.text}`).join(' | ') : 'yok'}
Sohbette işlem kartı ÜRETME; kullanıcı kripto işlem isterse "tara", hisse işlemi isterse "hisse tara" yazmasını veya ekran görüntüsü atmasını öner. Zarardaki pozisyona ekleme veya SL genişletme isterse kibarca ama net reddet.

GÖREV: Kullanıcının son mesajını sınıflandır ve cevapla. Mesaj ileriye dönük kalıcı bir kural/tercih ise (ör. "bundan sonra kaldıracı 5x geçme", "DOGE önerme", "sadece long ver", "marjı %20'yi geçmesin") intent="instruction".${forceInstruction ? ' (Kullanıcı bunu açıkça talimat olarak kaydetmek istiyor.)' : ''}
Talimat kuralları GEVŞETİYORSA (ör. "20x kaldıraç kullan", "SL koyma", "cross kullan") loosens_rules=true ve kaydetme; reply'da reddet.
Kullanıcı kripto işlem taraması istiyorsa intent="scan"; NASDAQ/hisse işlemi istiyorsa intent="stock_scan".
Yasaklanan hisse sembolleri de banned_coins alanına yazılır (ör. "TSLA önerme" → banned_coins:["TSLA"]).

SADECE ham JSON döndür:
{"intent":"chat | instruction | scan | stock_scan","reply":"kullanıcıya Türkçe cevap (düz metin, kısa-orta)","loosens_rules":false,"instruction":{"text":"talimatın kısa net hali","constraints":{"max_leverage":null,"max_margin_pct":null,"max_loss_pct":null,"min_confidence":null,"banned_coins":[],"allowed_coins":[],"allowed_directions":[]}}}
instruction sadece intent=instruction ise dolu olsun, yoksa null. constraints'te sadece talimattan kesin çıkan alanları doldur (sayılar sayı, coinler sembol: "DOGE", yönler "LONG"/"SHORT").`;

    const res = await this.llm.chat(
      [
        { role: 'system', content: system },
        ...history.map((h) => ({ role: h.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: h.content })),
        { role: 'user', content: text },
      ],
      { json: true, maxTokens: 1200 },
    );
    const out = LlmService.parseJson<any>(res.content);
    const intent = String(out.intent || 'chat');

    if (intent === 'scan') {
      if (out.reply) await this.tg.send(chatId, esc(out.reply));
      return this.doScan(chatId, text);
    }
    if (intent === 'stock_scan') {
      if (out.reply) await this.tg.send(chatId, esc(out.reply));
      return this.doStockScan(chatId, text);
    }
    if (intent === 'instruction' && out.instruction?.text && !out.loosens_rules) {
      const c = this.sanitizeConstraints(out.instruction.constraints);
      const row = await this.prisma.instruction.create({
        data: { text: String(out.instruction.text).slice(0, 500), constraints: c as unknown as Prisma.InputJsonValue },
      });
      const parsed = this.describeConstraints(c);
      const msg = `${esc(out.reply || 'Talimat kaydedildi.')}\n\n📝 <b>Kalıcı talimat #${row.id} kaydedildi:</b> ${esc(row.text)}${parsed ? `\n🔒 Kod seviyesinde uygulanacak: ${parsed}` : '\n(Bu talimat analiz prompt’una eklenecek.)'}`;
      return this.reply(chatId, msg);
    }
    return this.reply(chatId, esc(out.reply || 'Anladım. 👍'));
  }

  private sanitizeConstraints(c: any): UserConstraints {
    const out: UserConstraints = {};
    if (!c || typeof c !== 'object') return out;
    const n = (v: any) => (typeof v === 'number' && v > 0 ? v : typeof v === 'string' && parseFloat(v) > 0 ? parseFloat(v) : null);
    if (n(c.max_leverage)) out.max_leverage = Math.min(RULES.MAX_LEVERAGE, Math.floor(n(c.max_leverage)!));
    if (n(c.max_margin_pct)) out.max_margin_pct = Math.min(RULES.MAX_MARGIN_PCT, n(c.max_margin_pct)!);
    if (n(c.max_loss_pct)) out.max_loss_pct = Math.min(RULES.MAX_LOSS_PCT, n(c.max_loss_pct)!);
    if (n(c.min_confidence)) out.min_confidence = Math.max(RULES.MIN_CONFIDENCE, Math.min(10, Math.round(n(c.min_confidence)!)));
    const arr = (v: any) => (Array.isArray(v) ? v.map((x) => String(x).toUpperCase().trim()).filter(Boolean) : []);
    if (arr(c.banned_coins).length) out.banned_coins = arr(c.banned_coins);
    if (arr(c.allowed_coins).length) out.allowed_coins = arr(c.allowed_coins);
    const dirs = arr(c.allowed_directions).filter((d) => d === 'LONG' || d === 'SHORT') as ('LONG' | 'SHORT')[];
    if (dirs.length === 1) out.allowed_directions = dirs;
    return out;
  }

  private describeConstraints(c: UserConstraints): string {
    const p: string[] = [];
    if (c.max_leverage) p.push(`kaldıraç ≤${c.max_leverage}x`);
    if (c.max_margin_pct) p.push(`margin ≤%${c.max_margin_pct}`);
    if (c.max_loss_pct) p.push(`SL kaybı ≤%${c.max_loss_pct}`);
    if (c.min_confidence) p.push(`min güven ${c.min_confidence}`);
    if (c.banned_coins?.length) p.push(`yasaklı: ${c.banned_coins.join(', ')}`);
    if (c.allowed_coins?.length) p.push(`sadece: ${c.allowed_coins.join(', ')}`);
    if (c.allowed_directions?.length) p.push(`sadece ${c.allowed_directions.join('/')}`);
    return p.join(' • ');
  }

  // ===================== Açık pozisyon takibi (LLM'siz) =====================
  async trackPositions(): Promise<number> {
    const owner = await this.scanner.getOwner();
    if (owner.chat_id == null) return 0;
    const lines = await this.journal.track();
    for (const l of lines) await this.tg.send(owner.chat_id, l);
    return lines.length;
  }

  // ===================== Auto scan (cron) =====================
  async autoScan(opts: AutoScanOptions = {}) {
    const owner = await this.scanner.getOwner();
    const chatId = owner.chat_id;
    const result: Record<string, any> = { owner: chatId != null, alerts: [], card: null, dryRun: !!opts.dryRun };
    if (chatId == null && !opts.dryRun) {
      result.note = 'Owner yok (/start bekleniyor) — tarama atlandı.';
      return result;
    }
    const send = async (html: string) => {
      if (opts.dryRun || chatId == null) return;
      await this.tg.send(chatId, html);
    };

    // ---- 1) Sharp move alerts ----
    try {
      const { source, tickers } = await this.market.getTickers();
      result.source = source;
      const thresholds: Record<string, { h1: number; h24: number }> = {
        BTC: { h1: 2, h24: 6 },
        ETH: { h1: 3, h24: 8 },
        SOL: { h1: 3.5, h24: 10 },
      };
      const alerts: { key: string; sym: string; dir: string; line: string }[] = [];
      for (const sym of Object.keys(thresholds)) {
        const t = tickers.find((x) => x.symbol === sym);
        if (!t) continue;
        const k = await this.market.getKlines(sym, source, 30);
        const closes = k?.klines.map((x) => x.c) ?? [];
        const h1 = closes.length >= 2 ? ((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]) * 100 : 0;
        const th = thresholds[sym];
        if (Math.abs(h1) >= th.h1) {
          const dir = h1 > 0 ? 'UP' : 'DOWN';
          alerts.push({ key: `${sym}_1h_${dir}`, sym, dir, line: `${h1 > 0 ? '🚀' : '💥'} <b>${sym}</b> son 1 saatte <b>${h1 > 0 ? '+' : ''}${h1.toFixed(2)}%</b> → ${fmtPrice(t.price)}` });
        }
        if (Math.abs(t.change24h) >= th.h24) {
          const dir = t.change24h > 0 ? 'UP' : 'DOWN';
          alerts.push({ key: `${sym}_24h_${dir}`, sym, dir, line: `${t.change24h > 0 ? '📈' : '📉'} <b>${sym}</b> 24 saatte <b>${t.change24h > 0 ? '+' : ''}${t.change24h.toFixed(2)}%</b> → ${fmtPrice(t.price)}` });
        }
      }
      // big movers among top 15 by volume
      for (const t of tickers.slice(0, 15)) {
        if (thresholds[t.symbol]) continue;
        if (Math.abs(t.change24h) >= 15) {
          const dir = t.change24h > 0 ? 'UP' : 'DOWN';
          alerts.push({ key: `${t.symbol}_24h_${dir}`, sym: t.symbol, dir, line: `⚡ <b>${t.symbol}</b> (top hacim) 24 saatte <b>${t.change24h > 0 ? '+' : ''}${t.change24h.toFixed(2)}%</b> → ${fmtPrice(t.price)}` });
        }
      }
      const since = new Date(Date.now() - RULES.ALERT_DEDUP_HOURS * 3600_000);
      const fresh: typeof alerts = [];
      for (const a of alerts) {
        const dup = await this.prisma.sent_signal.findFirst({ where: { kind: 'ALERT', market: 'CRYPTO', alert_key: a.key, created_at: { gte: since } } });
        if (!dup) fresh.push(a);
      }
      result.alerts = fresh.map((a) => a.key);
      result.alertsSuppressed = alerts.length - fresh.length;
      if (fresh.length) {
        await send(['🚨 <b>SERT HAREKET ALARMI</b>', '', ...fresh.map((a) => a.line), '', 'Panik yok, FOMO yok. Planını hatırla: SL her zaman yerinde. 🧠', `<i>📡 Veri: ${esc(source)}</i>`].join('\n'));
        if (!opts.dryRun)
          for (const a of fresh)
            await this.prisma.sent_signal.create({ data: { kind: 'ALERT', origin: 'AUTO', symbol: a.sym, direction: a.dir, alert_key: a.key } });
      }
    } catch (e) {
      result.alertError = (e as Error).message;
      this.logger.error(`Auto alert step failed: ${(e as Error).message}`);
    }

    // ---- 2) Proactive trade card ----
    if (owner.kill_switch || owner.balance < RULES.KILL_SWITCH_THRESHOLD) {
      result.card = 'KILL_SWITCH — kart gönderilmedi';
    } else if (!opts.skipLlm) {
      const res = await this.scanner.scan({ trigger: 'AUTO', minConfidence: RULES.AUTO_CARD_MIN_CONFIDENCE });
      result.scanStatus = res.status;
      result.model = res.model;
      if (res.status === 'TRADE' && res.card) {
        const c = res.card;
        const since = new Date(Date.now() - RULES.TRADE_DEDUP_HOURS * 3600_000);
        const recent = await this.prisma.sent_signal.findMany({ where: { kind: 'TRADE', market: 'CRYPTO', symbol: c.symbol, created_at: { gte: since } } });
        const dup = recent.find((r) => r.direction === c.direction || (r.entry && Math.abs(r.entry - c.entry) / c.entry < 0.01));
        if (dup) {
          result.card = `DUPLICATE — ${c.symbol} ${c.direction} son ${RULES.TRADE_DEDUP_HOURS} saatte gönderildi, tekrar gönderilmedi`;
        } else {
          result.card = `${c.symbol} ${c.direction} conf=${c.confidence}`;
          result.cardText = opts.dryRun ? stripHtml(res.text) : undefined;
          if (!opts.dryRun && chatId != null) {
            await this.tg.send(chatId, `🤖 <b>OTOMATİK TARAMA — GÜÇLÜ FIRSAT!</b>\n\n${res.text}`);
            await this.saveMsg('assistant', `[Otomatik tarama] ${this.scanSummary(res)}`);
            await this.recordTrade(res, 'AUTO');
          }
        }
      } else {
        result.card = null;
        result.noTradeText = opts.dryRun ? stripHtml(res.text).slice(0, 600) : undefined;
        // Fırsat yoksa da tek satırlık "bekle" bildirimi (BEKLE_BILDIRIMI=kapali ile susturulur)
        if (!opts.dryRun && chatId != null && (process.env.BEKLE_BILDIRIMI || 'acik').toLowerCase() !== 'kapali') {
          const neden =
            res.status === 'ERROR'
              ? 'tarama hatası, birazdan tekrar denenecek'
              : String(res.raw?.reasoning || res.raw?.market_comment || 'net kurulum yok').replace(/\s+/g, ' ').slice(0, 220);
          await this.tg.send(chatId, `⏳ <b>Bekle</b> · ${esc(neden)}`).catch(() => undefined);
        }
      }
    }

    // ---- 3) Retention / pruning ----
    if (!opts.dryRun) await this.prune();
    return result;
  }

  // ===================== Auto stock scan (cron, US market hours) =====================
  async autoStockScan(opts: AutoScanOptions & { force?: boolean } = {}) {
    const owner = await this.scanner.getOwner();
    const chatId = owner.chat_id;
    const result: Record<string, any> = { owner: chatId != null, alerts: [], card: null, dryRun: !!opts.dryRun };
    if (chatId == null && !opts.dryRun) {
      result.note = 'Owner yok (/start bekleniyor) — tarama atlandı.';
      return result;
    }
    const session = await this.stockMarket.getSession();
    result.session = `${session.session} ${session.etTime}`;
    if (session.session !== 'OPEN' && !opts.force) {
      result.note = 'ABD piyasası açık değil — tarama atlandı (LLM çağrısı yapılmadı).';
      return result;
    }
    const send = async (html: string) => {
      if (opts.dryRun || chatId == null) return;
      await this.tg.send(chatId, html);
    };
    const et = etNow();
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // ---- 1) Sharp move alerts (once per day per symbol+direction) ----
    try {
      const [{ source, quotes }, indices] = await Promise.all([this.stockMarket.getQuotes(), this.stockMarket.getIndices()]);
      result.source = source;
      const alerts: { key: string; sym: string; dir: string; line: string }[] = [];
      const qqq = indices.find((i) => i.symbol === 'QQQ');
      if (qqq && Math.abs(qqq.changePct) >= STOCK_RULES.QQQ_ALERT_PCT) {
        const dir = qqq.changePct > 0 ? 'UP' : 'DOWN';
        alerts.push({ key: `QQQ_${day}_${dir}`, sym: 'QQQ', dir, line: `${dir === 'UP' ? '🚀' : '💥'} <b>QQQ (Nasdaq-100)</b> bugün <b>${qqq.changePct > 0 ? '+' : ''}${qqq.changePct.toFixed(2)}%</b> → ${fmtUsd(qqq.price)}` });
      }
      const movers = quotes.filter((q) => Math.abs(q.changePct) >= STOCK_RULES.STOCK_ALERT_PCT).sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 8);
      for (const q of movers) {
        const dir = q.changePct > 0 ? 'UP' : 'DOWN';
        alerts.push({ key: `${q.symbol}_${day}_${dir}`, sym: q.symbol, dir, line: `${dir === 'UP' ? '📈' : '📉'} <b>${q.symbol}</b> ${esc(q.name)} bugün <b>${q.changePct > 0 ? '+' : ''}${q.changePct.toFixed(2)}%</b> → ${fmtUsd(q.price)}` });
      }
      const since = new Date(Date.now() - 24 * 3600_000);
      const fresh: typeof alerts = [];
      for (const a of alerts) {
        const dup = await this.prisma.sent_signal.findFirst({ where: { kind: 'ALERT', market: 'STOCK', alert_key: a.key, created_at: { gte: since } } });
        if (!dup) fresh.push(a);
      }
      result.alerts = fresh.map((a) => a.key);
      result.alertsSuppressed = alerts.length - fresh.length;
      if (fresh.length) {
        await send(['🚨 <b>NASDAQ SERT HAREKET ALARMI</b>', '', ...fresh.map((a) => a.line), '', 'Kovalamak yok, panik yok. Plan + stop = disiplin. 🧠', `<i>📡 Veri: ${esc(source)} • ${et.label}</i>`].join('\n'));
        if (!opts.dryRun)
          for (const a of fresh) await this.prisma.sent_signal.create({ data: { kind: 'ALERT', market: 'STOCK', origin: 'AUTO', symbol: a.sym, direction: a.dir, alert_key: a.key } });
      }
    } catch (e) {
      result.alertError = (e as Error).message;
      this.logger.error(`Stock alert step failed: ${(e as Error).message}`);
    }

    // ---- 2) Proactive stock card ----
    if (stockKillActive(owner.stock_budget, owner.stock_kill_switch)) {
      result.card = 'HİSSE KILL SWITCH — kart gönderilmedi';
    } else if (!opts.skipLlm) {
      const res = await this.stocks.scan({ trigger: 'AUTO', minConfidence: STOCK_RULES.AUTO_CARD_MIN_CONFIDENCE });
      result.scanStatus = res.status;
      result.model = res.model;
      if (res.status === 'TRADE' && res.card) {
        const c = res.card;
        const since = new Date(Date.now() - STOCK_RULES.TRADE_DEDUP_HOURS * 3600_000);
        const dup = await this.prisma.sent_signal.findFirst({ where: { kind: 'TRADE', market: 'STOCK', symbol: c.ticker, created_at: { gte: since } } });
        if (dup) {
          result.card = `DUPLICATE — ${c.ticker} son ${STOCK_RULES.TRADE_DEDUP_HOURS} saatte gönderildi`;
        } else {
          result.card = `${c.ticker} LONG conf=${c.confidence}`;
          result.cardText = opts.dryRun ? stripHtml(res.text) : undefined;
          if (!opts.dryRun && chatId != null) {
            await this.tg.send(chatId, `🤖 <b>OTOMATİK NASDAQ TARAMASI — GÜÇLÜ FIRSAT!</b>\n\n${res.text}`);
            await this.saveMsg('assistant', `[Otomatik hisse taraması] ${this.stockSummary(res)}`);
            await this.recordStock(res, 'AUTO');
          }
        }
      } else {
        result.noTradeText = opts.dryRun ? stripHtml(res.text).slice(0, 600) : undefined;
      }
    }
    return result;
  }

  private async prune() {
    try {
      const day = 24 * 3600_000;
      await this.prisma.processed_update.deleteMany({ where: { created_at: { lt: new Date(Date.now() - 3 * day) } } });
      await this.prisma.scan_log.deleteMany({ where: { created_at: { lt: new Date(Date.now() - 30 * day) } } });
      await this.prisma.sent_signal.deleteMany({ where: { created_at: { lt: new Date(Date.now() - 60 * day) } } });
      const keep = await this.prisma.chat_message.findMany({ orderBy: { id: 'desc' }, skip: 500, take: 1, select: { id: true } });
      if (keep.length) await this.prisma.chat_message.deleteMany({ where: { id: { lte: keep[0].id } } });
    } catch (e) {
      this.logger.warn(`Prune failed: ${(e as Error).message}`);
    }
  }

  // ===================== Helpers =====================
  private async saveMsg(role: 'user' | 'assistant', content: string) {
    try {
      await this.prisma.chat_message.create({ data: { role, content: content.slice(0, 4000) } });
    } catch (e) {
      this.logger.warn(`chat_message write failed: ${(e as Error).message}`);
    }
  }

  private async reply(chatId: bigint, html: string, store = true) {
    await this.tg.send(chatId, html);
    if (store) await this.saveMsg('assistant', stripHtml(html));
  }

  private welcome(balance: number): string {
    return [
      '🚀 <b>TRADING BEYNİ AKTİF!</b>',
      '',
      `Artık senin kişisel Binance futures analistinim. Başlangıç bakiyesi: <b>${balance.toFixed(2)} USDT</b>.`,
      'Cesur ama disiplinli oynayacağız: her işlemde SL+TP, sadece ISOLATED, martingale YOK, bakiye 100 altına inerse kill switch. 🔒',
      '',
      '⚠️ Ben sadece <b>öneri</b> veririm — borsada hiçbir emir açmam. Son karar ve sorumluluk senin.',
      '',
      this.help(),
    ].join('\n');
  }

  private help(): string {
    return [
      '📖 <b>KOMUTLAR</b>',
      '• <b>tara</b> / /tara / "var mı?" / "SOL girilir mi?" → anlık tarama: 1 işlem kartı ya da "Şu an işlem yok"',
      '• 🖼 Grafik ekran görüntüsü gönder → canlı veriyle birlikte analiz',
      '• 🖼 Borsadaki pozisyon / kapanan işlem ekran görüntüsü → işlem defterine eklenir, takibe alınır',
      '• /islemler → açık pozisyonlar ve son kapananlar • /karzarar → toplam kâr/zarar',
      '• /kapat 3 12.5 → işlemi elle kapat (sayı = kâr/zarar) • /islem_sil 3 → kaydı sil',
      '• /bakiye 185 veya "bakiyem 185" → bakiyeyi güncelle',
      '• /durum → bakiye, kill switch, limitler, son tarama',
      '• /talimatlar → kalıcı talimatları listele',
      '• /talimat &lt;metin&gt; veya "bundan sonra 5x geçme" → kalıcı talimat ekle',
      '• /talimat_sil &lt;id&gt; → talimat sil',
      '• /killswitch_reset → kill switch’i aç (sadece bakiye ≥100)',
      '',
      '🏦 <b>NASDAQ HİSSE</b>',
      '• <b>hisse tara</b> / /hisse / "NVDA alınır mı?" / "AAPL girilir mi?" → 1 hisse kartı (giriş, SL, TP1/TP2, çıkış planı, adet) ya da "işlem yok"',
      '• 🖼 Hisse grafiği → açıklamaya "hisse" veya sembolü (ör. NVDA) yaz',
      '• /hisse_bakiye 500 → işlem başı hisse bütçesi • /hisse_reset → hisse kill switch',
      '',
      '• /yardim → bu liste',
      '',
      `🤖 Otomatik nöbet: kripto 30 dakikada bir (gece 00:30-08:00 hariç)${(process.env.STOCK_AUTO || '').toLowerCase() === 'acik' ? '; NASDAQ piyasa açıkken hafta içi saatlik' : ' (NASDAQ otomatik taraması kapalı, "hisse tara" ile elle)'}. Sert hareket alarmı + güven ≥${RULES.AUTO_CARD_MIN_CONFIDENCE} fırsatlarda hazır kart, aynı fırsat tekrar gönderilmez. Takipteki pozisyon TP/SL seviyesine gelince haber veririm.`,
      '💬 Bunlar dışında benimle serbestçe sohbet edebilirsin.',
    ].join('\n');
  }
}

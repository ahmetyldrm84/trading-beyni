/**
 * Kendi bilgisayarında 7/24 çalışma modu (sunucu / webhook / GitHub gerekmez).
 *
 *   node dist/src/local-runner.js
 *
 * - Telegram mesajlarını kesintisiz long-polling ile dinler ve cevaplar.
 * - Kripto otomatik nöbeti: OTO_TARAMA_DK dakikada bir (varsayılan 30), GECE_YASAGI aralığı hariç (varsayılan 00:30-08:00 TR).
 *   Fırsat varsa hazır kart, yoksa tek satır "bekle" bildirimi (BEKLE_BILDIRIMI=kapali ile susar).
 * - NASDAQ otomatik taraması: STOCK_AUTO=acik ise, hafta içi ABD seansında saatlik (varsayılan kapalı).
 *
 * Gerekli .env: TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, DATABASE_URL (varsayılan: file:./trading-beyni.db)
 */
import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { MarketService } from './market/market.service';
import { LlmService } from './llm/llm.service';
import { ScanService } from './trading/scan.service';
import { JournalService } from './trading/journal.service';
import { TelegramService } from './telegram/telegram.service';
import { BotService } from './bot/bot.service';
import { StockMarketService } from './stocks/stock-market.service';
import { StockScanService } from './stocks/stock-scan.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
  providers: [MarketService, LlmService, ScanService, JournalService, TelegramService, BotService, StockMarketService, StockScanService],
})
class LocalModule {}

const log = new Logger('LocalRunner');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let stopping = false;

async function pollForever(tg: TelegramService, bot: BotService) {
  // İnternet ya da token sorunu varsa çökmeden bekleyip tekrar dene
  for (let deneme = 1; !stopping; deneme++) {
    try {
      const info = await tg.api<{ url: string }>('getWebhookInfo');
      if (info.url) {
        log.warn('Aktif webhook bulundu — long polling için kaldırılıyor.');
        await tg.api('deleteWebhook', { drop_pending_updates: false });
      }
      break;
    } catch (e) {
      const msg = (e as Error).message;
      log.error(/401|404/.test(msg) ? 'Telegram token hatalı: .env içindeki TELEGRAM_BOT_TOKEN değerini kontrol et.' : `Telegram'a ulaşılamadı: ${msg}`);
      await sleep(Math.min(60_000, deneme * 5_000));
    }
  }
  let offset: number | undefined;
  let backoff = 2000;
  log.log('Telegram dinleniyor... (durdurmak için Ctrl+C)');
  while (!stopping) {
    try {
      const updates = await tg.api<any[]>('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'edited_message'] });
      backoff = 2000;
      for (const u of updates) {
        offset = u.update_id + 1;
        // Mesajlar sırayla işlenir; uzun bir tarama sırasında gelen mesajlar kuyrukta bekler.
        await bot.handleUpdate(u).catch((e) => log.error(`Update ${u.update_id}: ${(e as Error).message}`));
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (/409/.test(msg)) {
        log.error('Telegram 409: Aynı bot token başka bir yerde de çalışıyor (eski kripto-ajan GitHub workflow\'u?). Onu kapat.');
        await sleep(30_000);
      } else if (/401/.test(msg)) {
        log.error('Telegram 401: TELEGRAM_BOT_TOKEN hatalı. .env dosyasını kontrol et.');
        await sleep(60_000);
      } else {
        log.warn(`getUpdates hata (internet?): ${msg} — ${backoff / 1000}s sonra tekrar`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }
}

/** Şu an İstanbul saatiyle gün içi dakika (0-1439). Sunucunun saat dilimine bağlı değildir. */
function trDakika(d = new Date()): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const [h, m] = p.split(':').map(Number);
  return (h % 24) * 60 + m;
}

/** GECE_YASAGI=00:30-08:00 (TR saati). Bu aralıkta otomatik kripto taraması yapılmaz. 'kapali' = yasak yok. */
function geceYasagi(d = new Date()): boolean {
  const v = (process.env.GECE_YASAGI || '00:30-08:00').trim().toLowerCase();
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return false;
  const bas = Number(m[1]) * 60 + Number(m[2]);
  const son = Number(m[3]) * 60 + Number(m[4]);
  const t = trDakika(d);
  return bas <= son ? t >= bas && t < son : t >= bas || t < son;
}

/** Bir sonraki tetik: saat içinde `offset` dakikasından başlayıp her `every` dakikada bir. */
function msUntilNext(every: number, offset: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);
  for (let i = 0; i <= 24 * 60; i++) {
    if (next > now && (next.getMinutes() - offset + 60) % every === 0) break;
    next.setMinutes(next.getMinutes() + 1);
  }
  return next.getTime() - now.getTime();
}

let aktifIs = 0;

function schedule(name: string, every: number, offset: number, job: () => Promise<void>) {
  let running = false;
  const tick = async () => {
    if (stopping) return;
    if (running) {
      log.warn(`${name}: önceki çalışma sürüyor, bu tur atlandı`);
    } else {
      running = true;
      aktifIs++;
      try {
        await job();
      } catch (e) {
        log.error(`${name} hata: ${(e as Error).message}`);
      } finally {
        running = false;
        aktifIs--;
      }
    }
    if (!stopping) setTimeout(tick, msUntilNext(every, offset));
  };
  setTimeout(tick, msUntilNext(every, offset));
  log.log(`${name}: ${every === 1 ? 'dakikada bir' : `${every} dakikada bir`}`);
}

async function main() {
  const missing = ['TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'DATABASE_URL'].filter((n) => !process.env[n]);
  // ConfigModule .env'i Nest başlarken yükler; burada sadece erken uyarı veriyoruz
  const app = await NestFactory.createApplicationContext(LocalModule, { logger: ['log', 'warn', 'error'] });
  const stillMissing = missing.filter((n) => !process.env[n]);
  if (stillMissing.length) {
    log.error(`.env dosyasında eksik: ${stillMissing.join(', ')}`);
    await app.close();
    process.exit(1);
  }
  const bot = app.get(BotService);
  const tg = app.get(TelegramService);

  const taramaDk = [15, 20, 30, 60].includes(Number(process.env.OTO_TARAMA_DK)) ? Number(process.env.OTO_TARAMA_DK) : 30;
  schedule('Kripto nöbeti', taramaDk, 0, async () => {
    if (geceYasagi()) return;
    const r = await bot.autoScan({});
    log.log(`Kripto nöbeti: ${r.scanStatus ?? r.card ?? r.note ?? 'tamam'}${r.alerts?.length ? ` alarm=${r.alerts.length}` : ''}`);
  });
  // Açık pozisyon nöbeti: dakikada bir, gece dahil. Model çağrısı yok; açık pozisyon yoksa ağ isteği de yok.
  schedule('Pozisyon nöbeti', 1, 0, async () => {
    const n = await bot.trackPositions();
    if (n) log.log(`Pozisyon nöbeti: ${n} uyarı`);
  });
  if ((process.env.STOCK_AUTO || 'kapali').toLowerCase() === 'acik') {
    schedule('NASDAQ nöbeti', 60, 45, async () => {
      const r = await bot.autoStockScan({});
      if (!r.note) log.log(`NASDAQ nöbeti: ${r.scanStatus ?? r.card ?? 'tamam'}`);
    });
  }

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log.log('Kapatılıyor...');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // GitHub Actions gibi süre sınırlı ortamlar: MAX_CALISMA_DK dolunca düzgünce kapanır, sıradaki tur devralır.
  const maxDk = Number(process.env.MAX_CALISMA_DK) || 0;
  if (maxDk > 0) setTimeout(() => ((stopping = true), log.log('Süre doldu, tur kapanıyor...')), maxDk * 60_000).unref();

  await pollForever(tg, bot);
  for (let i = 0; aktifIs > 0 && i < 90; i++) await sleep(2000); // süren tarama bitsin
  await app.close();
  process.exit(0);
}

main().catch((e) => {
  log.error((e as Error).message);
  process.exit(1);
});

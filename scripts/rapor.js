#!/usr/bin/env node
/**
 * Analiz dışa aktarımı: botun şifreli hafızasındaki işlem defterini, gönderilen kartları ve tarama
 * kayıtlarını tek bir JSON dosyası olarak SAHİBİN Telegram sohbetine gönderir.
 * Kayıtlara (log) veri yazmaz; depo herkese açık olduğu için yalnızca "gönderildi" bilgisi görünür.
 * Sohbet mesajlarının içeriği dışa aktarılmaz.
 *
 *   DURUM_SIFRESI, TELEGRAM_BOT_TOKEN gerekir.   node scripts/rapor.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DB = path.join(os.tmpdir(), `tb-rapor-${process.pid}.db`);

async function main() {
  // Hafızayı aç (durum.js'in "yukle" komutu, ayrı bir geçici dosyaya)
  execFileSync(process.execPath, ['--no-warnings', path.join(__dirname, 'durum.js'), 'yukle'], {
    env: { ...process.env, DATABASE_URL: `file:${DB}` },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (!fs.existsSync(DB)) throw new Error('kayıtlı hafıza bulunamadı');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB, { readOnly: true });
  const all = (sql) => {
    try {
      return db.prepare(sql).all();
    } catch {
      return [];
    }
  };
  const owner = all('SELECT * FROM owner')[0] || {};
  const chatId = owner.chat_id;
  if (chatId == null) throw new Error('bot sahibi kayıtlı değil (/start yazılmamış)');
  const gizle = (o) => {
    const c = { ...o };
    for (const k of Object.keys(c)) if (/chat_id|username|token/i.test(k)) delete c[k];
    return c;
  };
  const veri = {
    olusturma: new Date().toISOString(),
    not: 'Zamanlar epoch ms (UTC). Sohbet mesajları dahil değildir.',
    sahip: gizle(owner),
    talimatlar: all('SELECT * FROM instruction').map(gizle),
    islemler: all('SELECT * FROM position ORDER BY id').map(gizle),
    kartlar: all('SELECT * FROM sent_signal ORDER BY created_at').map(gizle),
    kart_sonuclari: all('SELECT * FROM card_result ORDER BY created_at'),
    taramalar: all('SELECT * FROM scan_log ORDER BY created_at DESC LIMIT 1500').map((r) => ({
      ...r,
      summary: r.summary ? String(r.summary).slice(0, 300) : r.summary,
      error: r.error ? String(r.error).slice(0, 200) : r.error,
    })),
  };
  db.close();
  for (const ek of ['', '-wal', '-shm']) fs.rmSync(DB + ek, { force: true });
  const json = JSON.stringify(veri, (_, v) => (typeof v === 'bigint' ? Number(v) : v), 1);

  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', `📦 Analiz dışa aktarımı: ${veri.islemler.length} işlem, ${veri.kartlar.length} kart, ${veri.taramalar.length} tarama. Bu dosyayı Claude sohbetine yükle.`);
  form.append('document', new Blob([json], { type: 'application/json' }), `trading-beyni-rapor-${new Date().toISOString().slice(0, 10)}.json`);
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
  const out = await res.json().catch(() => ({}));
  if (!out.ok) throw new Error(`Telegram gönderimi başarısız: ${out.error_code || res.status} ${out.description || ''}`);
  console.log(`Rapor Telegram'a gönderildi (${veri.islemler.length} işlem, ${veri.kartlar.length} kart, ${veri.taramalar.length} tarama).`);
}

main().catch((e) => {
  console.error(`Hata: ${String(e.message).split('\n')[0]}`);
  process.exit(1);
});

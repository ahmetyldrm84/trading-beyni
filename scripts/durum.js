#!/usr/bin/env node
/**
 * Hafıza (veritabanı) saklama aracı — GitHub'da çalışırken botun hafızası şifrelenip
 * deponun "durum" dalında tek dosya olarak tutulur. Depo herkese açık olsa da içerik okunamaz.
 *
 *   node scripts/durum.js yukle            → durum dalından (yoksa ilk-hafiza.enc'den) hafızayı açar
 *   node scripts/durum.js kaydet           → değiştiyse şifreleyip durum dalına yazar
 *   node scripts/durum.js nobet            → 10 dakikada bir "kaydet"
 *   node scripts/durum.js sifrele <db> <çıktı>   → yerel veritabanını şifreler (bilgisayardan taşıma)
 *   node scripts/durum.js sifre-uret       → rastgele güçlü şifre yazar
 *
 * Şifre: DURUM_SIFRESI ortam değişkeni.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const DB = path.resolve((process.env.DATABASE_URL || 'file:./trading-beyni.db').replace(/^file:/, '').replace(/^"|"$/g, ''));
const DAL = 'durum';
const DOSYA = 'hafiza.enc';
const ILK = 'ilk-hafiza.enc';
const OZET = path.join(os.tmpdir(), 'tb-son-ozet');
const MAGIC = Buffer.from('TB1');

function sifre() {
  const s = process.env.DURUM_SIFRESI;
  if (!s || s.length < 12) {
    console.error('DURUM_SIFRESI eksik ya da çok kısa (en az 12 karakter).');
    process.exit(1);
  }
  return s;
}
function sifrele(plain) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(sifre(), salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(zlib.gzipSync(plain)), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}
function coz(buf) {
  if (!buf.subarray(0, 3).equals(MAGIC)) throw new Error('tanınmayan hafıza dosyası');
  const salt = buf.subarray(3, 19);
  const iv = buf.subarray(19, 31);
  const tag = buf.subarray(31, 47);
  const key = crypto.scryptSync(sifre(), salt, 32);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  try {
    return zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(47)), d.final()]));
  } catch {
    throw new Error('hafıza açılamadı: DURUM_SIFRESI yanlış ya da dosya bozuk');
  }
}
/** Çalışan bot açıkken bile tutarlı tek dosyalık kopya alır. */
function kopya(dbFile) {
  const { DatabaseSync } = require('node:sqlite');
  const tmp = path.join(os.tmpdir(), `tb-kopya-${process.pid}-${Date.now()}.db`);
  const db = new DatabaseSync(dbFile);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  const buf = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  return buf;
}
/** İçerik özeti: VACUUM her seferinde aynı baytları üretmeyebilir, bu yüzden satırlar üzerinden. */
function ozet(dbFile) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const h = crypto.createHash('sha256');
    const json = (rows) => JSON.stringify(rows, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    for (const t of ['owner', 'instruction', 'chat_message', 'sent_signal', 'scan_log', 'position']) {
      try {
        const r = db.prepare(`SELECT count(*) n, max(rowid) m FROM "${t}"`).get();
        h.update(`${t}:${r.n}:${r.m};`);
      } catch {
        /* eski hafızada tablo henüz yok */
      }
    }
    h.update(json(db.prepare('SELECT * FROM owner').all()));
    h.update(json(db.prepare('SELECT id, active FROM instruction').all()));
    try {
      h.update(json(db.prepare('SELECT * FROM position').all()));
    } catch {
      /* tablo yok */
    }
    return h.digest('hex');
  } finally {
    db.close();
  }
}
const git = (args, opts = {}) => execFileSync('git', args, { stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...opts });

function yukle() {
  let enc = null;
  let nereden = '';
  try {
    git(['fetch', '--quiet', '--depth', '1', 'origin', DAL]);
    enc = git(['show', `FETCH_HEAD:${DOSYA}`]);
    nereden = `${DAL} dalı`;
  } catch {
    if (fs.existsSync(ILK)) {
      enc = fs.readFileSync(ILK);
      nereden = ILK;
    }
  }
  if (!enc) {
    sifre();
    console.log('Kayıtlı hafıza yok: bot boş hafızayla başlıyor (Telegram\'da /start yaz).');
    return;
  }
  for (const ek of ['', '-wal', '-shm']) fs.rmSync(DB + ek, { force: true });
  fs.writeFileSync(DB, coz(enc));
  fs.writeFileSync(OZET, ozet(DB));
  console.log(`Hafıza yüklendi (${nereden}).`);
}

function kaydet() {
  if (!fs.existsSync(DB)) return console.log('Veritabanı yok, kaydedilecek bir şey yok.');
  const yeni = ozet(DB);
  const eski = fs.existsSync(OZET) ? fs.readFileSync(OZET, 'utf8') : '';
  if (yeni === eski) return console.log('Hafıza değişmedi.');
  const tmp = path.join(os.tmpdir(), `tb-${process.pid}.enc`);
  fs.writeFileSync(tmp, sifrele(kopya(DB)));
  const kimlik = {
    ...process.env,
    GIT_AUTHOR_NAME: 'trading-beyni',
    GIT_AUTHOR_EMAIL: 'trading-beyni@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'trading-beyni',
    GIT_COMMITTER_EMAIL: 'trading-beyni@users.noreply.github.com',
  };
  const blob = git(['hash-object', '-w', tmp]).toString().trim();
  fs.rmSync(tmp, { force: true });
  const tree = git(['mktree'], { input: `100644 blob ${blob}\t${DOSYA}\n` }).toString().trim();
  const commit = git(['commit-tree', tree, '-m', 'hafıza'], { env: kimlik }).toString().trim();
  // Tek commit'lik dal: geçmiş birikmez, depo şişmez.
  git(['push', '--quiet', '--force', 'origin', `${commit}:refs/heads/${DAL}`]);
  fs.writeFileSync(OZET, yeni);
  console.log('Hafıza kaydedildi.');
}

async function nobet() {
  const dk = Number(process.env.KAYIT_ARALIGI_DK) || 10;
  for (;;) {
    await new Promise((r) => setTimeout(r, dk * 60_000));
    try {
      kaydet();
    } catch (e) {
      console.error(`Hafıza kaydı başarısız (sonraki turda tekrar denenecek): ${e.message.split('\n')[0]}`);
    }
  }
}

const [komut, a, b] = process.argv.slice(2);
try {
  if (komut === 'yukle') yukle();
  else if (komut === 'kaydet') kaydet();
  else if (komut === 'nobet') nobet();
  else if (komut === 'sifrele') {
    fs.writeFileSync(b, sifrele(kopya(path.resolve(a))));
    console.log(`Şifrelendi: ${b}`);
  } else if (komut === 'coz') {
    fs.writeFileSync(b, coz(fs.readFileSync(a)));
    console.log(`Açıldı: ${b}`);
  } else if (komut === 'sifre-uret') process.stdout.write(crypto.randomBytes(24).toString('base64url'));
  else {
    console.error('Kullanım: node scripts/durum.js yukle | kaydet | nobet | sifrele <db> <çıktı> | coz <dosya> <db> | sifre-uret');
    process.exit(1);
  }
} catch (e) {
  console.error(`Hata: ${e.message.split('\n')[0]}`);
  process.exit(1);
}

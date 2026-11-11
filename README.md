# Trading Beyni 🧠 — Telegram kripto işlem asistanı

GitHub'da ya da kendi bilgisayarında çalışan, Telegram'dan konuştuğun kişisel **öneri** botu.
Binance USDⓈ-M Futures için işlem kartı verir. Karar modeli Claude Fable 5.1'dir ve grafik ekran görüntüsü de okur.

> ⚠️ Bot **asla emir göndermez**. İşlemi Binance'te sen açarsın. Yatırım tavsiyesi değildir.

## Değişmez kurallar (kodda zorunlu, talimatla gevşetilemez)
- Her işlemde stop-loss + take-profit. SL asla genişletilmez.
- Her zaman ISOLATED marj, kaldıraç 1x–10x.
- Margin ≤ bakiyenin %50'si, stop'ta kayıp ≤ bakiyenin %10'u.
- Martingale / zarardaki pozisyona ekleme yasak.
- Bakiye 100 USDT altına inerse KILL SWITCH: yeni kart yok.
- Emin değilse "Şu an işlem yok" der.

## İşlem defteri ve takip

Borsadaki (Binance, Gate.io) **pozisyon ya da kapanan işlem ekran görüntüsünü** bota gönder:
- Açık pozisyonsa deftere ekler ve takibe alır. Fiyat TP ya da SL seviyesine gelince haber verir (gece de).
- Kapanmış işlemse ekrandaki gerçekleşen kâr/zararı deftere yazar ve toplamı günceller. Aynı ekranı iki kez gönderirsen tekrar eklemez.
- Fiyat grafiği gönderirsen eskisi gibi grafik analizi yapar.

| Komut | Ne yapar |
|---|---|
| `/islemler` | Açık pozisyonlar (anlık kâr/zararla), son kapananlar, toplam |
| `/karzarar` | Toplam, bugün, son 7 gün, isabet oranı, ortalama kâr ve zarar |
| `/kapat 3 12.5` ya da `/kapat BTC -4.2` | İşlemi elle kapatır (sayı = kâr/zarar, USDT) |
| `/islem_sil 3` | Yanlış okunan kaydı siler |

Rakamlar ekran görüntüsünden okunur; yanlış okunan olursa `/islem_sil` ile silip `/kapat` ile düzelt. Defter, `/bakiye` değerini kendiliğinden değiştirmez.

## GitHub'da çalıştırma (bilgisayar kapalıyken de açık)

Bot, deponun **Actions** sekmesindeki "Trading Beyni" iş akışının içinde kesintisiz çalışır. Her tur yaklaşık 5,5 saat sürer, kapanırken sıradakini başlatır. "Bekçi" iş akışı yarım saatte bir bakar, bot durmuşsa yeniden başlatır.

**Gizli anahtarlar** (Settings → Secrets and variables → Actions → Secrets):

| Secret | Değer |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather'dan aldığın token |
| `ANTHROPIC_API_KEY` | Anthropic API anahtarın |
| `DURUM_SIFRESI` | Hafızayı şifreleyen parola (`hafiza-tasi.bat` üretir, `durum-sifresi.txt` içinde) |

**Hafıza:** Talimatlar, bakiye ve sohbet geçmişi şifrelenip deponun `durum` dalında tek dosya olarak saklanır. Depo herkese açıktır ama bu dosya `DURUM_SIFRESI` olmadan okunamaz. Şifreyi kaybedersen hafıza açılamaz; bot sıfırdan başlar.

**Bilgisayardaki hafızayı taşımak:** Bilgisayardaki botu kapat, `hafiza-tasi.bat` dosyasını çalıştır. Oluşan `ilk-hafiza.enc` dosyasını depoya yükle. Bot ilk açılışta bunu kullanır.

**İsteğe bağlı ayarlar** (aynı sayfada Variables sekmesi):

| Variable | Varsayılan | Anlamı |
|---|---|---|
| `OTO_TARAMA_DK` | `30` | Otomatik tarama aralığı: 15, 20, 30 ya da 60 dakika |
| `GECE_YASAGI` | `00:30-08:00` | Bu saatlerde (TR) otomatik tarama yok. Kapatmak için `kapali` |
| `BEKLE_BILDIRIMI` | `acik` | Fırsat yokken tek satır "bekle" mesajı. Susturmak için `kapali` |
| `OTO_MIN_GUVEN` | `6` | Otomatik kart eşiği (6-10) |
| `STOCK_AUTO` | `kapali` | NASDAQ otomatik taraması |

Ayar değiştirince yeni turda geçerli olur. Hemen geçsin istersen Actions → Trading Beyni → çalışan turu **Cancel**, sonra **Run workflow**.

**Durdurmak:** Actions → hem "Trading Beyni" hem "Bekçi" için **⋯ → Disable workflow**, ardından çalışan turu **Cancel**.

**Bilmen gerekenler:**
- Aynı bot aynı anda tek yerde çalışabilir. GitHub'daki açıkken bilgisayardaki `baslat.bat`'ı açma.
- Turlar arasında 1-2 dakikalık geçiş olur; o sırada yazdığın mesaj kaybolmaz, yeni tur açılınca cevaplanır.
- GitHub sunucuları ABD'de olduğu için Binance verisi oradan gelmeyebilir; bot o zaman Gate.io / OKX fiyatlarına geçer ve kartın altında kaynağı yazar.
- GitHub, Actions'ı sürekli çalışan bot barındırmak için tasarlamadı; bu kullanımı kısıtlarsa `bot.yml` yerine 5 dakikada bir çalışan düzene geçmek gerekir.
- Actions kayıtları herkese açıktır. Kayıtlara mesaj içeriği, sohbet kimliği ya da anahtar yazılmaz.

## Bilgisayarda kurulum (bir kerelik, ~10 dakika)

### 1) Node.js kur
[nodejs.org](https://nodejs.org) → **LTS** sürümünü indir ve kur. En az 22.13 olmalı, 24 önerilir.

### 2) Klasörü aç
Bu zip'i bir klasöre çıkar, örneğin `Belgeler\trading-beyni`.

### 3) Ayar dosyasını hazırla
Klasördeki `.env.example` dosyasının bir kopyasını oluştur, adını **`.env`** yap ve Not Defteri ile aç:

| Ayar | Ne yazacaksın |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather'dan aldığın **yeni** token (`/revoke` sonrası) |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |

Bu dosya sadece senin bilgisayarında durur. Kimseyle paylaşma, sohbete yapıştırma.

### 4) Eski kripto botunu kapat
Aynı Telegram botunu iki program aynı anda dinleyemez.
GitHub → **kripto-ajan** deposu → **Actions** → "Kripto Ajan" iş akışı → sağ üstteki **⋯ → Disable workflow**.

### 5) Başlat
- **Windows:** `baslat.bat` dosyasına çift tıkla.
- **Mac:** `baslat.command` dosyasına sağ tık → **Aç**.

Paket hazır derlenmiş gelir, kurulum beklemez. Pencerede `Telegram dinleniyor...` yazısını görürsün.
Bot kapanırsa script onu 15 saniye içinde yeniden başlatır.

### 6) Telegram'da tanış
Bota **/start** yaz. İlk yazan kişi sahibi olarak kaydedilir; bot başkalarına cevap vermez.
Sonra **/bakiye 200** yaz.

## Kullanım
| Yaz | Ne olur |
|---|---|
| `tara`, `var mı?`, `SOL girilir mi?` | Top 50 coin taranır, tek işlem kartı ya da "Şu an işlem yok" |
| 🖼 Binance grafik ekran görüntüsü | Görsel + canlı veriyle analiz |
| `bundan sonra kaldıracı 5x geçme` | Kalıcı talimat olarak kaydedilir, her kararda kodla uygulanır |
| `/talimatlar`, `/talimat_sil 3` | Talimatları gör / sil |
| `/bakiye 185` | Bakiyeyi güncelle (kill switch buna göre çalışır) |
| `/durum` | Bakiye, limitler, son tarama |
| `/killswitch_reset` | Kill switch'i kapat (sadece bakiye ≥100 ise) |
| `hisse tara`, `NVDA alınır mı?` | NASDAQ-100 hisse kartı (kaldıraçsız, sadece LONG) |
| Diğer her şey | Serbest sohbet |

**Otomatik nöbet:** 30 dakikada bir kendiliğinden tarar (00:30-08:00 arası hariç). BTC/ETH/SOL'de sert hareket varsa alarm,
fırsat (güven ≥6) varsa hazır kart, yoksa tek satır "bekle" bildirimi gönderir. Aynı fırsatı 8 saat içinde tekrar göndermez.
NASDAQ otomatik taraması varsayılan olarak kapalı; açmak için `.env` içinde `STOCK_AUTO=acik`.

## USB diskten çalıştırma (istediğin Windows PC'de)
Bot taşınabilir: veritabanı, ayarlar ve kod aynı klasörde, kurulumsuz Node ile çalışabilir.
1. Klasörü USB diske kopyala.
2. [nodejs.org/en/download](https://nodejs.org/en/download) → **Windows Binary (.zip)** (x64) indir.
   Zip'in içindeki klasörü USB'deki `trading-beyni` klasörünün içine çıkar ve adını **`node`** yap
   (`trading-beyni\node\node.exe` olmalı).
3. `baslat.bat`'a çift tıkla. Paket hazır derlenmiş gelir; `npm install` gerekmez, her PC'de doğrudan açılır.

Dikkat:
- **Aynı anda tek PC.** Bot iki bilgisayarda birden açık olursa Telegram mesajları karışır (pencerede "409" uyarısı görürsün).
- **Bot çalışırken USB'yi çıkarma**, önce pencereyi kapat. Aksi halde veritabanı dosyası bozulabilir.
- **USB kaybolursa** içindeki `.env` dosyasında token ve API anahtarın var: hemen @BotFather'dan `/revoke` yap ve Anthropic anahtarını sil.
- İş ya da ortak bilgisayarlarda çalıştırmadan önce o bilgisayarın kurallarına bak; bazı kurumlar USB'den program çalıştırmayı engeller.

## Bilmen gerekenler
- **Bilgisayar açık olmalı.** Bilgisayar uykuya geçerse ya da kapanırsa bot da durur.
  Windows'ta: Ayarlar → Sistem → Güç → "Uyku" süresini **Hiçbir zaman** yap (prize takılıyken).
- **Veri:** Binance Futures. Binance'e ulaşılamazsa sırayla Gate.io, Bybit, OKX, CoinGecko'ya geçer.
- **Veritabanı:** Talimatlar ve sohbet geçmişi klasördeki `trading-beyni.db` dosyasında tutulur. Silersen hafıza sıfırlanır.
- **Maliyet:** Her tarama bir Claude API çağrısıdır: 30 dakikalık nöbet günde ~33 çağrı, artı senin taramaların.

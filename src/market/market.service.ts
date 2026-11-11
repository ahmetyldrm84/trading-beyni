import { Injectable, Logger } from '@nestjs/common';

export interface Ticker {
  symbol: string; // base coin, e.g. BTC
  price: number;
  change24h: number; // %
  quoteVolume: number; // USDT
  high24h?: number;
  low24h?: number;
  funding?: number;
}

export interface Kline {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface CoinFeatures {
  symbol: string;
  price: number;
  chg1h: number;
  chg4h: number;
  chg24h: number;
  rsi14_1h: number | null;
  ema20_1h: number | null;
  ema50_1h: number | null;
  high24h: number;
  low24h: number;
  atr14_1h_pct: number | null;
  last12_closes_1h: number[];
}

export interface MarketSnapshot {
  source: string;
  fetchedAt: string;
  majors: Ticker[];
  top50: Ticker[];
  fearGreed: { value: number; label: string } | null;
  klineSource: string | null;
  features: CoinFeatures[];
  errors: string[];
}

type Source = 'Binance Futures' | 'Gate.io Futures' | 'Bybit Linear' | 'OKX Swap' | 'CoinGecko';
const ORDER: Source[] = ['Binance Futures', 'Gate.io Futures', 'Bybit Linear', 'OKX Swap', 'CoinGecko'];
const KLINE_SOURCES: Source[] = ['Binance Futures', 'Gate.io Futures', 'Bybit Linear', 'OKX Swap'];
const CACHE_MS = 60_000;
// Non-crypto (tradfi) perps that some venues list — safety net in addition to venue metadata
const TRADFI = new Set(['XAU', 'XAG', 'XAUT', 'PAXG', 'XPT', 'XPD', 'XCU', 'XAL', 'CL', 'BZ', 'NG', 'SPX', 'NDX', 'TSLA', 'NVDA', 'AAPL', 'MSTR', 'COIN', 'HOOD', 'SOXL', 'QQQ', 'SPY', 'EURUSD', 'GBPUSD', 'USDJPY', 'IAU', 'SLV']);
const STABLES = new Set(['USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDE', 'USDP', 'USD1', 'XUSD']);

async function getJson(url: string, timeoutMs = 8000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'trading-beyni/1.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export interface BinanceFilters {
  symbol: string; // e.g. SOLUSDT
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

const BINANCE_HOSTS = ['https://www.binance.com', 'https://fapi.binance.com'];
/** fapi.binance.com returns 451 from some regions; www.binance.com/fapi proxies the same public API. */
async function binanceJson(path: string, timeoutMs = 8000): Promise<any> {
  let last: Error | null = null;
  for (const h of BINANCE_HOSTS) {
    try {
      return await getJson(`${h}${path}`, timeoutMs);
    } catch (e) {
      last = e as Error;
    }
  }
  throw last ?? new Error('binance unreachable');
}

const f = (x: any) => {
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : 0;
};

@Injectable()
export class MarketService {
  private readonly logger = new Logger(MarketService.name);
  private cache = new Map<string, { at: number; data: any }>();

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const c = this.cache.get(key);
    if (c && Date.now() - c.at < CACHE_MS) return c.data as T;
    const data = await fn();
    this.cache.set(key, { at: Date.now(), data });
    return data;
  }

  private meta = new Map<string, { at: number; set: Set<string> | null }>();
  private async metaSet(key: string, fn: () => Promise<Set<string>>): Promise<Set<string> | null> {
    const c = this.meta.get(key);
    if (c && Date.now() - c.at < 3600_000) return c.set;
    let set: Set<string> | null = null;
    try {
      set = await fn();
    } catch (e) {
      this.logger.warn(`${key} metadata failed: ${(e as Error).message}`);
    }
    this.meta.set(key, { at: Date.now(), set });
    return set;
  }
  /** Gate.io lists stocks/metals/indices as USDT perps; keep only crypto (contract_type === ''). */
  private gateCryptoContracts() {
    return this.metaSet('gate', async () => {
      const d = await getJson('https://api.gateio.ws/api/v4/futures/usdt/contracts', 10000);
      return new Set((d as any[]).filter((x) => !x.contract_type && !x.in_delisting).map((x) => x.name));
    });
  }
  private binanceInfo: { at: number; map: Map<string, BinanceFilters> | null } | null = null;
  /** Binance USDⓈ-M perpetual crypto symbols with order filters (cached 1h). */
  async getBinanceFilterMap(): Promise<Map<string, BinanceFilters> | null> {
    if (this.binanceInfo && Date.now() - this.binanceInfo.at < 3600_000 && this.binanceInfo.map) return this.binanceInfo.map;
    let map: Map<string, BinanceFilters> | null = null;
    try {
      const d = await binanceJson('/fapi/v1/exchangeInfo', 15000);
      map = new Map();
      for (const x of d.symbols as any[]) {
        if (x.contractType !== 'PERPETUAL' || x.status !== 'TRADING' || x.quoteAsset !== 'USDT') continue;
        if (x.underlyingType && x.underlyingType !== 'COIN') continue;
        const fl = (t: string) => (x.filters as any[]).find((y) => y.filterType === t) || {};
        map.set(x.symbol, {
          symbol: x.symbol,
          tickSize: f(fl('PRICE_FILTER').tickSize),
          stepSize: f(fl('LOT_SIZE').stepSize),
          minQty: f(fl('LOT_SIZE').minQty),
          minNotional: f(fl('MIN_NOTIONAL').notional) || 5,
        });
      }
      this.logger.log(`Binance exchangeInfo: ${map.size} perpetual symbols`);
    } catch (e) {
      this.logger.warn(`Binance exchangeInfo failed: ${(e as Error).message}`);
    }
    this.binanceInfo = { at: Date.now(), map };
    return map;
  }
  /** Filters for a base coin (SOL -> SOLUSDT). undefined = not listed, null = Binance unreachable. */
  async getBinanceFilters(coin: string): Promise<BinanceFilters | null | undefined> {
    const map = await this.getBinanceFilterMap();
    if (!map) return null;
    return map.get(`${coin}USDT`);
  }
  private async binanceCryptoSymbols(): Promise<Set<string> | null> {
    const map = await this.getBinanceFilterMap();
    return map ? new Set(map.keys()) : null;
  }

  // ---------- Tickers ----------
  private async tickersFrom(src: Source): Promise<Ticker[]> {
    switch (src) {
      case 'Binance Futures': {
        const [d, crypto, prem] = await Promise.all([
          binanceJson('/fapi/v1/ticker/24hr'),
          this.binanceCryptoSymbols(),
          binanceJson('/fapi/v1/premiumIndex').catch(() => []),
        ]);
        const funding = new Map<string, number>((prem as any[]).map((p) => [p.symbol, f(p.lastFundingRate)]));
        return (d as any[])
          .filter((x) => x.symbol.endsWith('USDT') && (!crypto || crypto.has(x.symbol)))
          .map((x) => ({
            symbol: x.symbol.replace(/USDT$/, ''),
            price: f(x.lastPrice),
            change24h: f(x.priceChangePercent),
            quoteVolume: f(x.quoteVolume),
            high24h: f(x.highPrice),
            low24h: f(x.lowPrice),
            funding: funding.get(x.symbol),
          }));
      }
      case 'Gate.io Futures': {
        const [d, crypto] = await Promise.all([
          getJson('https://api.gateio.ws/api/v4/futures/usdt/tickers'),
          this.gateCryptoContracts(),
        ]);
        return (d as any[])
          .filter((x) => String(x.contract).endsWith('_USDT') && (!crypto || crypto.has(x.contract)))
          .map((x) => ({
            symbol: x.contract.replace(/_USDT$/, ''),
            price: f(x.last),
            change24h: f(x.change_percentage),
            quoteVolume: f(x.volume_24h_quote),
            high24h: f(x.high_24h),
            low24h: f(x.low_24h),
            funding: f(x.funding_rate),
          }));
      }
      case 'Bybit Linear': {
        const d = await getJson('https://api.bybit.com/v5/market/tickers?category=linear');
        return (d.result.list as any[])
          .filter((x) => x.symbol.endsWith('USDT'))
          .map((x) => ({
            symbol: x.symbol.replace(/USDT$/, ''),
            price: f(x.lastPrice),
            change24h: f(x.price24hPcnt) * 100,
            quoteVolume: f(x.turnover24h),
            high24h: f(x.highPrice24h),
            low24h: f(x.lowPrice24h),
            funding: f(x.fundingRate),
          }));
      }
      case 'OKX Swap': {
        const d = await getJson('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
        return (d.data as any[])
          .filter((x) => String(x.instId).endsWith('-USDT-SWAP'))
          .map((x) => {
            const last = f(x.last);
            const open = f(x.open24h);
            return {
              symbol: x.instId.replace(/-USDT-SWAP$/, ''),
              price: last,
              change24h: open ? ((last - open) / open) * 100 : 0,
              quoteVolume: f(x.volCcy24h) * last,
              high24h: f(x.high24h),
              low24h: f(x.low24h),
            };
          });
      }
      case 'CoinGecko': {
        const d = await getJson(
          'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=80&page=1&price_change_percentage=24h',
        );
        return (d as any[]).map((x) => ({
          symbol: String(x.symbol).toUpperCase(),
          price: f(x.current_price),
          change24h: f(x.price_change_percentage_24h),
          quoteVolume: f(x.total_volume),
          high24h: f(x.high_24h),
          low24h: f(x.low_24h),
        }));
      }
    }
  }

  private lastTickerSource: (typeof ORDER)[number] | null = null;

  /** fresh=true önbelleği atlar (dakikalık pozisyon nöbeti için). Son çalışan kaynak önce denenir. */
  async getTickers(fresh = false): Promise<{ source: string; tickers: Ticker[]; errors: string[] }> {
    if (fresh) this.cache.delete('tickers');
    return this.cached('tickers', async () => {
      const errors: string[] = [];
      const sira = this.lastTickerSource ? [this.lastTickerSource, ...ORDER.filter((x) => x !== this.lastTickerSource)] : ORDER;
      for (const src of sira) {
        try {
          const all = (await this.tickersFrom(src)).filter(
            (t) => t.price > 0 && !STABLES.has(t.symbol) && !TRADFI.has(t.symbol) && /^[A-Z0-9]+$/.test(t.symbol),
          );
          if (all.length < 10) throw new Error(`only ${all.length} tickers`);
          all.sort((a, b) => b.quoteVolume - a.quoteVolume);
          if (this.lastTickerSource !== src) this.logger.log(`Tickers from ${src} (${all.length})`);
          this.lastTickerSource = src;
          return { source: src, tickers: all, errors };
        } catch (e) {
          const msg = `${src}: ${(e as Error).message}`;
          this.logger.warn(`Ticker source failed -> ${msg}`);
          errors.push(msg);
        }
      }
      throw new Error(`Tüm piyasa veri kaynakları başarısız: ${errors.join(' | ')}`);
    });
  }

  // ---------- Klines (1h) ----------
  private async klinesFrom(src: Source, sym: string, limit: number): Promise<Kline[]> {
    switch (src) {
      case 'Binance Futures': {
        const d = await binanceJson(`/fapi/v1/klines?symbol=${sym}USDT&interval=1h&limit=${limit}`);
        return (d as any[]).map((k) => ({ t: k[0], o: f(k[1]), h: f(k[2]), l: f(k[3]), c: f(k[4]) }));
      }
      case 'Gate.io Futures': {
        const d = await getJson(
          `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${sym}_USDT&interval=1h&limit=${limit}`,
        );
        return (d as any[]).map((k) => ({ t: k.t * 1000, o: f(k.o), h: f(k.h), l: f(k.l), c: f(k.c) }));
      }
      case 'Bybit Linear': {
        const d = await getJson(
          `https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}USDT&interval=60&limit=${limit}`,
        );
        return (d.result.list as any[])
          .map((k) => ({ t: +k[0], o: f(k[1]), h: f(k[2]), l: f(k[3]), c: f(k[4]) }))
          .reverse();
      }
      case 'OKX Swap': {
        const d = await getJson(
          `https://www.okx.com/api/v5/market/candles?instId=${sym}-USDT-SWAP&bar=1H&limit=${Math.min(limit, 300)}`,
        );
        return (d.data as any[])
          .map((k) => ({ t: +k[0], o: f(k[1]), h: f(k[2]), l: f(k[3]), c: f(k[4]) }))
          .reverse();
      }
      default:
        throw new Error('klines unsupported');
    }
  }

  async getKlines(sym: string, preferred?: string, limit = 100): Promise<{ source: string; klines: Kline[] } | null> {
    return this.cached(`kl:${sym}:${limit}`, async () => {
      const order = [...KLINE_SOURCES].sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));
      for (const src of order) {
        try {
          const k = await this.klinesFrom(src, sym, limit);
          if (k.length >= 20) return { source: src, klines: k };
        } catch {
          /* try next */
        }
      }
      return null;
    });
  }

  async getFearGreed(): Promise<{ value: number; label: string } | null> {
    return this.cached('fng', async () => {
      try {
        const d = await getJson('https://api.alternative.me/fng/?limit=1');
        return { value: f(d.data[0].value), label: d.data[0].value_classification };
      } catch (e) {
        this.logger.warn(`Fear&Greed failed: ${(e as Error).message}`);
        return null;
      }
    });
  }

  static features(sym: string, k: Kline[], t?: Ticker): CoinFeatures {
    const closes = k.map((x) => x.c);
    const last = closes[closes.length - 1];
    const pct = (a: number, b: number) => (b ? +(((a - b) / b) * 100).toFixed(2) : 0);
    const ema = (p: number) => {
      if (closes.length < p) return null;
      const m = 2 / (p + 1);
      let e = closes.slice(0, p).reduce((s, x) => s + x, 0) / p;
      for (let i = p; i < closes.length; i++) e = closes[i] * m + e * (1 - m);
      return +e.toPrecision(6);
    };
    let rsi: number | null = null;
    if (closes.length > 15) {
      let g = 0,
        l = 0;
      for (let i = 1; i <= 14; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) g += d;
        else l -= d;
      }
      g /= 14;
      l /= 14;
      for (let i = 15; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        g = (g * 13 + Math.max(d, 0)) / 14;
        l = (l * 13 + Math.max(-d, 0)) / 14;
      }
      rsi = l === 0 ? 100 : +(100 - 100 / (1 + g / l)).toFixed(1);
    }
    let atr: number | null = null;
    if (k.length > 15) {
      const trs = k.slice(-14).map((x, i, arr) => {
        const prev = i === 0 ? k[k.length - 15].c : arr[i - 1].c;
        return Math.max(x.h - x.l, Math.abs(x.h - prev), Math.abs(x.l - prev));
      });
      atr = +((trs.reduce((s, x) => s + x, 0) / 14 / last) * 100).toFixed(2);
    }
    const last24 = k.slice(-24);
    return {
      symbol: sym,
      price: t?.price ?? last,
      chg1h: pct(last, closes[closes.length - 2]),
      chg4h: pct(last, closes[closes.length - 5]),
      chg24h: t?.change24h != null ? +t.change24h.toFixed(2) : pct(last, closes[closes.length - 25]),
      rsi14_1h: rsi,
      ema20_1h: ema(20),
      ema50_1h: ema(50),
      high24h: Math.max(...last24.map((x) => x.h)),
      low24h: Math.min(...last24.map((x) => x.l)),
      atr14_1h_pct: atr,
      last12_closes_1h: closes.slice(-12).map((x) => +x.toPrecision(6)),
    };
  }

  /** Full snapshot for the decision model. `extra` = additional coins to include klines for. */
  async getSnapshot(extra: string[] = []): Promise<MarketSnapshot> {
    const [{ source, tickers, errors }, fearGreed] = await Promise.all([this.getTickers(), this.getFearGreed()]);
    const top50 = tickers.slice(0, 50).map((t) => ({
      symbol: t.symbol,
      price: +t.price.toPrecision(6),
      change24h: +t.change24h.toFixed(2),
      quoteVolume: Math.round(t.quoteVolume),
      high24h: t.high24h,
      low24h: t.low24h,
      funding: t.funding,
    }));
    const bySym = new Map(tickers.map((t) => [t.symbol, t]));
    const majors = ['BTC', 'ETH', 'SOL'].map((s) => bySym.get(s)).filter(Boolean) as Ticker[];

    // candidates: majors + extra + top movers by |24h change| among top50
    const movers = [...top50]
      .filter((t) => !['BTC', 'ETH', 'SOL'].includes(t.symbol))
      .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))
      .slice(0, 7)
      .map((t) => t.symbol);
    const cands = Array.from(new Set(['BTC', 'ETH', 'SOL', ...extra.map((e) => e.toUpperCase()).filter((e) => bySym.has(e)), ...movers])).slice(0, 12);
    let klineSource: string | null = null;
    const results = await Promise.all(
      cands.map(async (s) => {
        const r = await this.getKlines(s, source);
        if (!r) return null;
        klineSource = klineSource ?? r.source;
        return MarketService.features(s, r.klines, bySym.get(s));
      }),
    );
    return {
      source,
      fetchedAt: new Date().toISOString(),
      majors,
      top50,
      fearGreed,
      klineSource,
      features: results.filter(Boolean) as CoinFeatures[],
      errors,
    };
  }
}

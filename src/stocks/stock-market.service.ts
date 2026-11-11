import { Injectable, Logger } from '@nestjs/common';

export interface StockQuote {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
  marketCapB?: number;
}
export interface DailyBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
export interface StockFeatures {
  symbol: string;
  price: number;
  chg1d: number;
  chg5d: number;
  chg20d: number;
  sma20: number | null;
  sma50: number | null;
  rsi14: number | null;
  atr14_pct: number | null;
  vol_ratio_20d: number | null;
  high20: number;
  low20: number;
  high_6m: number;
  low_6m: number;
  last10_closes: number[];
}
export interface MarketSession {
  session: 'PRE' | 'OPEN' | 'POST' | 'CLOSED';
  labelTr: string;
  etTime: string;
  isTradingDay: boolean;
}
export interface IndexCtx {
  symbol: string;
  price: number;
  changePct: number;
}
export interface StockSnapshot {
  source: string;
  klineSource: string | null;
  fetchedAt: string;
  session: MarketSession;
  indices: IndexCtx[];
  quotes: StockQuote[];
  features: StockFeatures[];
  errors: string[];
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const CACHE_MS = 90_000;

// Fallback NASDAQ-100 universe if the Nasdaq list endpoint is unavailable
export const NDX_FALLBACK = (
  'AAPL MSFT NVDA AMZN GOOGL GOOG META AVGO TSLA COST NFLX AMD PEP ADBE CSCO TMUS INTC QCOM TXN AMGN INTU ISRG AMAT HON BKNG CMCSA VRTX PANW ADP MU LRCX ADI GILD SBUX MELI KLAC REGN MDLZ CRWD PYPL SNPS CDNS ABNB MAR ASML CTAS ORLY CSX FTNT PDD MRVL WDAY ROP NXPI ADSK CHTR DASH TTD PCAR MNST CPRT AEP PAYX ROST KDP FAST ODFL EA AZN BKR CTSH VRSK EXC XEL KHC GEHC IDXX CCEP FANG LULU TEAM DDOG CSGP ZS ON BIIB CDW GFS TTWO DXCM MDB WBD ARM PLTR APP MSTR AXON SHOP LIN'
).split(' ');

async function fetchJson(url: string, timeoutMs = 10000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}
const num = (s: any) => {
  const x = parseFloat(String(s ?? '').replace(/[$,%+\s]/g, ''));
  return Number.isFinite(x) ? x : 0;
};
const p2 = (x: number) => +x.toFixed(2);

export function etNow(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const hour = parseInt(get('hour'), 10) % 24;
  const minute = parseInt(get('minute'), 10);
  return { weekday: get('weekday'), hour, minute, mins: hour * 60 + minute, label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ET` };
}

@Injectable()
export class StockMarketService {
  private readonly logger = new Logger(StockMarketService.name);
  private cache = new Map<string, { at: number; data: any }>();

  private async cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
    const c = this.cache.get(key);
    if (c && Date.now() - c.at < ttl) return c.data as T;
    const data = await fn();
    this.cache.set(key, { at: Date.now(), data });
    return data;
  }

  /** US market session (local calc + Nasdaq market-info for holidays). */
  async getSession(): Promise<MarketSession> {
    const et = etNow();
    const weekend = et.weekday === 'Sat' || et.weekday === 'Sun';
    let session: MarketSession['session'] = 'CLOSED';
    if (!weekend) {
      if (et.mins >= 240 && et.mins < 570) session = 'PRE';
      else if (et.mins >= 570 && et.mins < 960) session = 'OPEN';
      else if (et.mins >= 960 && et.mins < 1200) session = 'POST';
    }
    let holiday = false;
    if (!weekend && session === 'OPEN') {
      try {
        const d = await this.cached('mkinfo', 10 * 60_000, () => fetchJson('https://api.nasdaq.com/api/market-info', 6000));
        const ind = String(d?.data?.marketIndicator || d?.data?.uiMarketIndicator || '');
        if (/closed/i.test(ind)) {
          holiday = true;
          session = 'CLOSED';
        }
      } catch (e) {
        this.logger.warn(`market-info failed: ${(e as Error).message}`);
      }
    }
    const labelTr = { PRE: 'Piyasa öncesi (pre-market)', OPEN: 'Piyasa AÇIK', POST: 'Piyasa sonrası (after-hours)', CLOSED: holiday ? 'Piyasa KAPALI (tatil)' : 'Piyasa KAPALI' }[session];
    return { session, labelTr, etTime: et.label, isTradingDay: !weekend && !holiday };
  }

  /** NASDAQ-100 quotes: Nasdaq.com → Yahoo spark fallback. */
  async getQuotes(): Promise<{ source: string; quotes: StockQuote[]; errors: string[] }> {
    return this.cached('quotes', CACHE_MS, async () => {
      const errors: string[] = [];
      try {
        const d = await fetchJson('https://api.nasdaq.com/api/quote/list-type/nasdaq100');
        const rows: any[] = d?.data?.data?.rows || [];
        const quotes = rows
          .map((r) => ({
            symbol: String(r.symbol).toUpperCase(),
            name: String(r.companyName || '').replace(/\s+(Common Stock|Class [A-C].*|Ordinary Shares.*|American Depositary.*)$/i, '').trim(),
            price: num(r.lastSalePrice),
            changePct: num(r.percentageChange),
            marketCapB: p2(num(r.marketCap) / 1e9),
          }))
          .filter((q) => q.price > 0);
        if (quotes.length < 50) throw new Error(`only ${quotes.length} rows`);
        return { source: 'Nasdaq.com', quotes, errors };
      } catch (e) {
        errors.push(`Nasdaq.com: ${(e as Error).message}`);
        this.logger.warn(`Nasdaq list failed: ${(e as Error).message} → Yahoo fallback`);
      }
      const quotes: StockQuote[] = [];
      for (let i = 0; i < NDX_FALLBACK.length; i += 20) {
        const chunk = NDX_FALLBACK.slice(i, i + 20);
        try {
          const d = await this.spark(chunk);
          quotes.push(...d.map((x) => ({ symbol: x.symbol, name: x.symbol, price: x.price, changePct: x.changePct })));
        } catch (e) {
          errors.push(`Yahoo spark: ${(e as Error).message}`);
        }
      }
      if (!quotes.length) throw new Error(`Hisse verisi alınamadı (${errors.join(' | ')})`);
      return { source: 'Yahoo Finance', quotes, errors };
    });
  }

  private async spark(symbols: string[]): Promise<IndexCtx[]> {
    const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${symbols.map(encodeURIComponent).join(',')}&range=1d&interval=5m`;
    const d = await fetchJson(url);
    return symbols
      .map((s) => {
        const x = d?.[s];
        if (!x) return null;
        const closes: number[] = (x.close || []).filter((c: any) => typeof c === 'number');
        const price = closes.length ? closes[closes.length - 1] : 0;
        const prev = x.chartPreviousClose || x.previousClose || 0;
        return { symbol: s, price: p2(price), changePct: prev ? p2(((price - prev) / prev) * 100) : 0 };
      })
      .filter((x): x is IndexCtx => !!x && x.price > 0);
  }

  async getIndices(): Promise<IndexCtx[]> {
    return this.cached('indices', CACHE_MS, async () => {
      try {
        return await this.spark(['QQQ', 'SPY', '^NDX', '^VIX']);
      } catch (e) {
        this.logger.warn(`Index spark failed: ${(e as Error).message}`);
        return [];
      }
    });
  }

  /** ~6 months daily bars: Yahoo chart → Nasdaq historical fallback. */
  async getDaily(sym: string): Promise<{ source: string; bars: DailyBar[] } | null> {
    return this.cached(`daily:${sym}`, 5 * 60_000, async () => {
      try {
        const d = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=6mo&interval=1d`);
        const r = d?.chart?.result?.[0];
        const q = r?.indicators?.quote?.[0];
        const ts: number[] = r?.timestamp || [];
        const bars = ts
          .map((t, i) => ({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] ?? 0 }))
          .filter((b) => [b.o, b.h, b.l, b.c].every((x) => typeof x === 'number'));
        if (bars.length < 30) throw new Error(`only ${bars.length} bars`);
        return { source: 'Yahoo Finance', bars };
      } catch (e) {
        this.logger.warn(`Yahoo daily ${sym} failed: ${(e as Error).message}`);
      }
      try {
        const from = new Date(Date.now() - 200 * 86400_000).toISOString().slice(0, 10);
        const d = await fetchJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/historical?assetclass=stocks&fromdate=${from}&limit=200`);
        const rows: any[] = d?.data?.tradesTable?.rows || [];
        const bars = rows
          .map((r) => ({ t: new Date(r.date).getTime(), o: num(r.open), h: num(r.high), l: num(r.low), c: num(r.close), v: num(r.volume) }))
          .filter((b) => b.c > 0)
          .sort((a, b) => a.t - b.t);
        if (bars.length < 30) throw new Error(`only ${bars.length} bars`);
        return { source: 'Nasdaq.com', bars };
      } catch (e) {
        this.logger.warn(`Nasdaq daily ${sym} failed: ${(e as Error).message}`);
        return null;
      }
    });
  }

  /** Best-effort upcoming earnings date text (Nasdaq.com). */
  async getEarningsNote(sym: string): Promise<{ date: Date | null; text: string } | null> {
    try {
      const d = await fetchJson(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(sym)}/earnings-date`, 6000);
      const text = String(d?.data?.reportText || '');
      const m = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      const date = m ? new Date(`${m[3]}-${m[1]}-${m[2]}T12:00:00Z`) : null;
      return { date, text };
    } catch {
      return null;
    }
  }

  static features(sym: string, bars: DailyBar[], livePrice?: number): StockFeatures {
    const closes = bars.map((b) => b.c);
    if (livePrice && livePrice > 0) closes[closes.length - 1] = livePrice;
    const last = closes[closes.length - 1];
    const pct = (a: number, b?: number) => (b ? p2(((a - b) / b) * 100) : 0);
    const sma = (p: number) => (closes.length >= p ? p2(closes.slice(-p).reduce((s, x) => s + x, 0) / p) : null);
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
    if (bars.length > 15) {
      const trs = bars.slice(-14).map((b, i) => {
        const prev = bars[bars.length - 15 + i].c;
        return Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev));
      });
      atr = p2((trs.reduce((s, x) => s + x, 0) / 14 / last) * 100);
    }
    const vols = bars.map((b) => b.v);
    const avgVol = vols.length > 21 ? vols.slice(-21, -1).reduce((s, x) => s + x, 0) / 20 : 0;
    const last20 = bars.slice(-20);
    return {
      symbol: sym,
      price: p2(last),
      chg1d: pct(last, closes[closes.length - 2]),
      chg5d: pct(last, closes[closes.length - 6]),
      chg20d: pct(last, closes[closes.length - 21]),
      sma20: sma(20),
      sma50: sma(50),
      rsi14: rsi,
      atr14_pct: atr,
      vol_ratio_20d: avgVol ? p2(vols[vols.length - 1] / avgVol) : null,
      high20: p2(Math.max(...last20.map((b) => b.h))),
      low20: p2(Math.min(...last20.map((b) => b.l))),
      high_6m: p2(Math.max(...bars.map((b) => b.h))),
      low_6m: p2(Math.min(...bars.map((b) => b.l))),
      last10_closes: closes.slice(-10).map(p2),
    };
  }

  async getSnapshot(extra: string[] = []): Promise<StockSnapshot> {
    const [{ source, quotes, errors }, indices, session] = await Promise.all([this.getQuotes(), this.getIndices(), this.getSession()]);
    const bySym = new Map(quotes.map((q) => [q.symbol, q]));
    const sorted = [...quotes].sort((a, b) => b.changePct - a.changePct);
    const gainers = sorted.slice(0, 6).map((q) => q.symbol);
    const losers = sorted.slice(-3).map((q) => q.symbol);
    const mega = ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL', 'TSLA', 'AVGO'].filter((s) => bySym.has(s));
    const cands = Array.from(new Set([...extra.filter((e) => bySym.has(e) || /^[A-Z.]{1,6}$/.test(e)), ...gainers, ...losers, ...mega])).slice(0, 16);
    let klineSource: string | null = null;
    const feats = await Promise.all(
      cands.map(async (s) => {
        const r = await this.getDaily(s);
        if (!r) return null;
        klineSource = klineSource ?? r.source;
        return StockMarketService.features(s, r.bars, bySym.get(s)?.price);
      }),
    );
    return {
      source,
      klineSource,
      fetchedAt: new Date().toISOString(),
      session,
      indices,
      quotes,
      features: feats.filter(Boolean) as StockFeatures[],
      errors,
    };
  }

  /** Live price for a single ticker (quotes list → Yahoo chart). */
  async livePrice(sym: string): Promise<{ price: number; name?: string } | null> {
    try {
      const { quotes } = await this.getQuotes();
      const q = quotes.find((x) => x.symbol === sym);
      if (q) return { price: q.price, name: q.name };
    } catch {
      /* ignore */
    }
    try {
      const d = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`, 6000);
      const m = d?.chart?.result?.[0]?.meta;
      if (m?.regularMarketPrice) return { price: m.regularMarketPrice, name: m.longName || m.shortName };
    } catch {
      /* ignore */
    }
    return null;
  }
}

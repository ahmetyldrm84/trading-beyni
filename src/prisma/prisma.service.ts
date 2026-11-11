/**
 * Yerel veritabanı: Node'un yerleşik SQLite'ı (node:sqlite). Ek kurulum, sunucu ya da indirme gerekmez;
 * her şey proje klasöründeki tek bir dosyada (varsayılan trading-beyni.db) tutulur.
 *
 * Kodun geri kalanı Prisma tarzı bir arayüz kullandığı için (prisma.owner.update(...) vb.)
 * burada ihtiyaç duyulan küçük alt kümeyi aynı imzalarla sağlıyoruz.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
import * as path from 'path';

// ---------- Satır tipleri ----------
export interface owner {
  id: number;
  chat_id: bigint | null;
  username: string | null;
  balance: number;
  kill_switch: boolean;
  last_scan_at: Date | null;
  stock_budget: number;
  stock_kill_switch: boolean;
  last_stock_scan_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
export interface instruction {
  id: number;
  text: string;
  constraints: unknown;
  active: boolean;
  created_at: Date;
}
export interface chat_message {
  id: number;
  role: string;
  content: string;
  created_at: Date;
}
export interface sent_signal {
  id: number;
  kind: string;
  market: string;
  origin: string;
  symbol: string;
  direction: string | null;
  entry: number | null;
  confidence: number | null;
  alert_key: string | null;
  payload: unknown;
  created_at: Date;
}
export interface scan_log {
  id: number;
  trigger: string;
  market: string;
  data_source: string | null;
  model: string | null;
  result: string;
  summary: string | null;
  error: string | null;
  duration_ms: number | null;
  created_at: Date;
}
export interface position {
  id: number;
  symbol: string;
  direction: string;
  status: string;
  entry: number | null;
  exit: number | null;
  leverage: number | null;
  margin: number | null;
  size: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  pnl: number | null;
  alerted: string | null;
  opened_at: Date;
  closed_at: Date | null;
  created_at: Date;
}
export interface processed_update {
  update_id: bigint;
  created_at: Date;
}

export namespace Prisma {
  export type InputJsonValue = unknown;
  export class PrismaClientKnownRequestError extends Error {
    constructor(
      message: string,
      public code: string,
    ) {
      super(message);
    }
  }
}

type Kind = 'int' | 'real' | 'text' | 'bool' | 'date' | 'json' | 'bigint';
interface TableDef {
  pk: string;
  cols: Record<string, { kind: Kind; def?: string }>;
  indexes?: string[][];
}

const TABLES: Record<string, TableDef> = {
  owner: {
    pk: 'id',
    cols: {
      id: { kind: 'int' },
      chat_id: { kind: 'bigint' },
      username: { kind: 'text' },
      balance: { kind: 'real', def: '200' },
      kill_switch: { kind: 'bool', def: '0' },
      last_scan_at: { kind: 'date' },
      stock_budget: { kind: 'real', def: '500' },
      stock_kill_switch: { kind: 'bool', def: '0' },
      last_stock_scan_at: { kind: 'date' },
      created_at: { kind: 'date' },
      updated_at: { kind: 'date' },
    },
  },
  instruction: {
    pk: 'id',
    cols: { id: { kind: 'int' }, text: { kind: 'text' }, constraints: { kind: 'json' }, active: { kind: 'bool', def: '1' }, created_at: { kind: 'date' } },
    indexes: [['active']],
  },
  chat_message: {
    pk: 'id',
    cols: { id: { kind: 'int' }, role: { kind: 'text' }, content: { kind: 'text' }, created_at: { kind: 'date' } },
    indexes: [['created_at']],
  },
  sent_signal: {
    pk: 'id',
    cols: {
      id: { kind: 'int' },
      kind: { kind: 'text' },
      market: { kind: 'text', def: "'CRYPTO'" },
      origin: { kind: 'text' },
      symbol: { kind: 'text' },
      direction: { kind: 'text' },
      entry: { kind: 'real' },
      confidence: { kind: 'real' },
      alert_key: { kind: 'text' },
      payload: { kind: 'json' },
      created_at: { kind: 'date' },
    },
    indexes: [['kind', 'symbol', 'created_at'], ['alert_key', 'created_at'], ['created_at']],
  },
  scan_log: {
    pk: 'id',
    cols: {
      id: { kind: 'int' },
      trigger: { kind: 'text' },
      market: { kind: 'text', def: "'CRYPTO'" },
      data_source: { kind: 'text' },
      model: { kind: 'text' },
      result: { kind: 'text' },
      summary: { kind: 'text' },
      error: { kind: 'text' },
      duration_ms: { kind: 'int' },
      created_at: { kind: 'date' },
    },
    indexes: [['created_at']],
  },
  position: {
    pk: 'id',
    cols: {
      id: { kind: 'int' },
      symbol: { kind: 'text' },
      direction: { kind: 'text' },
      status: { kind: 'text', def: "'OPEN'" },
      entry: { kind: 'real' },
      exit: { kind: 'real' },
      leverage: { kind: 'real' },
      margin: { kind: 'real' },
      size: { kind: 'real' },
      stop_loss: { kind: 'real' },
      take_profit: { kind: 'real' },
      pnl: { kind: 'real' },
      alerted: { kind: 'text' },
      opened_at: { kind: 'date' },
      closed_at: { kind: 'date' },
      created_at: { kind: 'date' },
    },
    indexes: [['status', 'created_at']],
  },
  processed_update: {
    pk: 'update_id',
    cols: { update_id: { kind: 'bigint' }, created_at: { kind: 'date' } },
    indexes: [['created_at']],
  },
};

const sqlType = (k: Kind) => (k === 'real' ? 'REAL' : k === 'text' || k === 'json' ? 'TEXT' : 'INTEGER');

function toDb(kind: Kind, v: unknown): any {
  if (v === undefined) return undefined;
  if (v === null) return null;
  switch (kind) {
    case 'bool':
      return v ? 1 : 0;
    case 'date':
      return v instanceof Date ? v.getTime() : new Date(v as any).getTime();
    case 'json':
      return JSON.stringify(v);
    case 'bigint':
      return BigInt(v as any);
    default:
      return v;
  }
}
function fromDb(kind: Kind, v: any): any {
  if (v === null || v === undefined) return null;
  switch (kind) {
    case 'bool':
      return !!v;
    case 'date':
      return new Date(Number(v));
    case 'json':
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
    case 'bigint':
      return BigInt(v);
    case 'int':
    case 'real':
      return Number(v);
    default:
      return v;
  }
}

type Where = Record<string, unknown>;
interface FindArgs {
  where?: Where;
  orderBy?: Record<string, 'asc' | 'desc'>;
  take?: number;
  skip?: number;
  select?: Record<string, boolean>;
}

class Table<T> {
  constructor(
    private readonly db: InstanceType<typeof DatabaseSync>,
    private readonly name: string,
    private readonly def: TableDef,
  ) {}

  private where(w: Where | undefined, params: any[]): string {
    if (!w) return '';
    const parts: string[] = [];
    for (const [col, cond] of Object.entries(w)) {
      const c = this.def.cols[col];
      if (!c) throw new Error(`${this.name}.${col} bilinmeyen kolon`);
      if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
        const ops: Record<string, string> = { gte: '>=', gt: '>', lte: '<=', lt: '<' };
        for (const [op, val] of Object.entries(cond as Record<string, unknown>)) {
          if (!ops[op]) throw new Error(`desteklenmeyen operatör ${op}`);
          parts.push(`"${col}" ${ops[op]} ?`);
          params.push(toDb(c.kind, val));
        }
      } else if (cond === null) {
        parts.push(`"${col}" IS NULL`);
      } else {
        parts.push(`"${col}" = ?`);
        params.push(toDb(c.kind, cond));
      }
    }
    return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
  }

  private row(r: any): T {
    const out: any = {};
    for (const [col, c] of Object.entries(this.def.cols)) out[col] = fromDb(c.kind, r[col]);
    return out as T;
  }

  async findMany(a: FindArgs = {}): Promise<T[]> {
    const params: any[] = [];
    let sql = `SELECT * FROM "${this.name}"${this.where(a.where, params)}`;
    if (a.orderBy) {
      const [col, dir] = Object.entries(a.orderBy)[0];
      sql += ` ORDER BY "${col}" ${dir === 'desc' ? 'DESC' : 'ASC'}`;
    }
    if (a.take != null || a.skip != null) sql += ` LIMIT ${a.take ?? -1} OFFSET ${a.skip ?? 0}`;
    return (this.db.prepare(sql).all(...params) as any[]).map((r) => this.row(r));
  }

  async findFirst(a: FindArgs = {}): Promise<T | null> {
    const r = await this.findMany({ ...a, take: 1 });
    return r[0] ?? null;
  }

  async create(a: { data: Partial<Record<keyof T, unknown>> }): Promise<T> {
    const data: Record<string, unknown> = { ...a.data };
    if ('created_at' in this.def.cols && data.created_at == null) data.created_at = new Date();
    if ('updated_at' in this.def.cols && data.updated_at == null) data.updated_at = new Date();
    const cols = Object.keys(data).filter((k) => data[k] !== undefined);
    const params = cols.map((k) => toDb(this.def.cols[k].kind, data[k]));
    try {
      const info = this.db
        .prepare(`INSERT INTO "${this.name}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .run(...params);
      const id = this.def.pk === 'id' ? Number(info.lastInsertRowid) : data[this.def.pk];
      return (await this.findFirst({ where: { [this.def.pk]: id } as Where }))!;
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test((e as Error).message)) throw new Prisma.PrismaClientKnownRequestError((e as Error).message, 'P2002');
      throw e;
    }
  }

  async updateMany(a: { where?: Where; data: Partial<Record<keyof T, unknown>> }): Promise<{ count: number }> {
    const data: Record<string, unknown> = { ...a.data };
    if ('updated_at' in this.def.cols) data.updated_at = new Date();
    const cols = Object.keys(data).filter((k) => data[k] !== undefined);
    if (!cols.length) return { count: 0 };
    const params = cols.map((k) => toDb(this.def.cols[k].kind, data[k]));
    const sql = `UPDATE "${this.name}" SET ${cols.map((c) => `"${c}" = ?`).join(', ')}${this.where(a.where, params)}`;
    const info = this.db.prepare(sql).run(...params);
    return { count: Number(info.changes) };
  }

  async update(a: { where: Where; data: Partial<Record<keyof T, unknown>> }): Promise<T> {
    const r = await this.updateMany(a);
    if (!r.count) throw new Error(`${this.name}: güncellenecek kayıt yok`);
    return (await this.findFirst({ where: a.where }))!;
  }

  async upsert(a: { where: Where; create: Partial<Record<keyof T, unknown>>; update: Partial<Record<keyof T, unknown>> }): Promise<T> {
    const existing = await this.findFirst({ where: a.where });
    if (!existing) return this.create({ data: a.create });
    if (Object.keys(a.update).length) return this.update({ where: a.where, data: a.update });
    return existing;
  }

  async deleteMany(a: { where?: Where } = {}): Promise<{ count: number }> {
    const params: any[] = [];
    const info = this.db.prepare(`DELETE FROM "${this.name}"${this.where(a.where, params)}`).run(...params);
    return { count: Number(info.changes) };
  }
}

@Injectable()
export class PrismaService implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly db: InstanceType<typeof DatabaseSync>;
  readonly owner: Table<owner>;
  readonly instruction: Table<instruction>;
  readonly chat_message: Table<chat_message>;
  readonly sent_signal: Table<sent_signal>;
  readonly scan_log: Table<scan_log>;
  readonly position: Table<position>;
  readonly processed_update: Table<processed_update>;

  constructor() {
    const url = process.env.DATABASE_URL || 'file:./trading-beyni.db';
    const file = path.resolve(process.cwd(), url.replace(/^file:/, '').replace(/^"|"$/g, ''));
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    for (const [name, def] of Object.entries(TABLES)) {
      const cols = Object.entries(def.cols).map(([c, d]) => {
        const pk = c === def.pk ? (def.pk === 'id' && d.kind === 'int' ? ' PRIMARY KEY AUTOINCREMENT' : ' PRIMARY KEY') : '';
        return `"${c}" ${sqlType(d.kind)}${pk}${d.def ? ` DEFAULT ${d.def}` : ''}`;
      });
      this.db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (${cols.join(', ')})`);
      for (const idx of def.indexes ?? [])
        this.db.exec(`CREATE INDEX IF NOT EXISTS "${name}_${idx.join('_')}" ON "${name}" (${idx.map((c) => `"${c}"`).join(',')})`);
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS "owner_chat_id" ON "owner" ("chat_id")');
    this.owner = new Table<owner>(this.db, 'owner', TABLES.owner);
    this.instruction = new Table<instruction>(this.db, 'instruction', TABLES.instruction);
    this.chat_message = new Table<chat_message>(this.db, 'chat_message', TABLES.chat_message);
    this.sent_signal = new Table<sent_signal>(this.db, 'sent_signal', TABLES.sent_signal);
    this.scan_log = new Table<scan_log>(this.db, 'scan_log', TABLES.scan_log);
    this.position = new Table<position>(this.db, 'position', TABLES.position);
    this.processed_update = new Table<processed_update>(this.db, 'processed_update', TABLES.processed_update);
    this.logger.log(`Veritabanı: ${file}`);
  }

  onModuleDestroy() {
    this.db.close();
  }
}

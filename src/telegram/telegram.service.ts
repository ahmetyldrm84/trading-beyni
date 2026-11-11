import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  constructor(private readonly config: ConfigService) {}

  private get token(): string {
    const t = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!t) throw new Error('TELEGRAM_BOT_TOKEN eksik');
    return t;
  }

  async api<T = any>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const r = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data: any = await r.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.error_code ?? r.status} ${data.description ?? ''}`);
    return data.result as T;
  }

  private chunks(text: string, size = 3900): string[] {
    if (text.length <= size) return [text];
    const out: string[] = [];
    let cur = '';
    for (const line of text.split('\n')) {
      if ((cur + '\n' + line).length > size) {
        if (cur) out.push(cur);
        cur = line.slice(0, size);
      } else cur = cur ? cur + '\n' + line : line;
    }
    if (cur) out.push(cur);
    return out;
  }

  async send(chatId: number | bigint | string, html: string): Promise<void> {
    for (const part of this.chunks(html)) {
      try {
        await this.api('sendMessage', {
          chat_id: chatId.toString(),
          text: part,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
      } catch (e) {
        this.logger.warn(`HTML send failed, retrying plain: ${(e as Error).message}`);
        await this.api('sendMessage', { chat_id: chatId.toString(), text: stripHtml(part) });
      }
    }
  }

  async typing(chatId: number | bigint | string) {
    try {
      await this.api('sendChatAction', { chat_id: chatId.toString(), action: 'typing' });
    } catch {
      /* ignore */
    }
  }

  async fileAsDataUrl(fileId: string): Promise<string> {
    const file = await this.api<{ file_path: string; file_size?: number }>('getFile', { file_id: fileId });
    const r = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!r.ok) throw new Error(`Telegram dosya indirilemedi (${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    const ext = (file.file_path.split('.').pop() || 'jpg').toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  }
}

export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

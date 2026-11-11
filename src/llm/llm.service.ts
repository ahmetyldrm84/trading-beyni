import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type LlmContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: LlmContent;
}

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ABACUS_ENDPOINT = 'https://apps.abacus.ai/v1/chat/completions';

/**
 * Karar modeli. Varsayılan: Anthropic API üzerinden Claude Fable 5.1 (görsel de okur).
 * ANTHROPIC_API_KEY yoksa ve ABACUSAI_API_KEY varsa eski Abacus RouteLLM yolu kullanılır.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  constructor(private readonly config: ConfigService) {}

  get provider(): 'anthropic' | 'abacus' {
    if (this.config.get<string>('ANTHROPIC_API_KEY')) return 'anthropic';
    if (this.config.get<string>('ABACUSAI_API_KEY')) return 'abacus';
    throw new Error('ANTHROPIC_API_KEY eksik (.env dosyasına ekle)');
  }

  /** Birincil model "fable"; yoksa / hata verirse sıradakine geçer. */
  get models(): string[] {
    const primary = this.config.get<string>('LLM_MODEL') || 'claude-fable-5-1';
    return Array.from(new Set([primary, 'claude-fable-5-1', 'claude-opus-5-5']));
  }

  async chat(
    messages: LlmMessage[],
    opts: { json?: boolean; maxTokens?: number } = {},
  ): Promise<{ content: string; model: string }> {
    const provider = this.provider;
    let lastErr = '';
    for (const model of this.models) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120_000);
      try {
        const t0 = Date.now();
        const content =
          provider === 'anthropic'
            ? await this.anthropic(model, messages, opts, ctrl.signal)
            : await this.abacus(model, messages, opts, ctrl.signal);
        if (!content) throw new Error('boş model cevabı');
        this.logger.log(`LLM ok provider=${provider} model=${model} ${Date.now() - t0}ms`);
        return { content, model };
      } catch (e) {
        lastErr = `${model}: ${(e as Error).message}`;
        this.logger.warn(`LLM call failed -> ${lastErr}`);
        // Anahtar hatalıysa diğer modelleri denemenin anlamı yok
        if (/HTTP 401|HTTP 403/.test(lastErr)) break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`LLM çağrısı başarısız (${lastErr})`);
  }

  private async anthropic(
    model: string,
    messages: LlmMessage[],
    opts: { json?: boolean; maxTokens?: number },
    signal: AbortSignal,
  ): Promise<string> {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => ('text' in p ? p.text : '')).join('\n')))
      .join('\n\n');
    const conv: { role: 'user' | 'assistant'; content: any[] }[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content.map(toAnthropicPart);
      const last = conv[conv.length - 1];
      // Anthropic aynı rolün art arda gelmesine izin vermez: birleştir
      if (last && last.role === m.role) last.content.push(...parts);
      else conv.push({ role: m.role, content: parts });
    }
    if (!conv.length || conv[0].role !== 'user') conv.unshift({ role: 'user', content: [{ type: 'text', text: '(başlangıç)' }] });
    const r = await fetch(this.config.get<string>('LLM_ENDPOINT') || ANTHROPIC_ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.get<string>('ANTHROPIC_API_KEY')!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 2000,
        system: opts.json ? `${system}\n\nCevabın SADECE geçerli tek bir JSON nesnesi olsun; öncesinde/sonrasında metin veya markdown yok.` : system,
        messages: conv,
      }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    return (data?.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
  }

  private async abacus(
    model: string,
    messages: LlmMessage[],
    opts: { json?: boolean; maxTokens?: number },
    signal: AbortSignal,
  ): Promise<string> {
    const r = await fetch(this.config.get<string>('LLM_ENDPOINT') || ABACUS_ENDPOINT, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.get<string>('ABACUSAI_API_KEY')}` },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        max_tokens: opts.maxTokens ?? 2000,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text)?.choices?.[0]?.message?.content ?? '';
  }

  static parseJson<T = any>(s: string): T {
    try {
      return JSON.parse(s) as T;
    } catch {
      const m = s.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('LLM JSON parse edilemedi');
      return JSON.parse(m[0]) as T;
    }
  }
}

/** OpenAI biçimindeki parçayı Anthropic biçimine çevirir (data URL → base64 görsel). */
export function toAnthropicPart(p: { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }): any {
  if (p.type === 'text') return { type: 'text', text: p.text };
  const m = p.image_url.url.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return { type: 'image', source: { type: 'url', url: p.image_url.url } };
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}

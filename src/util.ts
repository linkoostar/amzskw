import { randomInt, randomBytes, createHash } from 'node:crypto';

export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** uniform random int in [min, max] */
export function randInt(min: number, max: number): number {
  return randomInt(min, max + 1);
}

/** uniform random float in [min, max) */
export function randFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** pick random element */
export function pick<T>(arr: readonly T[]): T {
  return arr[randomInt(0, arr.length)];
}

/** shuffle a copy */
export function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizePhrase(p: string): string {
  return p.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** generate an amazon-like session id: 123-4567890-1234567 */
export function genSessionId(): string {
  const p = (n: number) => {
    let s = '';
    for (let i = 0; i < n; i++) s += randomInt(0, 10);
    return s.replace(/^0+/, '') || '1';
  };
  return `${p(3)}-${p(7)}-${p(7)}`;
}

export class CrawlerError extends Error {
  constructor(
    message: string,
    public readonly kind: 'http' | 'network' | 'parse',
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'CrawlerError';
  }
}

export function csvEscape(v: unknown): string {
  const s = String(v ?? '');
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

import type { Eol } from '@brain/shared';

const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function computeVersion(content: string): Promise<string> {
  return (await sha256Hex(content)).slice(0, 16);
}

export async function computeSignature(lines: string[]): Promise<string> {
  return (await sha256Hex(lines.join('\n'))).slice(0, 24);
}

export function detectEol(content: string): Eol {
  const crlf = content.match(/\r\n/g)?.length ?? 0;
  if (crlf === 0) return 'lf';
  const lfTotal = content.match(/\n/g)?.length ?? 0;
  return crlf >= lfTotal - crlf ? 'crlf' : 'lf';
}

export function applyEol(content: string, eol: Eol): string {
  const lf = content.replace(/\r\n/g, '\n');
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}

export function toLf(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[risultato troncato: ${text.length - max} caratteri omessi]`;
}

export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

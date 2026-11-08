import { describe, expect, it } from 'vitest';
import { normalizeRelPath } from '../src/storage/paths.js';

describe('Sandbox percorsi (normalizeRelPath)', () => {
  const extensions = ['.md', '.csv', '.txt'];

  it('accetta percorsi validi con estensioni ammesse', () => {
    expect(normalizeRelPath('note/corsa.md', { kind: 'file', extensions })).toBe('note/corsa.md');
    expect(normalizeRelPath('inbox/idea-1.txt', { kind: 'file', extensions })).toBe('inbox/idea-1.txt');
    expect(normalizeRelPath('dati/registro.csv', { kind: 'file', extensions })).toBe('dati/registro.csv');
  });

  it('rifiuta path traversal con ..', () => {
    expect(() => normalizeRelPath('../segreto.md', { kind: 'file', extensions })).toThrow(/\.\./);
    expect(() => normalizeRelPath('note/../../segreto.md', { kind: 'file', extensions })).toThrow(/\.\./);
    expect(() => normalizeRelPath('note/..', { kind: 'any', extensions })).toThrow(/\.\./);
  });

  it('rifiuta percent-encoding di traversal (%2e%2e)', () => {
    expect(() => normalizeRelPath('%2e%2e/segreto.md', { kind: 'file', extensions })).toThrow();
    expect(() => normalizeRelPath('note/%2e%2e/segreto.md', { kind: 'file', extensions })).toThrow();
  });

  it('rifiuta backslash di Windows', () => {
    expect(() => normalizeRelPath('note\\corsa.md', { kind: 'file', extensions })).toThrow(/separatore|\\/i);
  });

  it('rifiuta percorsi assoluti Unix e Windows', () => {
    expect(() => normalizeRelPath('/etc/passwd', { kind: 'file', extensions })).toThrow(/assolut[io]/i);
    expect(() => normalizeRelPath('C:/Windows/system32', { kind: 'file', extensions })).toThrow(/assolut[io]/i);
  });

  it('rifiuta nomi riservati Windows (CON, PRN, AUX, NUL, COM1, etc.)', () => {
    expect(() => normalizeRelPath('con.md', { kind: 'file', extensions })).toThrow(/riservato/i);
    expect(() => normalizeRelPath('sub/aux.txt', { kind: 'file', extensions })).toThrow(/riservato/i);
    expect(() => normalizeRelPath('nul', { kind: 'dir', extensions })).toThrow(/riservato/i);
  });

  it('rifiuta .git e sottoper方針 .git', () => {
    expect(() => normalizeRelPath('.git/config', { kind: 'file', extensions })).toThrow(/\.git/i);
    expect(() => normalizeRelPath('sotto/.git', { kind: 'any', extensions })).toThrow(/\.git/i);
  });

  it('rifiuta estensioni non ammesse per i file', () => {
    expect(() => normalizeRelPath('script.sh', { kind: 'file', extensions })).toThrow(/estensione/i);
    expect(() => normalizeRelPath('eseguibile.exe', { kind: 'file', extensions })).toThrow(/estensione/i);
  });
});

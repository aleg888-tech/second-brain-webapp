export interface ParsedWikilink {
  raw: string;
  target: string;
  alias: string | null;
  heading: string | null;
}

const WIKILINK_RE = /\[\[([^[\]|]+?)(?:#([^[\]|]+?))?(?:\|([^[\]|]+?))?\]\]/g;

export function parseWikilinks(text: string): ParsedWikilink[] {
  const links: ParsedWikilink[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(WIKILINK_RE.source, 'g');

  while ((match = regex.exec(text)) !== null) {
    const raw = match[0]!;
    const target = match[1]!.trim();
    const heading = match[2]?.trim() || null;
    const alias = match[3]?.trim() || null;
    links.push({ raw, target, heading, alias });
  }

  return links;
}

export type WikilinkResolver = (
  target: string,
) => { path: string; displayTitle: string } | null;

/**
 * Sostituisce i wikilink nel testo Markdown con tag <a> personalizzati prima del render,
 * così DOMPurify può lasciarli intatti con attributi data-* sicuri.
 * Se viene fornito `resolveTarget`:
 * - se la pagina non esiste (`null`), il link pagina viene rimosso;
 * - se esiste, mostra sempre il nome attuale della nota (`displayTitle`).
 */
export function replaceWikilinksWithHtml(
  text: string,
  resolveTarget?: WikilinkResolver,
): string {
  return text.replace(WIKILINK_RE, (_match, targetRaw, headingRaw, aliasRaw) => {
    const target = (targetRaw || '').trim();
    const heading = headingRaw ? headingRaw.trim() : '';
    const alias = aliasRaw ? aliasRaw.trim() : '';

    if (resolveTarget) {
      const resolved = resolveTarget(target);
      if (!resolved) {
        return '';
      }
      const label = heading
        ? `${resolved.displayTitle} > ${heading}`
        : resolved.displayTitle;
      const safeTarget = encodeURIComponent(resolved.path);
      const safeHeading = encodeURIComponent(heading);
      return `<a class="wikilink-badge" data-wikilink-target="${safeTarget}" data-wikilink-heading="${safeHeading}" href="javascript:void(0)" title="Apri nota: ${escapeHtml(resolved.displayTitle)}">${escapeHtml(label)}</a>`;
    }

    const label = alias || (heading ? `${target} > ${heading}` : target);
    const safeTarget = encodeURIComponent(target);
    const safeHeading = encodeURIComponent(heading);

    return `<a class="wikilink-badge" data-wikilink-target="${safeTarget}" data-wikilink-heading="${safeHeading}" href="javascript:void(0)" title="Apri nota: ${target}">${escapeHtml(label)}</a>`;
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

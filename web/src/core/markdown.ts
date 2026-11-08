import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { replaceWikilinksWithHtml, type WikilinkResolver } from './wikilinks.js';

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function renderMarkdown(content: string, resolveTarget?: WikilinkResolver): string {
  // 1. Sostituzione dei wikilink con elementi sicuri data-wikilink-*
  const textWithLinks = replaceWikilinksWithHtml(content, resolveTarget);

  // 2. Render HTML tramite marked
  const rawHtml = marked.parse(textWithLinks, { async: false }) as string;

  // 3. Sanitizzazione con DOMPurify (consente data-wikilink-* e checkbox GFM)
  const cleanHtml = DOMPurify.sanitize(rawHtml, {
    ADD_TAGS: ['input'],
    ADD_ATTR: [
      'target',
      'data-wikilink-target',
      'data-wikilink-heading',
      'disabled',
      'type',
      'checked',
    ],
  });

  return cleanHtml;
}

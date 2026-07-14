import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

turndown.remove(["script", "style"]);

export function htmlToMd(html: string): string {
  if (!html) {return '';}
  return turndown.turndown(html);
}

// Below this many characters of extracted prose, Readability likely grabbed a
// stub (paywall teaser, "enable JS" notice); prefer the whole-page fallback so
// the garbage detector downstream can judge the real content.
const READABILITY_MIN_TEXT_CHARS = 200;

/**
 * Extract the main article from a full HTML page, then convert to Markdown.
 *
 * Path: linkedom (pure-JS DOM, workerd-safe) -> @mozilla/readability -> turndown.
 * jsdom is deliberately avoided (does not run under Cloudflare Workers/workerd).
 * If Readability cannot find a substantial article, falls back to converting the
 * whole page; the extract-quality detector is the safety net for that case.
 */
export function extractArticleMd(html: string, url?: string): string {
  if (!html) {return '';}
  try {
    const { document } = parseHTML(html);
    // Give Readability a base URL so it can resolve relative links/images.
    if (url !== undefined && url !== '') {
      try {
        const base = document.createElement('base');
        base.setAttribute('href', url);
        document.head.appendChild(base);
      } catch {
        // Non-fatal: relative links just stay relative.
      }
    }
    // Readability mutates the document in place; linkedom's DOM is disposable here.
    const parsed = new Readability(document as unknown as Document).parse();
    const content = parsed?.content ?? '';
    const textLen = (parsed?.textContent ?? '').trim().length;
    if (content !== '' && textLen >= READABILITY_MIN_TEXT_CHARS) {
      const title = (parsed?.title ?? '').trim();
      const body = htmlToMd(content);
      return title === '' ? body : `# ${title}\n\n${body}`;
    }
  } catch {
    // Fall through to whole-page conversion below.
  }
  return htmlToMd(html);
}

export default htmlToMd;

import DOMPurify from "dompurify";
import { marked } from "marked";
import { slugify } from "../server/core/slugify";

const WIKILINK_RE = /\[\[([^[\]]+)\]\]/g;

/**
 * Markdown → sanitized HTML with [[wikilinks]] turned into anchors.
 * Wikilinks are resolved after rendering by walking text nodes and skipping
 * code/pre, so links inside code blocks stay literal — mirroring the
 * server parser's fence-awareness. Missing targets (not in existingSlugs)
 * get the "missing" style and open the new-entry flow prefilled.
 */
export function renderMarkdown(md: string, existingSlugs?: Set<string>): string {
  const html = DOMPurify.sanitize(marked.parse(md, { async: false }));
  const doc = new DOMParser().parseFromString(html, "text/html");

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("code, pre, a")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  for (const node of textNodes) {
    const text = node.textContent ?? "";
    if (!WIKILINK_RE.test(text)) continue;
    WIKILINK_RE.lastIndex = 0;

    const fragment = doc.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(WIKILINK_RE)) {
      fragment.append(text.slice(last, m.index));
      last = m.index + m[0].length;
      const title = m[1]!.trim();
      let slug: string | null = null;
      try {
        slug = slugify(title);
      } catch {
        // symbols-only title: leave the raw text
      }
      if (!slug) {
        fragment.append(m[0]);
        continue;
      }
      const missing = existingSlugs ? !existingSlugs.has(slug) : false;
      const a = doc.createElement("a");
      a.textContent = title;
      a.dataset.wikilink = "true";
      a.className = missing ? "wikilink missing" : "wikilink";
      a.href = missing ? `/?topic=${encodeURIComponent(title)}` : `/topic/${slug}`;
      fragment.append(a);
    }
    fragment.append(text.slice(last));
    node.replaceWith(fragment);
  }

  return doc.body.innerHTML;
}

/** SPA-navigate wikilink/anchor clicks inside rendered markdown. */
export function interceptWikilinkClicks(
  event: React.MouseEvent,
  navigate: (to: string) => void,
): void {
  const anchor = (event.target as HTMLElement).closest("a[data-wikilink]");
  if (!anchor) return;
  event.preventDefault();
  navigate(anchor.getAttribute("href")!);
}

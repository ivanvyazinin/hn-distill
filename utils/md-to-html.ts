import MarkdownIt from "markdown-it";
import sanitizeHtml, { type IOptions } from "sanitize-html";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});

const allowedTags = [
  "p",
  "br",
  "strong",
  "em",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];

const allowedAttributes = {
  a: ["href", "name", "target", "rel"],
  code: ["class"],
  pre: ["class"],
  th: ["align"],
  td: ["align"],
} as const;

const transformTags = {
  // Enforce safe link attributes
  a: (tagName: string, attribs: Record<string, string>) => {
    void tagName; // mark parameter as used
    const href = attribs["href"] ?? "";
    // Disallow dangerous protocols
    const safeHref = /^\s*javascript:/iu.test(href) ? "" : href;
    return {
      tagName: "a",
      attribs: {
        href: safeHref,
        target: "_blank",
        rel: "noopener noreferrer nofollow",
      },
    };
  },
  th: (tagName: string, attribs: Record<string, string>) => {
    const { style } = attribs;
    switch (style) {
      case "text-align:right": {
        attribs["align"] = "right";
        break;
      }
      case "text-align:center": {
        attribs["align"] = "center";
        break;
      }
      case "text-align:left": {
        attribs["align"] = "left";
        break;
      }
      case undefined: {
        // no-op
        break;
      }
      default: {
        // leave as-is for other values
        break;
      }
    }
    delete attribs["style"];
    return { tagName, attribs };
  },
  td: (tagName: string, attribs: Record<string, string>) => {
    const { style } = attribs;
    switch (style) {
      case "text-align:right": {
        attribs["align"] = "right";
        break;
      }
      case "text-align:center": {
        attribs["align"] = "center";
        break;
      }
      case "text-align:left": {
        attribs["align"] = "left";
        break;
      }
      case undefined: {
        // no-op
        break;
      }
      default: {
        // leave as-is for other values
        break;
      }
    }
    delete attribs["style"];
    return { tagName, attribs };
  },
} as const;

// Memoise by input markdown string. The same summary is rendered on its item page,
// on paginated pages, and on every tag page it appears in — this collapses those
// repeats into one render+sanitize. Output is a pure function of the input string,
// so the cache never goes stale within a process.
// Unbounded on purpose: fine for a one-shot `astro build` (bounded by the corpus).
// For a long-lived `astro dev` with frequently regenerated summaries this could grow
// slowly; an LRU is not warranted now.
const htmlCache = new Map<string, string>();

export function mdToHtml(src: string): string {
  if (!src) {
    return "";
  }
  const cached = htmlCache.get(src);
  if (cached !== undefined) {
    return cached;
  }
  const rendered = md.render(src);
  const options: IOptions = {
    allowedTags: allowedTags as unknown as IOptions["allowedTags"],
    allowedAttributes: allowedAttributes as unknown as IOptions["allowedAttributes"],
    disallowedTagsMode: "discard",
    transformTags: transformTags as unknown as IOptions["transformTags"],
  };
  const html = sanitizeHtml(rendered, options);
  htmlCache.set(src, html);
  return html;
}

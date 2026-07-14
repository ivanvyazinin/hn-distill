import { describe, expect, test } from "bun:test";

import { extractArticleMd, htmlToMd } from "../utils/html-to-md";

const PARAGRAPH =
  "This is a genuinely substantial paragraph of article prose with more than enough words to convince Readability that it has found real content worth extracting from the page.";

const FULL_PAGE = `<!doctype html>
<html>
  <head><title>My Great Article</title></head>
  <body>
    <nav id="nav"><a href="/">Home</a><a href="/about">About</a><a href="/login">Sign in</a></nav>
    <header><div class="cookie-banner">We use cookies. Accept all?</div></header>
    <article>
      <h1>My Great Article</h1>
      <p>${PARAGRAPH}</p>
      <p>${PARAGRAPH}</p>
      <p>A second point with <a href="/rel">a relative link</a> inside the body text that should be preserved.</p>
    </article>
    <footer id="foot"><a href="/privacy">Privacy</a><a href="/terms">Terms</a>© 2026 Example Inc.</footer>
  </body>
</html>`;

describe("extractArticleMd", () => {
  test("strips nav/cookie/footer boilerplate and keeps the article body", () => {
    const md = extractArticleMd(FULL_PAGE, "https://example.com/post");
    expect(md).toContain(PARAGRAPH);
    // Boilerplate dropped by Readability
    expect(md).not.toContain("We use cookies");
    expect(md).not.toContain("Sign in");
    expect(md).not.toContain("© 2026 Example Inc.");
    expect(md).not.toContain("Privacy");
  });

  test("resolves relative links against the base URL", () => {
    const md = extractArticleMd(FULL_PAGE, "https://example.com/post");
    expect(md).toContain("https://example.com/rel");
  });

  test("falls back to whole-page conversion when Readability finds no article", () => {
    // Too little content for Readability to consider it an article -> fallback path.
    const fragment = "<div><span>hi</span> <b>there</b></div>";
    const md = extractArticleMd(fragment);
    expect(md).toBe(htmlToMd(fragment));
  });

  test("returns empty string for empty input", () => {
    expect(extractArticleMd("")).toBe("");
  });

  test("does not throw on malformed HTML", () => {
    expect(() => extractArticleMd("<html><body><p>unclosed")).not.toThrow();
  });
});

import { describe, expect, test } from "bun:test";

import { assessExtractQuality, computeExtractMetrics, DEFAULT_EXTRACT_THRESHOLDS } from "../utils/extract-quality";

// Golden corpus — the acceptance gate for the detector formula + default thresholds.
// Positives (real content) MUST verdict "article"; boilerplate MUST verdict "no-article".
// PDF/YouTube-transcript content is included to document that it WOULD survive the
// detector; in the pipeline those kinds bypass it entirely (HTML-only).

const REAL_ARTICLE = `# Why we rewrote our scheduler

Our old scheduler was a single-threaded loop that polled the database every second and dispatched jobs one at a time. As traffic grew this became the primary bottleneck, adding seconds of latency to every request during peak hours and occasionally dropping jobs when the queue overflowed its fixed buffer.

We replaced it with a work-stealing pool backed by a lock-free ring buffer. Each worker owns a local deque and steals from siblings only when idle, which keeps cache locality high and avoids the thundering-herd problem we saw with a shared mutex. Throughput improved roughly fourfold in our staging benchmarks and tail latency dropped from 800ms to under 40ms at the 99th percentile.

The migration was not painless. We had to carefully drain the old queue, replay a handful of stuck jobs by hand, and add extensive tracing before we trusted the new path in production. Six months later it has paid for itself many times over.`;

const GITHUB_README = `# fastparse

A tiny, dependency-free parser combinator library for TypeScript that focuses on clear error messages and predictable backtracking behavior for everyday parsing tasks.

## Installation

\`\`\`bash
npm install fastparse
\`\`\`

## Why another parser library

Most parser combinator libraries optimize for expressiveness at the cost of debuggability, so when a parse fails you get an unhelpful stack of anonymous closures instead of a pointer to the offending byte.

- The \`seq\` combinator threads position information through every step so failures always report an exact line and column in the source input
- Backtracking is explicit via the \`attempt\` wrapper, which means you never pay for speculative parsing unless you actually asked for it in your grammar
- Error messages are composed bottom-up and deduplicated, so a deeply nested failure surfaces the single most relevant expectation to the caller`;

const RELEASE_NOTES = `# Release v4.2.0

This release focuses on stability and developer experience, closing out a long backlog of reliability issues reported by users running large multi-tenant deployments.

## Changes

- Fixed a critical race condition where two concurrent writers could corrupt the on-disk index if a flush was interrupted at exactly the wrong moment
- Reworked the retry logic so transient network errors now back off exponentially instead of hammering the upstream service and tripping its rate limiter
- Added a new \`--dry-run\` flag to every destructive command so operators can preview exactly what would change before committing to it
- Improved startup time by roughly forty percent by lazily loading plugins only when their commands are first invoked rather than all at once`;

const DOCS_PAGE = `# Configuration reference

The configuration file is a TOML document loaded from the path given by the \`--config\` flag, falling back to the platform-specific user config directory when the flag is omitted from the command line.

## Server options

The server section controls how the process binds to the network and how it handles incoming connections from clients that may be slow or malicious.

- \`bind_address\` sets the interface and port the server listens on; use \`0.0.0.0\` to accept connections on every interface or a specific address to restrict exposure
- \`max_connections\` caps the number of simultaneous clients so a burst of traffic cannot exhaust file descriptors and take the whole process down with it
- \`read_timeout\` bounds how long the server waits for a complete request before it gives up, which protects against slow-loris style denial of service attacks`;

const PDF_TEXT = `Abstract. We present a method for training large language models with substantially reduced memory footprint by offloading optimizer state to host memory and overlapping the transfer with computation on the accelerator.

Our approach partitions the optimizer state across the available host memory and streams each partition back to the device just in time for the corresponding parameter update, which hides almost all of the transfer latency behind the backward pass.

We evaluate on models ranging from one to seventy billion parameters and find that the technique enables training configurations that would otherwise require twice the accelerator memory, at a throughput cost of under ten percent in the worst case we measured.`;

const YOUTUBE_TRANSCRIPT = `so today i want to walk through how we actually debugged this production outage because i think the process is more interesting than the bug itself and there are a few lessons that generalize to any on call rotation

it started with a page at three in the morning saying that latency was spiking and the first thing i did which in hindsight was a mistake was to assume it was the database because it usually is the database but this time it really was not the database at all

what actually happened was that a config change had shipped that afternoon and it quietly doubled the number of retries on a downstream call so under load we were amplifying our own traffic and the whole thing spiralled from there until we rolled it back`;

const NAV_FOOTER_JUNK = `[Home](/) [About](/about) [Products](/products) [Pricing](/pricing) [Blog](/blog) [Careers](/careers) [Contact](/contact)

[Sign in](/login) [Sign up](/signup)

- [Facebook](https://facebook.com)
- [Twitter](https://twitter.com)
- [LinkedIn](https://linkedin.com)
- [Instagram](https://instagram.com)

[Privacy](/privacy) [Terms](/terms) [Cookie policy](/cookies)

© 2026 Example Inc.`;

const COOKIE_BANNER_UI = `Something went wrong. Please try again.

Practice again

Share your result

Sign in to save your progress

[Learn more](/learn) [Get started](/start) [Get started](/start)`;

const DUPLICATED_JUNK = `Loading...
Loading...
Loading...
Loading...
Please enable JavaScript to view this content.
Please enable JavaScript to view this content.
Please enable JavaScript to view this content.
Please enable JavaScript to view this content.
Advertisement
Advertisement
Advertisement`;

describe("assessExtractQuality golden corpus", () => {
  const articles: Array<[string, string]> = [
    ["real article", REAL_ARTICLE],
    ["github README", GITHUB_README],
    ["release notes", RELEASE_NOTES],
    ["docs page", DOCS_PAGE],
    // These bypass the detector in the pipeline (non-HTML), but must survive it anyway.
    ["pdf text", PDF_TEXT],
    ["youtube transcript", YOUTUBE_TRANSCRIPT],
  ];

  for (const [name, md] of articles) {
    test(`${name} -> article`, () => {
      expect(assessExtractQuality(md).verdict).toBe("article");
    });
  }

  const junk: Array<[string, string]> = [
    ["nav/footer link farm", NAV_FOOTER_JUNK],
    ["cookie/UI boilerplate", COOKIE_BANNER_UI],
    ["duplicated-line junk", DUPLICATED_JUNK],
  ];

  for (const [name, md] of junk) {
    test(`${name} -> no-article`, () => {
      expect(assessExtractQuality(md).verdict).toBe("no-article");
    });
  }

  test("empty input -> no-article", () => {
    expect(assessExtractQuality("").verdict).toBe("no-article");
    expect(assessExtractQuality("   \n  \n").verdict).toBe("no-article");
  });

  test("duplicated-line junk trips the dup-ratio rule", () => {
    const m = computeExtractMetrics(DUPLICATED_JUNK);
    expect(m.dupRatio).toBeGreaterThan(DEFAULT_EXTRACT_THRESHOLDS.maxDupRatio);
  });

  test("link farm trips the link-density rule", () => {
    const m = computeExtractMetrics(NAV_FOOTER_JUNK);
    expect(m.linkDensity).toBeGreaterThan(DEFAULT_EXTRACT_THRESHOLDS.maxLinkDensity);
  });

  test("thresholds are configurable", () => {
    // With an impossibly high prose floor, even a real article is rejected.
    const strict = assessExtractQuality(REAL_ARTICLE, {
      minProseChars: 1_000_000,
      maxLinkDensity: 1,
      maxDupRatio: 1,
    });
    expect(strict.verdict).toBe("no-article");
  });
});

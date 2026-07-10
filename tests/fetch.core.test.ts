import { describe, expect, test } from "bun:test";

import { HnItemRawSchema } from "@config/schemas";
import type { Services } from "../scripts/fetch-hn.mts";
import { fetchItem, readTopIds } from "../scripts/fetch-hn.mts";
import { makeMockHttp } from "./helpers";

describe("scripts/fetch-hn core", () => {
  test("readTopIds truncates and preserves order", async () => {
    const services = makeMockHttp({ "/\\/topstories\\.json$/": [5, 4, 3, 2, 1] }) as unknown as Services;
    const ids = await readTopIds(services, 3);
    expect(ids).toEqual([5, 4, 3]);
  });

  test("readTopIds returns empty list for empty/invalid API response", async () => {
    const services1 = makeMockHttp({ "/\\/topstories\\.json$/": [] }) as unknown as Services;
    expect(await readTopIds(services1, 5)).toEqual([]);

    const services2 = makeMockHttp({ "/\\/topstories\\.json$/": {} }) as unknown as Services;
    expect(await readTopIds(services2, 5)).toEqual([]);

    const services3 = makeMockHttp({ "/\\/topstories\\.json$/": undefined }) as unknown as Services;
    expect(await readTopIds(services3, 5)).toEqual([]);
  });

  test("fetchItem successfully parses story and comment shapes", async () => {
    const now = 1_700_000_000;
    const storyData = { id: 1, type: "story", title: "A story", by: "user", time: now, kids: [2] };
    const commentData = { id: 2, type: "comment", text: "A comment", by: "user", time: now, parent: 1 };

    const servicesStory = makeMockHttp({ "/\\/item\\/1\\.json$/": storyData }) as unknown as Services;
    const story = await fetchItem(servicesStory, 1);
    expect(story).not.toBeUndefined();
    expect(story?.type).toBe("story");
    expect(HnItemRawSchema.safeParse(story).success).toBeTrue();

    const servicesComment = makeMockHttp({ "/\\/item\\/2\\.json$/": commentData }) as unknown as Services;
    const comment = await fetchItem(servicesComment, 2);
    expect(comment).not.toBeUndefined();
    expect(comment?.type).toBe("comment");
    expect(HnItemRawSchema.safeParse(comment).success).toBeTrue();
  });

  test("fetchItem returns undefined for invalid schema", async () => {
    const invalidData = { id: 1, title: "Missing type" };
    const services = makeMockHttp({ "/\\/item\\/1\\.json$/": invalidData }) as unknown as Services;
    const item = await fetchItem(services, 1);
    expect(item).toBeUndefined();
  });

  test("readTopIds daily-top-by-score ranks UTC-day stories by official score", async () => {
    const now = new Date("2026-03-06T15:00:00.000Z");
    const startUnix = Math.floor(Date.parse("2026-03-06T00:00:00.000Z") / 1000);
    const endUnix = Math.floor(Date.parse("2026-03-07T00:00:00.000Z") / 1000);
    const storyAlpha = { id: 101, type: "story", title: "alpha", by: "a", time: startUnix + 100, score: 150, kids: [] };
    const storyBeta = { id: 102, type: "story", title: "beta", by: "b", time: startUnix + 500, score: 200, kids: [] };
    const storyGamma = { id: 103, type: "story", title: "gamma", by: "c", time: startUnix + 600, score: 200, kids: [] };
    const storyOutside = {
      id: 104,
      type: "story",
      title: "outside",
      by: "d",
      time: endUnix + 5,
      score: 999,
      kids: [],
    };

    const services = makeMockHttp({
      "/search_by_date/": {
        hits: [
          { objectID: "101", created_at_i: startUnix + 100 },
          { objectID: "102", created_at_i: startUnix + 500 },
          { objectID: "103", created_at_i: startUnix + 600 },
          { objectID: "104", created_at_i: endUnix + 5 },
          { objectID: "bad-id", created_at_i: startUnix + 700 },
        ],
        nbPages: 1,
        nbHits: 5,
      },
      "/\\/item\\/101\\.json$/": storyAlpha,
      "/\\/item\\/102\\.json$/": storyBeta,
      "/\\/item\\/103\\.json$/": storyGamma,
      "/\\/item\\/104\\.json$/": storyOutside,
    }) as unknown as Services;

    const ids = await readTopIds(services, 3, { mode: "daily-top-by-score", now, concurrency: 4 });
    expect(ids).toEqual([103, 102, 101]);
  });

  test("readTopIds daily-top-by-score splits Algolia windows and deduplicates ids", async () => {
    const now = new Date("2026-03-06T12:00:00.000Z");
    const startUnix = Math.floor(Date.parse("2026-03-06T00:00:00.000Z") / 1000);
    const middayUnix = Math.floor(Date.parse("2026-03-06T12:00:00.000Z") / 1000);
    const endUnix = Math.floor(Date.parse("2026-03-07T00:00:00.000Z") / 1000);
    const algoliaCalls: string[] = [];

    const services = makeMockHttp({
      "/search_by_date/": (url: string) => {
        algoliaCalls.push(url);

        if (url.includes(`created_at_i%3E%3D${startUnix}%2Ccreated_at_i%3C${endUnix}`)) {
          return {
            hits: [
              { objectID: "201", created_at_i: startUnix + 10 },
              { objectID: "202", created_at_i: middayUnix + 10 },
            ],
            nbPages: 2,
            nbHits: 1200,
          };
        }

        if (url.includes(`created_at_i%3E%3D${startUnix}%2Ccreated_at_i%3C${middayUnix}`)) {
          return {
            hits: [
              { objectID: "201", created_at_i: startUnix + 10 },
              { objectID: "201", created_at_i: startUnix + 10 },
            ],
            nbPages: 1,
            nbHits: 2,
          };
        }

        if (url.includes(`created_at_i%3E%3D${middayUnix}%2Ccreated_at_i%3C${endUnix}`)) {
          return {
            hits: [{ objectID: "202", created_at_i: middayUnix + 10 }],
            nbPages: 1,
            nbHits: 1,
          };
        }

        return { hits: [], nbPages: 1, nbHits: 0 };
      },
      "/\\/item\\/201\\.json$/": {
        id: 201,
        type: "story",
        title: "left",
        by: "a",
        time: startUnix + 10,
        score: 10,
        kids: [],
      },
      "/\\/item\\/202\\.json$/": {
        id: 202,
        type: "story",
        title: "right",
        by: "b",
        time: middayUnix + 10,
        score: 20,
        kids: [],
      },
    }) as unknown as Services;

    const ids = await readTopIds(services, 5, { mode: "daily-top-by-score", now, concurrency: 4 });
    expect(ids).toEqual([202, 201]);
    expect(algoliaCalls.some((url) => url.includes(`created_at_i%3E%3D${startUnix}%2Ccreated_at_i%3C${endUnix}`))).toBe(
      true
    );
    expect(
      algoliaCalls.some((url) => url.includes(`created_at_i%3E%3D${startUnix}%2Ccreated_at_i%3C${middayUnix}`))
    ).toBe(true);
    expect(algoliaCalls.some((url) => url.includes(`created_at_i%3E%3D${middayUnix}%2Ccreated_at_i%3C${endUnix}`))).toBe(
      true
    );
  });

  test("readTopIds daily-top-by-score returns empty list for invalid Algolia response", async () => {
    const services = makeMockHttp({
      "/search_by_date/": { unexpected: true },
    }) as unknown as Services;

    expect(
      await readTopIds(services, 5, {
        mode: "daily-top-by-score",
        now: new Date("2026-03-06T00:00:00.000Z"),
        concurrency: 4,
      })
    ).toEqual(
      []
    );
  });

  test("readTopIds daily-top-by-score supports yesterday via dayOffset", async () => {
    const now = new Date("2026-03-06T12:00:00.000Z");
    const yesterdayStartUnix = Math.floor(Date.parse("2026-03-05T00:00:00.000Z") / 1000);
    const yesterdayEndUnix = Math.floor(Date.parse("2026-03-06T00:00:00.000Z") / 1000);
    const seenUrls: string[] = [];

    const services = makeMockHttp({
      "/search_by_date/": (url: string) => {
        seenUrls.push(url);
        return {
          hits: [{ objectID: "301", created_at_i: yesterdayStartUnix + 600 }],
          nbPages: 1,
          nbHits: 1,
        };
      },
      "/\\/item\\/301\\.json$/": {
        id: 301,
        type: "story",
        title: "yesterday",
        by: "alice",
        time: yesterdayStartUnix + 600,
        score: 88,
        kids: [],
      },
    }) as unknown as Services;

    const ids = await readTopIds(services, 5, { mode: "daily-top-by-score", now, dayOffset: -1, concurrency: 4 });
    expect(ids).toEqual([301]);
    expect(
      seenUrls.some((url) => url.includes(`created_at_i%3E%3D${yesterdayStartUnix}%2Ccreated_at_i%3C${yesterdayEndUnix}`))
    ).toBe(true);
  });
});

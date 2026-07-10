export const HN = {
  api: "https://hacker-news.firebaseio.com/v0",
  algoliaApi: "https://hn.algolia.com/api/v1",
  itemUrl: (id: number) => `https://news.ycombinator.com/item?id=${id}`,
} as const;

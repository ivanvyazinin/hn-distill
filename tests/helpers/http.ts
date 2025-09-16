/* eslint-disable security/detect-non-literal-regexp */
import type { HttpClient } from "@utils/http-client";

/**
 * Simple HTTP mock. Pass routes as a map where keys are strings like "/pattern/flags".
 * Examples:
 *   makeMockHttp({ "/\\/topstories\\.json$/": [1,2,3] })
 *   makeMockHttp({ "/^https:\\/\\/example\\.com\\/?$/u": "<h1>Hello</h1>" })
 */
function toRegExp(key: string): RegExp {
  // Accept "/pattern/" or "/pattern/flags"
  const m = /^\/(?<source>.*)\/(?<flags>[a-z]*)$/iu.exec(key);
  if (m?.groups) {
    const source = m.groups["source"] ?? "";
    const flagsRaw = m.groups["flags"] ?? "";
    const flags = flagsRaw.includes("u") ? flagsRaw : `${flagsRaw}u`;
    try {
      return new RegExp(source, flags);
    } catch {
      return new RegExp(source, "u");
    }
  }
  // Fallback: treat the whole key as the source
  return new RegExp(key, "u");
}

export function makeMockHttp(routes: Record<string, unknown>): { http: HttpClient; readonly calls: number } {
  let calls = 0;

  const http = {
    json: async <T>(url: string): Promise<T | null> => {
      calls++;
      for (const [key, val] of Object.entries(routes)) {
        const r = toRegExp(key);
        if (r.test(url)) {
          return (val as T) ?? null;
        }
      }
      return null as unknown as T;
    },
    text: async (url: string): Promise<string> => {
      calls++;
      for (const [key, val] of Object.entries(routes)) {
        const r = toRegExp(key);
        if (r.test(url)) {
          return String(val);
        }
      }
      return "";
    },
  } as unknown as HttpClient;

  return {
    http,
    get calls() {
      return calls;
    },
  };
}

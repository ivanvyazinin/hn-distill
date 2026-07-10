/* eslint-disable security/detect-non-literal-regexp */
import type { HttpClient } from "@utils/http-client";

type RouteResolver = (url: string) => unknown;
type RouteValue = RouteResolver | boolean | number | object | string | null | undefined;

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

async function resolveRouteValue(value: RouteValue, url: string): Promise<unknown> {
  if (typeof value === "function") {
    return await Promise.resolve(value(url));
  }
  return value;
}

export function makeMockHttp(routes: Record<string, RouteValue>): { http: HttpClient; readonly calls: number } {
  let calls = 0;

  const http = {
    json: async <T>(url: string): Promise<T | null> => {
      calls++;
      for (const [key, val] of Object.entries(routes)) {
        const r = toRegExp(key);
        if (r.test(url)) {
          return ((await resolveRouteValue(val, url)) as T) ?? null;
        }
      }
      return null as unknown as T;
    },
    text: async (url: string): Promise<string> => {
      calls++;
      for (const [key, val] of Object.entries(routes)) {
        const r = toRegExp(key);
        if (r.test(url)) {
          return String(await resolveRouteValue(val, url));
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

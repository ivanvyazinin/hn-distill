import he from "he";

import { log } from "@utils/log";

import type { HttpClient } from "@utils/http-client";

const LOG_NAMESPACE = "youtube";

export function isYouTubeUrl(u: URL): boolean {
  return u.hostname === "www.youtube.com" || u.hostname === "youtube.com" || u.hostname === "youtu.be";
}

export function getVideoId(u: URL): string | undefined {
  if (u.hostname === "youtu.be") {
    const id = u.pathname.slice(1);
    return id.length > 0 ? id : undefined;
  }
  if (!u.hostname.endsWith("youtube.com")) {
    return undefined;
  }

  if (u.pathname.startsWith("/watch")) {
    const v = u.searchParams.get("v");
    return typeof v === "string" && v.length > 0 ? v : undefined;
  }

  if (u.pathname.startsWith("/embed/")) {
    const parts = u.pathname.split("/");
    const embedId = parts[2] ?? "";
    return embedId.length > 0 ? embedId : undefined;
  }

  if (u.pathname.startsWith("/shorts/")) {
    const parts = u.pathname.split("/");
    const shortsId = parts[2] ?? "";
    return shortsId.length > 0 ? shortsId : undefined;
  }

  return undefined;
}

type CaptionTrack = {
  baseUrl: string;
  languageCode: string;
  name?: { simpleText?: string };
  kind?: string; // 'asr' for auto-generated
};

type PlayerCaptionsTracklistRenderer = {
  captionTracks?: CaptionTrack[];
};

type PlayerResponse = {
  captions?: {
    playerCaptionsTracklistRenderer?: PlayerCaptionsTracklistRenderer;
  };
};

function isCaptionTrack(value: unknown): value is CaptionTrack {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as {
    baseUrl?: string;
    languageCode?: string;
    kind?: string;
    name?: { simpleText?: string };
  };

  if (typeof candidate.baseUrl !== "string" || typeof candidate.languageCode !== "string") {
    return false;
  }

  if (candidate.kind !== undefined && typeof candidate.kind !== "string") {
    return false;
  }

  if (candidate.name !== undefined) {
    if (typeof candidate.name !== "object") {
      return false;
    }

    const name = candidate.name as { simpleText?: string };
    if (name.simpleText !== undefined && typeof name.simpleText !== "string") {
      return false;
    }
  }

  return true;
}

function isPlayerResponse(value: unknown): value is PlayerResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const root = value as Record<string, unknown>;
  const { captions } = root;

  if (captions === undefined) {
    return true;
  }

  if (typeof captions !== "object" || captions === null) {
    return false;
  }

  const renderer = (captions as { playerCaptionsTracklistRenderer?: unknown }).playerCaptionsTracklistRenderer;

  if (renderer === undefined) {
    return true;
  }

  if (typeof renderer !== "object" || renderer === null) {
    return false;
  }

  const { captionTracks } = renderer as PlayerCaptionsTracklistRenderer;

  if (captionTracks === undefined) {
    return true;
  }

  if (!Array.isArray(captionTracks)) {
    return false;
  }

  return captionTracks.every(isCaptionTrack);
}

function extractCaptionTracks(html: string): CaptionTrack[] {
  const playerResponseRegex = /ytInitialPlayerResponse\s*=\s*(?<json>\{.*?\});/su;
  const match = playerResponseRegex.exec(html);
  const jsonPayload = (match?.groups as { json?: string } | undefined)?.json;

  if (typeof jsonPayload !== "string") {
    log.warn(LOG_NAMESPACE, "Could not find ytInitialPlayerResponse in HTML");
    return [];
  }

  try {
    const playerResponse = JSON.parse(jsonPayload) as unknown;

    if (!isPlayerResponse(playerResponse)) {
      log.warn(LOG_NAMESPACE, "Unexpected ytInitialPlayerResponse structure");
      return [];
    }

    return playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  } catch (error: unknown) {
    log.error(LOG_NAMESPACE, "Failed to parse caption tracks from HTML", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function pickTrack(tracks: readonly CaptionTrack[], preferLangs: readonly string[]): CaptionTrack | undefined {
  if (tracks.length === 0) {
    return undefined;
  }

  // 1. Exact match
  for (const lang of preferLangs) {
    for (const track of tracks) {
      if (track.languageCode.toLowerCase() === lang.toLowerCase()) {
        return track;
      }
    }
  }

  // 2. Prefix match (e.g., 'en' for 'en-US')
  for (const lang of preferLangs) {
    for (const track of tracks) {
      if (track.languageCode.toLowerCase().startsWith(lang.toLowerCase())) {
        return track;
      }
    }
  }

  // 3. Prefer non-ASR
  const nonAsr = tracks.find((t) => t.kind !== "asr");
  if (nonAsr) {
    return nonAsr;
  }

  // 4. First available
  return tracks[0];
}

function vttToText(vtt: string): string {
  return vtt
    .split("\n")
    .filter((line) => !line.startsWith("WEBVTT") && !line.includes("-->") && line.trim() !== "" && !/^\d+$/u.test(line))
    .map((line) => line.trim())
    .join(" ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function json3ToText(jsonStr: string): string {
  try {
    const data = JSON.parse(jsonStr) as { events?: Array<{ segs?: Array<{ utf8: string }> }> };
    if (!Array.isArray(data.events)) {
      return "";
    }
    return data.events
      .flatMap((event) => {
        if (!Array.isArray(event.segs)) {
          return [];
        }

        return event.segs.map((seg) => seg.utf8);
      })
      .join("")
      .replaceAll("\n", " ")
      .replaceAll(/\s+/gu, " ")
      .trim();
  } catch {
    return "";
  }
}

function xmlToText(xml: string): string {
  return xml
    .split("</text>")
    .map((line) => {
      const match = /<text[^>]*>(?<content>[\s\S]*)/u.exec(line);
      const content = (match?.groups as { content?: string } | undefined)?.content ?? "";
      return content.length > 0 ? he.decode(content) : "";
    })
    .join(" ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

async function downloadAndParseTrack(
  http: HttpClient,
  baseUrl: string
): Promise<{ text: string; source: "json3" | "vtt" | "xml" } | undefined> {
  // Try VTT first
  try {
    const vtt = await http.text(`${baseUrl}&fmt=vtt`);
    const trimmedVtt = vtt.trim();
    if (trimmedVtt.length > 0) {
      return { text: vttToText(vtt), source: "vtt" };
    }
  } catch (error: unknown) {
    log.debug(LOG_NAMESPACE, "VTT download failed, trying next format", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Try JSON3 next
  try {
    const json3 = await http.text(`${baseUrl}&fmt=json3`);
    if (json3.trim().length > 0) {
      return { text: json3ToText(json3), source: "json3" };
    }
  } catch (error: unknown) {
    log.debug(LOG_NAMESPACE, "JSON3 download failed, trying next format", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Try XML last
  try {
    const xml = await http.text(baseUrl);
    if (xml.trim().length > 0) {
      return { text: xmlToText(xml), source: "xml" };
    }
  } catch (error: unknown) {
    log.debug(LOG_NAMESPACE, "XML download failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return undefined;
}

export async function fetchYouTubeTranscript(
  http: HttpClient,
  videoId: string,
  preferLangs: string[]
): Promise<{ text: string; lang?: string; source: "json3" | "vtt" | "xml" } | undefined> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const html = await http.text(watchUrl, { headers: { "Accept-Language": preferLangs.join(",") } });
    const tracks = extractCaptionTracks(html);
    log.debug(LOG_NAMESPACE, "Found caption tracks", { videoId, count: tracks.length });

    const track = pickTrack(tracks, preferLangs);
    if (!track) {
      log.info(LOG_NAMESPACE, "No suitable caption track found", { videoId, preferLangs });
      return undefined;
    }

    log.info(LOG_NAMESPACE, "Selected caption track", { videoId, lang: track.languageCode, kind: track.kind });

    const result = await downloadAndParseTrack(http, track.baseUrl);
    if (result !== undefined) {
      return { ...result, lang: track.languageCode };
    }
  } catch (error: unknown) {
    log.error(LOG_NAMESPACE, "Failed to fetch YouTube transcript", {
      videoId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return undefined;
}

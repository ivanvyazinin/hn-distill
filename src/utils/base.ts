/** Build a site URL that respects Astro's configured base path. */
export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL || "/";
  const normalizedBase = `/${base.split("/").filter(Boolean).join("/")}/`.replace("//", "/");
  const normalizedPath = path.replace(/^\/(?!\/)/u, "");

  return normalizedBase === "/" ? `/${normalizedPath}` : `${normalizedBase}${normalizedPath}`;
}

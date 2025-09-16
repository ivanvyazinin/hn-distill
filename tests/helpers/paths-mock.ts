import { mock } from "bun:test";
import { makeTmpPATHS, makeTmpPathFor } from "./tempfs";

export function mockPaths(
  base: string
): { PATHS: ReturnType<typeof makeTmpPATHS>; pathFor: ReturnType<typeof makeTmpPathFor> } {
  const PATHS = makeTmpPATHS(base);
  const pathFor = makeTmpPathFor(PATHS);
  mock.module("@config/paths", () => ({ PATHS, pathFor }));
  return { PATHS, pathFor };
}

import { mock } from "bun:test";
import { PATHS as realPATHS, pathFor as realPathFor } from "@config/paths";
import { makeTmpPATHS, makeTmpPathFor } from "./tempfs";

export function mockPaths(
  base: string
): { PATHS: ReturnType<typeof makeTmpPATHS>; pathFor: ReturnType<typeof makeTmpPathFor> } {
  const PATHS = makeTmpPATHS(base);
  const pathFor = makeTmpPathFor(PATHS);
  // `mock.module` is process-global and persists across test files, so any key
  // this tmp PATHS omits (e.g. `bench`) would become `undefined` for every
  // later-loaded module. Merge the real config so only the tmp-relevant keys
  // are overridden and the rest keep their real values.
  mock.module("@config/paths", () => ({
    PATHS: { ...realPATHS, ...PATHS },
    pathFor: { ...realPathFor, ...pathFor },
  }));
  return { PATHS, pathFor };
}

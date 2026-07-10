# Repository Guidelines

## Project Structure & Module Organization
- `src/`: Astro site (`pages/`, `components/`, `layouts/`, `styles/`). Pages read JSON from `data/`.
- `scripts/`: Data pipeline in TypeScript (`*.mts`): `fetch-hn.mts` → `summarize.mts` → `aggregate.mts`.
- `config/`: Constants, env parsing (Zod), schemas, paths, language.
- `utils/`: Reusable TS utilities (HTTP, text, tags, dates, logging).
- `tests/`: Bun tests (`*.test.ts`) with helpers in `tests/helpers/`.
- `data/`: Generated outputs kept in repo (except `data/cache/`).
- `public/`, `dist/`: Static assets and build output.

## Build, Test, and Development Commands
- Install: `make install` (uses Bun). Alternative: `bun install`.
- Dev server: `make dev` or `bunx astro dev`.
- Generate data (full): `make run` or `bun run data:all`.
- Quick local sample: `make local-test` (small TOP_N, faster).
- Build/Preview: `make build` / `make preview`.
- Tests: `make test`, coverage: `bun test --coverage`.
- Lint/Typecheck: `make lint` and `make typecheck` (or `bunx eslint .`, `bunx tsc --noEmit`).

## Coding Style & Naming Conventions
- Language: TypeScript (strict). Path aliases: `@utils/*`, `@config/*`, `@scripts/*`.
- Indentation: 2 spaces; no semicolon preference enforced by ESLint rules.
- Filenames: TS/JS in kebab-case; Astro components in PascalCase (e.g., `StorySection.astro`).
- Imports: grouped and alphabetized; prefer named exports; avoid default exports.
- No `console.*` in app code—use `utils/log.ts`. Run `bunx eslint .` before pushing.

## Testing Guidelines
- Runner: Bun (`bun test`). Place tests in `tests/` and name `*.test.ts`.
- Use helpers: `tests/helpers/tempfs.ts` for isolated FS; `tests/helpers/http.ts` to mock HTTP.
- Keep tests deterministic; avoid live network calls; add coverage for new logic.

## Large Implementation Plans
- Before architecture, schema, irreversible API, or multi-component changes, call `advisor` before editing code.
- Split large plans into independently verifiable phases and maintain a `Done / Verified / Deferred` phase matrix.
- Implement only one phase at a time. Do not start the next phase until the current phase passes its verification gate.
- Use an isolated git worktree for changes expected to touch more than 10 files, generated data, or multiple subsystems.
- Never delete or overwrite local/generated data without explicit user confirmation or a verified backup. Prefer temp directories and fixture copies for clean-run tests.
- Keep generated-data untracking separate from application logic so it can be reviewed and committed independently.
- After each phase, run the full test suite, lint changed files, typecheck, `git diff --check`, and a diff stat excluding generated data. Record pre-existing failures separately; do not hide new failures behind them.
- For suspected module or environment pollution, run affected test files in both orders before declaring the issue fixed.
- Before expanding scope, summarize what is done, what was verified, and what remains deferred.
- Keep commits phase-focused. Ask before creating commits unless the user has explicitly authorized them.

## Commit & Pull Request Guidelines
- Conventional prefixes encouraged: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `ci:`. Present-tense, imperative.
- CI creates periodic “hourly data” commits—do not rewrite these.
- PRs: small and focused; include description, linked issues, and screenshots for UI changes. Ensure `make lint typecheck test build` pass locally.

## Security & Configuration Tips
- Copy `.env.example` to `.env`. Key vars: `OPENROUTER_API_KEY` (optional), `SUMMARY_LANG`, `TOP_N`, `MAX_COMMENTS_PER_STORY`, etc. See `config/env.ts`.
- Do not commit secrets; `.env` is gitignored. Build reads from `data/aggregated.json` so site can run without API keys.

# Contributing

Thanks for your interest in contributing! This is a small TypeScript CLI; the bar for contributions is "the code typechecks, the tests pass, and the change does what its commit message says".

## Development setup

```bash
git clone https://github.com/osisdie/framer-exporter.git
cd framer-exporter
npm install
cp .env.example .env       # fill in your own URLs / tokens before running scripts
```

Node ≥ 20.6 is required (the helper scripts use the built-in `process.loadEnvFile`).

## Common tasks

```bash
npm run typecheck          # tsc --noEmit
npm test                   # vitest run
npm run test:watch         # vitest in watch mode
npm run dev -- export <url>  # iterate on the exporter
```

## Project layout

```
src/
├── cli.ts                       # Commander entry
├── commands/{export,serve}.ts   # Orchestration
├── session/browserSession.ts    # Persistent Playwright context
├── crawler/                     # urlDetector, BFS, link extractor, top-up
├── interceptor/                 # AssetStore + route('**/*') handler
├── rewriter/                    # html / css / js URL rewriting
├── output/                      # fileWriter, manifestWriter
└── utils/                       # logger, urlUtils, mimeUtils, retry
scripts/                         # diagnostic + verification helpers
docs/                            # English + 繁中 architecture docs
```

## Pull requests

1. Branch from `main`. Use a descriptive name like `fix/<area>` or `feat/<area>`.
2. Keep changes focused — one PR per logical change.
3. Add or update tests for any pure-function change. Tests live next to source as `*.test.ts`.
4. `npm run typecheck && npm test` must pass locally before pushing.
5. CI runs the same gates on Node 20 and Node 22 — both must be green.

### Commit messages

Conventional-commit style is preferred but not enforced:

- `feat:` for new behavior
- `fix:` for bug fixes
- `chore:` / `docs:` / `refactor:` / `test:` as appropriate

Mention the *why*, not just the *what*. The diff already shows the *what*.

## Reporting issues

Use the issue templates under `.github/ISSUE_TEMPLATE/`. Include:

- The Framer site type (published `*.framer.website`, custom domain, preview URL, etc.)
- The exact CLI invocation
- Output of `npm run typecheck` if it's failing
- Relevant log lines (`LOG_LEVEL=debug` for more detail)

## Code of conduct

Be kind. Disagreements are fine; rudeness is not.

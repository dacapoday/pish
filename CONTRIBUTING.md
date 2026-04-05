# Contributing to pish

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/dacapoday/pish.git
cd pish
npm install
npm run build
npm link    # optional: makes `pish` globally available
```

## Development Workflow

```bash
npm run dev           # Watch mode — auto-recompile on changes
npm run lint          # Lint with Biome
npm run build         # Full build
npm run test:unit     # Quick unit tests (104 tests)
bash test/run_tests.sh fast   # Fast scenario tests (~10s)
bash test/run_tests.sh        # Full test suite
```

## Code Style

- Source code comments in **English**
- Biome handles formatting and linting — run `npm run lint` before committing
- TypeScript strict mode — no `any` types without justification

## Testing

pish has three test layers:

| Layer | Command | What it covers |
|-------|---------|---------------|
| Unit | `npm run test:unit` | OSC parsing, ANSI stripping, recorder, agent RPC, config |
| Fast scenarios | `bash test/run_tests.sh fast` | Shell lifecycle, context, truncation (~10s, no pi needed) |
| Slow scenarios | `bash test/run_tests.sh slow` | Real AI agent, abort, reverse (~2min, needs pi) |

Always run `bash test/run_tests.sh fast` before submitting a PR. The CI pipeline runs this automatically.

## Pull Request Guidelines

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm run lint` and `bash test/run_tests.sh fast`
4. Update documentation if behavior changes (especially `devdocs/SPEC.md`)
5. Open a PR with a clear description

## Architecture

See the [devdocs/](devdocs/) directory for detailed architecture documentation:

- `SPEC.md` — Authoritative design document
- `HOOKS.md` — Shell hook details
- `OBJECTS.md` — Object relationships and lifecycle
- `TIMING.md` — Logical timing analysis

## Reporting Issues

Use [GitHub Issues](https://github.com/dacapoday/pish/issues) with the provided templates. Include:

- pish version (`pish --version`)
- Node.js version, shell type/version, OS
- Debug logs (`PISH_DEBUG=/tmp/pish.log pish`)

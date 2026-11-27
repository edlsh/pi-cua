# Contributing

## Development setup

Use Node.js 22.19.0 or newer and Bun 1.4.5.

```bash
bun install --frozen-lockfile --ignore-scripts
bun run check
```

Dependency lifecycle scripts are not needed for these checks. Commit `bun.lock`
when intentionally updating dependencies.

## Verification

- `bun run typecheck`: strict TypeScript checks, including the Pi host contract (`test/hosts.ts`).
- `bun run test`: mocked unit suite plus real Pi package loading, schema validation, and agent-turn tests.
- `bun run check:package`: verify `npm pack --dry-run` contains only the allowlisted runtime files.
- `bun run check`: runs all three checks above.

On macOS with `CuaDriver.app` installed and Accessibility + Screen Recording granted:

```bash
bun run test:live               # observes a compiled native macOS fixture window
SMOKE_ACT=1 bun run test:live   # also clicks, sets values, types, drags, scrolls, resizes, and uses menus
```

## Releases

Releases are cut by release-please from Conventional Commit messages (`fix:` for patch,
`feat:` for minor while below 1.0). Merging the release PR tags `vX.Y.Z`, creates the
GitHub release, and dispatches `publish.yml` via npm trusted publishing (OIDC) with
provenance. Do not overwrite published versions or move release tags.

# Dependency audit — 2026-07-24

This audit was run locally against the implementation workspace. It did not
use production credentials or contact the production host.

## Applied non-breaking fixes

- `next` and `eslint-config-next` were updated together from `16.2.10` to
  `16.2.11`. This is the latest stable patch reported by the npm registry and
  removes the direct Next.js advisories affecting versions below `16.2.11`.
- The lockfile was refreshed so the ESLint dependency path now resolves
  `brace-expansion` `1.1.16` (and the modern nested path `5.0.8`), removing the
  reported exponential-expansion advisory.
- No forced audit repair, major framework downgrade, or unrelated dependency
  upgrade was used.

## Remaining audit findings

`npm audit` still reports three high-severity entries as one transitive chain:

- `postcss` `8.4.31`, required by Next.js `16.2.11`;
- optional `sharp` `0.34.5`, required by Next.js `16.2.11`;
- `next`, reported as the parent affected package because of those two
  transitive dependencies.

The currently published fixed versions are outside the dependency ranges
declared by Next.js `16.2.11` (`postcss` `8.5.x` and `sharp` `0.35.x`).
Overriding them locally would bypass the framework's tested dependency graph;
`npm audit` proposes a breaking and invalid framework downgrade instead.
They therefore remain documented follow-up risk pending an upstream Next.js
release with compatible fixed transitive versions.

# Dependency audit — refreshed 2026-07-26

This audit was refreshed locally against the unchanged M6 workspace. It used
`npm audit --json`, the installed dependency tree, package metadata, and the
linked GitHub-reviewed advisories. It did not use production credentials,
contact the production host, install a package, or modify either package
manifest.

## Manifest and lock integrity

- No dependency was added, removed, or upgraded by the master upgrade.
- `package-lock.json` remains the pre-existing operator-owned diff. Its SHA-256
  before and after the audit is
  `F2708BB721736AFBB9F3B4FF0FE0464E11BCE9E26E9A8D4B0B1F24C6E6F5591A`.
- All installed lock entries declare a license.
- Two installed packages declare lifecycle installation scripts:
  `sharp@0.34.5` (optional, Apache-2.0, binary availability/build check) and
  `unrs-resolver@1.12.2` (MIT, native resolver postinstall). Both predate this
  work; no lifecycle script was run during this audit.

## Current audit result

`npm audit --json` reports 12 high-severity package entries, 0 critical,
0 moderate, and 0 low. The 12 entries represent two dependency chains:

1. Development/lint chain: direct `eslint@9.39.4` and
   `eslint-config-next@16.2.11`, plus seven transitive entries, reach
   `minimatch@3.1.5` and `brace-expansion@1.1.16`. The current advisory is
   [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg).
   The separate modern path uses `minimatch@10.2.5` and patched
   `brace-expansion@5.0.8`.
2. Runtime/build chain: direct `next@16.2.11` reaches
   `postcss@8.4.31` and optional `sharp@0.34.5`. Current advisories are
   [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93),
   [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q),
   [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849),
   and [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj).

## Reachability and current controls

- ESLint/minimatch runs as development tooling over repository-controlled
  paths; the application does not expose lint/glob input as a public runtime
  API. This reduces runtime reachability but does not remove CI/developer DoS
  risk.
- SanDeal does not accept user-authored CSS for PostCSS processing. CSS inputs
  in the build are repository-controlled. This reduces the documented
  source-map and stringification attack surface but does not make the
  vulnerable transitive version acceptable indefinitely.
- Public product images use the `next/image` component with a passthrough
  loader and `unoptimized`, so they are not sent through the Next image
  optimizer. Generated framework imagery still means the optional sharp/libvips
  chain remains an installed supply-chain risk.
- Remote product fetches remain bounded by public-DNS pinning, redirect,
  response-size, content-encoding, timeout, and MIME checks independently of
  these dependency findings.

## Remediation decision

No automated fix was applied. npm currently proposes incompatible or invalid
changes for this repository: a major ESLint move, an
`eslint-config-next@12.0.4` downgrade, and a `next@9.3.3` downgrade. Transitive
overrides would bypass the tested dependency graph of Next.js 16.2.11 and would
also overwrite the operator-owned lockfile.

Required follow-up is a separately authorized dependency change: re-evaluate a
compatible patched Next.js/ESLint dependency graph, run the full quality and
browser gates, review lifecycle scripts again, and update the lockfile only
with explicit operator ownership.

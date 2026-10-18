---
id: release-001
scope: release
status: in-progress
depends-on: []
---

# Public LingoStack Repository

## objective

Replace `README.md` with a concise Chinese-English public README for LingoStack, add a documented credential-safe release check, and prepare the current feature branch for public release without changing extension behavior.

## context

- `docs/INDEX.md`
- `docs/release/README.md`
- `docs/plan/analysis/lingostack-public-release.md`

## path

- `README.md`
- `VALIDATION.md`
- `scripts/package.mjs`
- `docs/`

## verification

1. README includes aligned Chinese and English product overview, capabilities, unpacked installation and API-key boundary.
2. README does not promise unimplemented ASR, arbitrary-site video support, speaker recognition, MP3 preprocessing or a Chrome Web Store listing.
3. Run a tracked-file credential scan that reports only file paths and pattern classes, never potential secret values.
4. Run extension package generation and verify archive contains the Chrome extension plus installation text only.
5. Commit the task output for independent review.

## follow-up verification

- The release guard recognises only explicit `private-test-key` fixture forms in addition to the existing test placeholders; it still reports paths and rule classes only.
- `pnpm run package` is limited to type checking, production build, credential scan, and archive inspection. `pnpm test` remains the separate full-suite command.


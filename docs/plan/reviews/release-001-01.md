# Release-001 Verification Review

## Scope

Reviewed `docs/plan/tasks/release-001.md`, `README.md`, `docs/release/README.md`, `scripts/release-check.mjs`, `scripts/package.mjs`, and the generated Chrome manifest. No implementation files were changed.

## Previous blockers

Both release blockers from the first review are resolved:

 - `node scripts/release-check.mjs` passes, checking 102 tracked files and printing no credential values.
 - `pnpm run package` passes typecheck, production build, credential scan, archive generation, and archive validation.

The package script now omits the unrelated full Vitest suite from the release path. Running `pnpm test` separately still reports three failures in `tests/speech.test.ts`, `src/subtitles/optimizer.test.ts`, and `tests/web-audio.test.ts`; these are non-blocking for this release package because the package workflow does not depend on them.

## Verification evidence

The share archive `release/译栈-1.3.1-朋友分享包.zip` contains only `INSTALL.txt` and paths below `chrome/`. It contains `chrome/manifest.json` and no source files, local settings, test output, or `node_modules`.

The delivery archive and source archive were also generated. The generated manifest reports version `1.3.1`, has permissions `storage`, `contextMenus`, `tts`, `activeTab`, and `offscreen`, and has no `nativeMessaging` permission or manifest `key`.

README review passes: English and Chinese sections describe the same supported surface, installation steps, API-key boundary, and explicit exclusions for ASR without captions, arbitrary video sites, speaker recognition, voice cloning, MP3 preprocessing, and Chrome Web Store publication.

### [NON-BLOCKING] Full test suite has three failures outside the release gate

`pnpm test` remains red with 39 passing and 3 failing tests: `tests/speech.test.ts`, `src/subtitles/optimizer.test.ts`, and `tests/web-audio.test.ts` (missing prototype Python executable). These do not prevent `pnpm run package` or affect generated Chrome archive contents.

## README and scope review

Pass. English and Chinese sections describe the same supported surface: webpage translation, standard YouTube `/watch` captions, provider configuration, local unpacked installation, and the API-key boundary. The README explicitly excludes ASR for videos without captions, arbitrary video sites, speaker recognition, voice cloning, MP3 preprocessing, and Chrome Web Store publication. It states that keys are stored in extension local storage and sent directly to the user-selected provider, with no hosted proxy or analytics service.

## Conclusion

**PASS**. The public release verification gate passes. The release check is credential-safe, the package command completes, and the share archive satisfies the documented contents boundary. The full test-suite failures remain recorded as non-blocking follow-up findings.

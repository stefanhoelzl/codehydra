# VS Code extensions

Extensions bundled into the embedded IDE. Layout, build and manifest details: `extensions/README.md`.

- Every folder here (`sidekick`, `markdown-review-editor`) is discovered, built and packaged as a `.vsix` at build time by `scripts/build-extensions.ts` (`pnpm build:extensions`, run by `pnpm build`), which writes `dist/extensions/manifest.json`.
- External marketplace extensions would be listed in `extensions/external.json` (`[{ "id", "version" }]`), downloaded by the same script. The file is optional and currently absent: nothing external is bundled.
- Extensions import shared code and types from `src/shared/`; a change there busts the extension build cache.
- Third-party extensions reach the CodeHydra API through the sidekick's exports (`api.d.ts`); see `docs/API.md`.

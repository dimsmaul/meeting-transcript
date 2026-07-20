<!--
Title should follow Conventional Commits, e.g. "fix: ..." / "feat: ...".
The prefix drives automatic versioning on merge to main — see CONTRIBUTING.md.
-->

## What & why

<!-- Brief description of the change and the motivation. -->

## Type (matches the commit prefix)

- [ ] `fix:` — patch
- [ ] `feat:` — minor
- [ ] `feat!:` / breaking — major
- [ ] `chore:` / `docs:` / `refactor:` / `ci:` / `test:` — no release

## Checklist

- [ ] `cargo fmt` clean
- [ ] `cargo clippy --all-targets -- -D warnings` clean
- [ ] Rebuilt WASM and manually loaded the extension (if runtime code changed)
- [ ] If DOM selectors changed: noted which Meet selectors were verified
- [ ] Docs updated (PRD/FEASIBILITY/README) if behavior or architecture changed

## Related issues

<!-- Closes #123 -->

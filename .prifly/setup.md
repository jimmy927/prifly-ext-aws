---
setup:
  - bun install --frozen-lockfile
---

A Bun-only prifly extension: one install, then `bun test`, `bun run typecheck` and
`bun run check` (biome) are the checks.

Outside the worktree the install relies on:
- `bun` on PATH.
- ssh access to github.com. The types package `@prifly/extension-api` is a devDependency
  fetched from `git+ssh://git@github.com/jimmy927/prifly-extension-api.git` at a tag (v0.4.0
  once the plugin branch lands), so the machine's ssh key must reach that private repository.

The committed `bun.lock` arrives with the first plugin branch. Until then this checkout is
still the extension template: its `package.json` names the types as
`link:@prifly/extension-api` and there is no lockfile, so a frozen install of that commit fails.
That commit would need `bun link` run once in prifly's `packages/extension-api` and a plain
`bun install` instead.

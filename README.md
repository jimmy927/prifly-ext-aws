# prifly-ext-template

A minimal prifly extension to start a plugin from: one MCP tool that uses a
connected account, one launch board, one panel, and tests of each against a
fake `api`.

## Start a plugin from it

1. Copy the folder to a repository of its own, beside your prifly checkout:

   ```sh
   cp -r ~/src/prifly/templates/prifly-ext-template ~/src/prifly-ext-<name>
   cd ~/src/prifly-ext-<name> && git init -b main
   ```

2. Rename it: `id`, `name` and `description` in `prifly-extension.json`,
   `name` in `package.json`, and the tool's `template_` prefix in
   `whoami-tool.ts` (a tool name must be unique across every extension).

3. Get the types. They come from `@prifly/extension-api`, prifly's
   `packages/extension-api`. Until it is published, link it once per machine
   from your prifly checkout, then install:

   ```sh
   (cd ~/src/prifly/packages/extension-api && bun link)
   bun install
   ```

   Once it is on npm, replace `"link:@prifly/extension-api"` in
   `package.json` with its version.

4. Commit `bun.lock`. prifly installs a cloned extension's dependencies
   itself, with `bun install --frozen-lockfile --production --ignore-scripts`,
   when it clones it and when an update moves it: what the code imports at
   run time goes under `dependencies`, tooling under `devDependencies`, and
   the lock must match `package.json`. Install scripts (`postinstall` and the
   like, yours and your dependencies') are never run, so pick dependencies
   that work without them.

5. Try it in prifly: link the folder into the extensions folder and enable it
   in the Extensions dialog.

   ```sh
   ln -s ~/src/prifly-ext-<name> ~/.local/share/prifly/extensions/<name>
   ```

   A linked extension is your own checkout: prifly never updates it or
   installs into it.

## Checks

`bun test`, `bun run typecheck` and `bun run check` (biome: 500 lines per
file, 120 per function, cognitive complexity 15, no `any`, no `!`).

## What is where

| File | What it is |
|---|---|
| `prifly-extension.json` | The manifest: `connections` (the accounts it uses and why), a `launch`er and a `panel` |
| `index.ts` | What prifly imports: `activate(api)` registers the tool; `choices`, `launch` and `panel` answer the launcher and the panel |
| `whoami-tool.ts` | The MCP tool, `mcp__prifly__template_whoami`: calls Microsoft Graph through `api.connections.fetch`, so prifly holds the token |
| `things.ts` | The board's items and the session a picked one starts |
| `panel/` | The panel's page; it fetches `api/things`, answered by `panel` in `index.ts` |
| `test/fake-api.ts` | A fake `api` that records what the extension shows, logs and registers, and a fake `api.connections` over a fake token endpoint — copy it as it is |
| `test/index.test.ts` | Tests of the tool, the launcher and the panel against the fakes |

Import prifly's types with `import type`: they are erased, so the host never
needs the package to run the extension. Everything added to the api after
its first version is optional (`api.tools?.register`, `api.connections?.list`):
call it that way, and the extension still loads on an older prifly.

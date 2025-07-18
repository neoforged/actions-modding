# Github Actions for Modding

## Minecraft Asset Caching

These two actions work together to improve the GitHub Actions cache usage for assets.

For improved caching, only a single cache in GitHub is used to cache the assets for all Minecraft versions you
regularly run workflows for. Due to how caches for branches are isolated from each other in GitHub, the
cache needs to be created on your main branch, which is done using a dedicated workflow.

This workflow runs every night to update the cache (if necessary), and can also be triggered manually for testing.
It uses the `neoforged/actions-modding/minecraft-assets-cache/create` action.

In every other workflow on any branch, the assets cache is only ever downloaded. This is done using the
`neoforged/actions-modding/minecraft-assets-cache/use` action, which also sets the environment property for
NFRT to pick up the downloaded asset cache. NFRT will still download missing assets if there is no cache,
or it's for the wrong Minecraft version.

Example Workflow to update the cache:

```yaml
---

name: Minecraft Assets Cache

on:
  schedule:
    - cron: "34 3 * * *" # Update daily
  workflow_dispatch:

jobs:
  update-cache:
    runs-on: ubuntu-latest
    name: Update Assets Cache
    steps:
      - uses: neoforged/actions-modding/minecraft-assets-cache/create@v1
        with:
          minecraft-versions: |
            1.21.1
          minecraft-version-file: gradle.properties
          minecraft-version-regexp: /^\s*minecraft_version\s*=\s*(.+)\s*$/m
```

Example use of the action to pull the assets cache:

```yaml
    steps:
      - name: Setup Minecraft Assets Cache
        uses: neoforged/actions-modding/minecraft-assets-cache/use@v1
    [...]
```

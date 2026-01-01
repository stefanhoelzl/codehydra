# Release Workflow

## Version Format

| Component  | Release               | Development                      |
| ---------- | --------------------- | -------------------------------- |
| App        | `YYYY.MM.DD`          | `{date}-dev.{hash}[-dirty]`      |
| Extensions | `{major}.{commits}.0` | `{major}.{commits}.0-dev.{hash}` |

App version injected via Vite define (`__APP_VERSION__`) and logged on startup.
Extension versions use valid SemVer format (required by VS Code).

The `-dirty` suffix only appears in local dev builds when there are uncommitted changes.

## Triggering a Build

1. Go to **Actions** > **Release**
2. Click **Run workflow**
3. Optionally check "Skip CI status check" to bypass CI gate

Summary and artifacts appear on the workflow run page.

## Artifacts

| Platform | Artifact Name                            |
| -------- | ---------------------------------------- |
| Windows  | `CodeHydra-{version}-win`                |
| Linux    | `CodeHydra-{version}-linux-x64.AppImage` |

## Changing Extension Major Version

To reset the extension version scheme (e.g., after breaking changes):

1. Edit `extensions/<name>/package.json`
2. Change `"version": "1.0.0-placeholder"` to `"version": "2.0.0-placeholder"`
3. Next build will produce `2.{commits}.0`

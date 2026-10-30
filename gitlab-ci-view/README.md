# GitLab CI View

Monitor and control GitLab CI for every GitLab repository in your VS Code workspace.

## Features

- **Compact view** ("GitLab CI" in the activity bar): pipeline → stage → job, 20 pipelines at a time, with "Load more…" for each repository.
- **Repository selection** (`all` or a single repository) and **filters**: current branch / all branches, status, source, and "Only mine".
- **Full view** (editor tab): a pipeline table with Previous/Next navigation, plus pipeline details with **Jobs** and **DAG** tabs (columns by stage, edges based on `needs`).
- **Actions**: run a pipeline (select a branch/tag and enter variables), play a manual job (with variables), retry, cancel, and open in a browser.
- **Job logs**: ANSI colors, collapsible sections, automatic scrolling as new logs arrive, and search.
- **Auto-refresh**: every 10 seconds while pipelines are running, every 60 seconds when idle, and paused when the VS Code window loses focus.
- **Status bar** for the latest pipeline on the checked-out branch, with **notifications** when that pipeline finishes.
- **Global tokens per host**, stored in VS Code SecretStorage and shared across workspaces in the same VS Code environment, or read from a configured token file. Expiration dates are read from GitLab or entered manually, with a "Never expires" option. Warnings appear before expiration.

## Getting started

1. Create a Personal Access Token with the **`api`** scope (GitLab → Preferences → Access tokens).
2. Run **GitLab CI: Set GitLab token…**, select a host, and paste your token. Tokens are saved globally for that host, rather than per workspace. The extension validates the token and reads its expiration date and scopes.
3. Open the **GitLab CI** view in the activity bar.

Repositories are detected from their Git remotes (`origin` takes priority). gitlab.com is recognized automatically. For self-hosted instances, simply set a token for the host or declare the host in the settings.

## Use a token file across workspaces

1. Create a GitLab Personal Access Token with the **`api`** scope.
2. Create a plain-text file outside your repository, for example `~/.config/gitlab/token`. Paste only the raw token into it and save:

   ```text
   glpat-your-token-here
   ```

   Do not use JSON, quotes, or a `TOKEN=` prefix. On macOS/Linux, restrict access with `chmod 600 ~/.config/gitlab/token`.
3. Open the Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux) and run **Preferences: Open User Settings (JSON)**. You can also open **Settings → User**, search for `gitlabCiView.hosts`, and click **Edit in settings.json**. The setting itself includes setup instructions and an example.
4. Add `gitlabCiView.hosts` inside the existing settings object. Replace the example hosts and paths with yours; if `gitlabCiView.hosts` already exists, edit its array instead of adding a duplicate key:

   ```json
   {
     "gitlabCiView.hosts": [
       {
         "host": "gitlab.com",
         "tokenFile": "~/.config/gitlab/token"
       },
       {
         "host": "git.company.vn",
         "tokenFile": "/absolute/path/to/company-token"
       }
     ]
   }
   ```

   Keep only the entries you need. `host` must be the GitLab host name without `https://` or a project path. Include `gitlab.com` explicitly when using a token file for it. For an SSH alias, use the real host in `host` and the alias in `sshAlias`.
5. Open the **GitLab CI** view and run **GitLab CI: Refresh**. When rotating the token, replace the file contents and refresh again.

Each file contains only its host's raw token (for example, `glpat-…`), with optional surrounding whitespace. Use an absolute path or `~/…`. The file is read on the machine running the extension; for Remote SSH, WSL, or Dev Containers, the file must exist in that environment. Workspace settings cannot override host or token-file settings.

`tokenFile` takes precedence over the global SecretStorage token. The extension reads the file for every API request, so replacing its contents takes effect on the next refresh, including after a 401. Missing, unreadable, empty, or multiline files report an error without falling back to a different token. Remove `tokenFile` to use **Set GitLab token…** and SecretStorage again.

File tokens do not supply expiry or username metadata, so expiry warnings and the **Only mine** filter require a token saved through **Set GitLab token…**.

If a token saved in another workspace is unavailable, check that both workspaces use the same VS Code profile/environment and the same host (configure `sshAlias` for SSH aliases). A file can provide a shared source when SecretStorage is unavailable in the current environment.

## Find pipelines by event or tag

- In the tree view, select **Filter pipelines… → Trigger event** to filter by Merge request, Push, Schedule, API, and more.
- Select **Ref scope → Tags (latest pipeline per tag)** to see the latest pipeline for each tag.
- Select **Find branch or tag…** and enter an exact name (for example, `v1.2.3`) to see the pipeline history for that ref. Leave it blank to clear the name filter.
- The full view includes **Trigger event** and **Ref scope** filters, a **Branch or tag name** field, and a **Search ref** button (or press Enter).
- Event labels distinguish `Push · Tag`, `Push · Branch`, `Merge request`, `Run manually · Tag`, and more. The ref name appears next to the pipeline.

Filters are sent to the GitLab API and shared between the tree and full views. According to the [GitLab Pipelines API](https://docs.gitlab.com/api/pipelines/#list-project-pipelines), the Tags scope returns only the latest pipeline per tag; searching by ref name does not have this limitation. Tag/event data is cached separately so auto-refresh does not reload metadata.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `gitlabCiView.hosts` | `[]` | GitLab instances, including gitlab.com when using `tokenFile`: `host`, `apiUrl` (may include a relative URL root), `sshAlias`, `caFile`, `tokenFile`, `rejectUnauthorized`. **Read from User settings only.** See [token file setup](#use-a-token-file-across-workspaces). |
| `gitlabCiView.refresh.activeSeconds` | `10` | Refresh interval while pipelines/jobs are running (minimum 3 seconds). |
| `gitlabCiView.refresh.idleSeconds` | `60` | Refresh interval when idle (minimum 10 seconds). |
| `gitlabCiView.notifications` | `failed` | `off`, `failed`, `all`: notifications for pipelines on the current branch. |
| `gitlabCiView.tokenExpiryWarningDays` | `7` | Number of days before token expiration to show a warning. |
| `gitlabCiView.defaultRefFilter` | `current` | Default branch filter: `current` or `all`. |

Example of a self-hosted instance with a relative URL root and a custom CA:

```json
"gitlabCiView.hosts": [
  { "host": "git.company.vn", "apiUrl": "https://git.company.vn/gitlab", "sshAlias": "gitlab-work", "caFile": "~/certs/company-ca.pem" }
]
```

## Limitations

- Notifications track only the **latest** pipeline on the checked-out branch in each repository.
- The DAG requires the GraphQL API. If GraphQL is disabled on the instance, the DAG shows only stage columns, without `needs` edges.
- Downstream/child pipelines, artifacts, and test reports are not yet displayed.

## Development

Run from the monorepo root:

```sh
pnpm install --frozen-lockfile
pnpm --dir gitlab-ci-view typecheck
pnpm --dir gitlab-ci-view test:coverage
pnpm --dir gitlab-ci-view build
pnpm --dir gitlab-ci-view test:integration
pnpm --dir gitlab-ci-view package
```

In VS Code, select the **GitLab CI View** launch configuration and press F5.
Integration tests create mock GitLab/GitHub workspaces and use a stub client, so no real token is required.
For testing against real GitLab instances (gitlab.com and self-hosted), follow the checklist at the end of the implementation plan.

`@types/vscode` is pinned directly to `1.125.0`, matching `k8s-view`, because `vsce` needs to read
this dependency's semver when packaging; all other dependencies use the workspace catalog.

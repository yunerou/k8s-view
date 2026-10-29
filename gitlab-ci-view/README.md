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
- **Tokens per host**, stored in VS Code SecretStorage. Expiration dates are read from GitLab or entered manually, with a "Never expires" option. Warnings appear before expiration.

## Getting started

1. Create a Personal Access Token with the **`api`** scope (GitLab → Preferences → Access tokens).
2. Run **GitLab CI: Set GitLab token…**, select a host, and paste your token. The extension validates the token and reads its expiration date and scopes.
3. Open the **GitLab CI** view in the activity bar.

Repositories are detected from their Git remotes (`origin` takes priority). gitlab.com is recognized automatically. For self-hosted instances, simply set a token for the host or declare the host in the settings.

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
| `gitlabCiView.hosts` | `[]` | Instances other than gitlab.com: `host`, `apiUrl` (may include a relative URL root), `sshAlias`, `caFile`, `rejectUnauthorized`. **Read from User settings only.** |
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

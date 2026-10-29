# Changelog

All notable changes to K8s View are documented here. The project follows
[Conventional Commits](https://www.conventionalcommits.org/); odd minor versions (0.1.x) are pre-releases,
even minor versions (0.2.x) are stable.


## [0.0.3] Fixed

- Marketplace demo GIFs and documentation links now point to the renamed GitHub repository.

## [0.0.2] - 2026-10-26

### Added

- CPU and memory usage, request, limit and usage/request percentage columns for Pods and Nodes, with numeric
  sorting, threshold colors and warnings for missing resource requests or limits.
- Native **Batch Commands** for selected resources: copy names, delete, rollout restart, scale, suspend, resume,
  trigger CronJobs, cordon and uncordon, with shared confirmation, cancellation and per-resource results.
- Expandable **Related** resources in the details drawer, with live updates and watches released when collapsed.
- Configuration reference and animated walkthroughs in the Marketplace README.

### Changed

- CronJobs and Jobs are now part of the **Workload** view, with updated status icons.
- Resource warnings appear alongside names and can be searched in the table filter.
- The details drawer includes a **Commands** button; command menus adapt to available space and use VS Code
  Quick Pick when needed.

### Fixed

- Column dragging no longer conflicts with the resize handle at the right edge of a header.

## [0.0.1]

### Added

- Table **hotkeys** (off by default, *K8s View: Toggle hotkeys* or the `K8s keys` status bar item): while ON and the
  table is focused they override VS Code keybindings — `1`–`9` favorite views, `v`/`n` view/namespace picker,
  `shift+0` all namespaces, `[`/`]` section, `e`/`shift+e` next/previous row in error, `c` commands, `.` run last,
  `d` details, `y` manifest, `/` filter, `r` refresh, `?` list. Configurable in the new `hotkeys` section of config
  files.
- **Favorite views**: *K8s View: Configure favorite views…* assigns views to slots 1–9 (setting
  `k8sView.views.favorites`), switched to by the table hotkeys `1`–`9`.
- Failing resources stand out: error rows of the table get a red stripe and tint (warnings a yellow stripe), the tree
  shows the reason (e.g. `ArtifactFailed`) before the description, and tree tooltips list condition messages. FluxCD
  Sources and Image automation sections show the Ready message.
- Built-in view **CRDs**: CustomResourceDefinitions grouped by API group with their storage, served, deprecated and
  stored versions (warning when objects are still stored in an old version or a deprecated version is served),
  versions and conditions as children, *List instances* (opens the Single resource kind view for that CRD); and
  APIServices (every group/version the API server serves, availability, backing Service).
- Built-in views **Gateway API** (Gateways with listeners and routes, routes by kind, Envoy Gateway and
  BackendTLS/BackendLB policies, GatewayClasses, ReferenceGrants), **Scaling** (HPA, VPA, KEDA ScaledObjects/ScaledJobs,
  PodDisruptionBudgets), **Node** (*Cordon*, *Uncordon*, *Drain…* asking timeout, ignore DaemonSets, delete emptyDir
  data, force and grace period), **Volume** (PVCs with their PV, StorageClass and the pods mounting them, PVs,
  StorageClasses with their PVs/PVCs, VolumeSnapshots, VolumeAttachments) and **Event** (warnings and all events of the
  namespace, events of cluster-scoped objects, warnings of every namespace; newest first).
- **Single resource kind** view: pick any kind the cluster serves (CRDs, rarely used kinds) and list it; *Edit view
  config* turns it into a custom view file.
- Service view: running **port-forwards** shown as items (open in browser, stop, output); *Port-forward…* in the
  context menu of Services and Pods. **Open in browser** for HTTPRoutes (scheme and port from the parent Gateway's
  listeners) and Ingresses.
- FluxCD HelmRelease: **Show values** and **Show default values**, read from Helm's release Secret.
- Snippets **Find pods by label / annotation…** (results in a picker, then run a command on the pod) and **Containers
  & images in use**; template variable `${namespaceFlag}` (`--namespace=<ns>` or `--all-namespaces`).
- Setting `k8sView.views.hidden` and *Switch view → Show/hide views…* (or the *Hide* button of a view).
- View schema: section `label` (tree label template) and `allNamespaces`; status rules with `summary`, `icon` and
  `color` (CronJob job pods are grey/green/red dots); view `portForwards`; `reverseFieldRef` items may be name strings
  (Pod `$.spec.nodeName` → Node). A view with a single section opens it automatically.

- **Snippets** section in the sidebar (moved out of the Context panel): grouped list, click to run, *Create snippet*
  wizard writing `snippets.json` (user or workspace), *Edit* / *Delete* for your own snippets. Parameters
  `${input:<id>}` are asked when running; last values are offered again.
- Command inputs: `pick` with `fromKind` (pick a resource name of a kind in the namespace) and `prompt` with
  `secret` (masked, never remembered, hidden in confirmation dialogs).
- **Logs** in a colored terminal, streamed from the API server (no kubectl needed): a Pod (every container), a
  container (from the tree or *Logs of container…*), or a whole Deployment / StatefulSet / DaemonSet / ReplicaSet / Job
  (every matching pod, new pods added automatically). Each `pod/container` prefix has its own color; log levels are
  highlighted. Settings `k8sView.logs.tailLines`, `k8sView.logs.timestamps`, `k8sView.logs.highlight`.
- **Decrypt secret**: every key of a Secret base64-decoded in a read-only document that is never saved.
- *Rollout restart* in the context menu of Deployments, StatefulSets and DaemonSets (still a dangerous command) and a
  *Rollout status* command.
- User documentation in `docs/` (usage, custom views, commands & snippets, guidelines).
- Context panel: cluster (context) and namespace side by side, shared by every view; cancellable connection check;
  auto refresh as one row of radio buttons: Pause / Live / 3 s / 5 s / 10 s (the polling interval is at least 3 s). Following the Kubernetes
  extension is a setting (`k8sView.context.followKubernetesExtension`).
- Exec auth plugins run under K8s View's control: in an interactive terminal when you connect without a valid
  credential (device codes, password prompts), in the background with a timeout otherwise.
- Terminal commands and snippets keep their terminal open after the command exits, showing the exit code.
- *Reconnect* in the Context panel signs in again through the exec auth plugin's terminal; a 401 drops the cached
  credential.
- A single sidebar tree shows the selected view; *Switch view* picks it, opens it as a table, edits its JSON or
  creates a custom view. Only the shown view is watched. The `k8sView.layout` setting is gone.
- Built-in views written in the same JSON schema as user views: Workload, CronJob, Config, Service, ServiceAccount
  (Gateways and routes moved from the Service view to the Gateway API view).
- Custom views and commands in JSON (`~/.config/k8s-view/*.json`, `.vscode/k8s-view/*.json`) with IntelliSense,
  `extends` overrides, hot reload and errors in the Problems panel.
- FluxCD and cert-manager presets, enabled automatically when the cluster serves their CRDs.
- Command bindings (`process`, `terminal`, `kubectl`, `vscode`) with inputs, snippets, dangerous-command policy,
  protected contexts and workspace-trust approval.
- Auto refresh through watches with polling fallback; lazy, reference-counted watches.
- Resource table (webview) with sort, filter, grouping, column customization saved back to JSON, bulk commands and a
  details drawer.

### Changed

- Context panel: the cluster dropdown is replaced by a button that shows the full context name (with `cluster · user`)
  and opens the VS Code Quick Pick.
- Table details drawer opens wider (600 px, at most 60 % of the window).

### Fixed

- Table: a section with no resources showed the loading bar forever instead of *No resources.*

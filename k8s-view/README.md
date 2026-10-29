# K8s View

**See your workloads. Follow their pods. Read their logs. Stay in VS Code.**

K8s View brings your Kubernetes resources into a live sidebar and an interactive table. Pick a cluster and
namespace, open a built-in view, and start exploring — no JSON configuration needed.

[**Install from the VS Code Marketplace**](https://marketplace.visualstudio.com/items?itemName=yunerou.k8s-view)
· [Report an issue](https://github.com/yunerou/k8s-view/issues)
· [Vietnamese guide](https://github.com/yunerou/k8s-view/blob/main/k8s-view/docs/README.md)

![Open the Workload table and filter deployments in K8s View](https://raw.githubusercontent.com/yunerou/k8s-view/main/k8s-view/resources/demos/workload-table.gif)

*Recorded in VS Code against a live cluster. Context names are anonymized; sensitive identifiers are blurred.*

## Start with your first workload

1. **Install K8s View.** VS Code also installs its dependency, Microsoft's
   [Kubernetes extension](https://marketplace.visualstudio.com/items?itemName=ms-kubernetes-tools.vscode-kubernetes-tools).
2. **Open K8s View** from the Activity Bar. In **Context**, choose a cluster from your kubeconfig and a namespace.
3. **Expand Workload → Deployments** to see readiness at a glance, then follow a Deployment → ReplicaSet → Pod → container.
4. **Open as table** from the Workload title bar for filtering and sorting. Double-click a row to inspect it;
   right-click for the actions available on that resource.

Prefer the Command Palette? Run **K8s View: Select context…**, then **K8s View: Open as table**.

**You need:** VS Code **1.125 or newer**, a valid kubeconfig and access to a Kubernetes cluster. Have `kubectl`
available for actions such as Describe, Exec and Port-forward. If your cluster uses an authentication plugin
such as `aws`, `kubelogin` or `gke-gcloud-auth-plugin`, that plugin must be available to VS Code too.

## Everyday Kubernetes, a few clicks away

### Find the resource you need

Use the sidebar to navigate relationships, or open the same view as a table when you want to compare resources.

- **Filter by name**, sort by a column, or turn on **column filters** to narrow the list further.
- **Group rows** by kind, namespace, status or a resource label.
- **Choose your columns:** hide, reorder and resize them; use **Save to config** to keep the layout in a view definition.
- **See health at a glance:** readiness counts, status colors, and highlighted warning or error rows.
- **Check CPU and memory** in the Pods and Node tables. Usage requires the cluster's metrics API and permission
  to read it; unavailable values appear as `-`.

Select **Live** for watch updates, choose **3s / 5s / 10s** polling, or **Pause** while you investigate.

### Inspect a workload without losing your place

Double-click a table row to open its details alongside the list:

| Tab | What you can check |
| --- | --- |
| **Overview** | Identity, readiness, age and labels |
| **YAML** | The resource manifest |
| **Events** | Events associated with the resource |
| **Conditions** | Status, reasons and messages reported by Kubernetes or a controller |
| **Related** | Expand related resources, such as a Deployment's ReplicaSets and their Pods |

![Inspect workload conditions and expand related ReplicaSets and Pods](https://raw.githubusercontent.com/yunerou/k8s-view/main/k8s-view/resources/demos/resource-details.gif)

### Read logs from every pod in a workload

Right-click a Deployment, StatefulSet, DaemonSet, ReplicaSet or Job → **Logs (all pods)**.
K8s View streams their logs into one terminal, with a different color for each `pod/container` prefix and
highlighted log levels. New matching pods are picked up automatically during a rollout or scale operation.

For a single Pod, choose **Logs** or **Logs of container…**. Logs stream directly from the Kubernetes API;
they do not require `kubectl`.

![Open color-coded logs from all Pods in a Deployment](https://raw.githubusercontent.com/yunerou/k8s-view/main/k8s-view/resources/demos/multi-pod-logs.gif)

### Run the right action on the right resource

Right-click a resource in the sidebar or table to see its available actions. The selected context and
namespace travel with the action, so you do not have to copy resource names into a terminal.

| When you want to… | Choose… |
| --- | --- |
| Read a manifest or investigate a resource | **Manifest** or **Describe** |
| Open a shell in a running Pod | **Commands… → Exec shell**; choose a container |
| Access a Pod or Service locally | **Port-forward…**; enter `local:remote`, then manage it in the **Service** view |
| Open an application's route | **Open in browser** on supported Ingress or HTTPRoute resources |
| Inspect a Secret | **Decrypt secret**, or reveal/copy a single decoded value on demand |
| Restart or scale workloads | **Rollout restart** or **Scale…**, after enabling the dangerous-command policy |

The table also supports **multi-select** for commands on several resources, including batch actions such as
copying names, restarting workloads and scaling replicas.

## Built-in views for more than Pods

Use **Switch view…** in the View title bar to move between these views. Hide the ones you do not use with
**Show/hide views…**.

| View | Explore |
| --- | --- |
| **Workload** | Deployments, StatefulSets, DaemonSets, ReplicaSets, Pods, CronJobs and Jobs, with their children |
| **Service** | Services and their Pods, Ingress, HTTPRoute and active port-forwards |
| **Config** | ConfigMaps, Secrets and their keys |
| **Node** | Readiness, pressure, capacity, CPU/memory and Pods assigned to each Node |
| **Event** | Warnings and other events, including events for cluster-scoped resources |
| **Volume** | PVCs, PVs, StorageClasses, snapshots, attachments and related resources |
| **Scaling** | HPA, VPA, KEDA and PodDisruptionBudgets, linked to their workloads |
| **ServiceAccount** | ServiceAccounts and the bindings and roles that grant their permissions |
| **Gateway API** | Gateways, routes, policies, GatewayClasses and ReferenceGrants |
| **CRDs** | Custom resource definitions, API versions, conditions and **List instances** |
| **Single resource kind** | Browse any resource kind served by your cluster, including custom resources |

**FluxCD and cert-manager presets appear automatically when their CRDs are present.** Trace Flux resources,
inspect HelmRelease values, or follow Certificates and their related resources. Viewing HelmRelease values
does not require the `helm` CLI. Actions such as `flux reconcile` or `cmctl renew` need their respective CLIs.
Sections for resource kinds absent from your cluster are hidden automatically.

## Make it fit your workflow

The built-in views work on their own. When you want more control, you can add these features gradually.

### Reuse commands with snippets

The **Snippets** section contains commands that follow your selected context or namespace. Start with
**Events**, **Containers & images in use**, or **Find pods by label / annotation…**.

Use **+ → Create snippet…** to save a command through a wizard. Add parameters such as `${input:app}` and
K8s View asks for the value when you run it. You can also offer resource pickers and reuse previous input values.

### Navigate with keyboard shortcuts

Table hotkeys are **off by default**. Click **K8s keys: OFF** in the status bar to enable them while the table
has focus; press `?` for the full list.

| Key | Action |
| --- | --- |
| `/` | Focus the row filter |
| `d` / `y` | Open details / manifest |
| `c` | Open the selected resource's command menu |
| `e` / `Shift+e` | Jump to the next / previous error row |
| `n` / `v` | Pick a namespace / view |
| `[` / `]` | Previous / next section |
| `1`–`9` | Open a configured favorite view |

Set favorites with **K8s View: Configure favorite views…**. Hotkeys override VS Code bindings while active in
the table; typing in a filter still enters text normally.

### Build a view for your team

Choose **Switch view… → Create custom view…** to start with a wizard. JSON view definitions let you choose
resource kinds, columns, status rules, filters and parent–child relationships. Built-in views use the same
format, so you can extend one instead of starting from scratch.

Store definitions in `.vscode/k8s-view/*.json` for a workspace, or `~/.config/k8s-view/*.json` for personal use
across workspaces. JSON files support comments, IntelliSense and validation. Teams can also share definitions
through HTTPS remote configs with command allowlists.

See the [configuration reference](https://github.com/yunerou/k8s-view/blob/main/k8s-view/docs/configuration-reference.md)
for a complete example, settings and command safety rules.

## Stay aware of your cluster

- **Context selection is local to K8s View.** It does not change your kubeconfig's `current-context`. Following
  the Microsoft Kubernetes extension's selection is optional.
- **Dangerous commands are blocked by default.** Set `k8sView.commands.dangerous` to `confirm` if you want to
  review commands such as delete, scale and rollout restart before they run.
- **Protected contexts** can show a red status bar and require confirmation for every command.
- **Secret values stay out of the resource lists** and are displayed only when you explicitly reveal or decode them.

## Need a hand?

| If… | Try… |
| --- | --- |
| No context appears | Check that your kubeconfig is available through `KUBECONFIG`, `~/.kube/config` or the Kubernetes extension's kubeconfig setting. |
| Authentication has expired | Click **Reconnect** in Context. Supported exec-auth plugins can sign in again through an interactive terminal. |
| VS Code cannot find `aws`, `kubectl` or another CLI | Add its containing folder to `k8sView.extraPath`, then reconnect or retry the action. |
| You cannot list namespaces | Type the namespace name directly in the namespace picker. |
| A command is blocked | Check the dangerous-command policy, workspace trust or the remote config's command allowlist. |
| A resource kind is missing | Use **Single resource kind** and check your cluster's installed APIs and your RBAC permissions. |

[Detailed guides in Vietnamese](https://github.com/yunerou/k8s-view/blob/main/k8s-view/docs/README.md)
cover usage, custom views, commands, snippets and remote configuration.

**Enjoying K8s View?** If it saves you time, please
[leave a five-star review on the Marketplace](https://marketplace.visualstudio.com/items?itemName=yunerou.k8s-view&ssr=false#review-details).
Your feedback helps other Kubernetes users discover it. Found a problem or have an idea?
[Open an issue](https://github.com/yunerou/k8s-view/issues).

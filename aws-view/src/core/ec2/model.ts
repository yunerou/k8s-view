export type InstanceState = "pending" | "running" | "stopping" | "stopped" | "shutting-down" | "terminated";
export type SsmPing = "Online" | "ConnectionLost" | "Inactive";
export type InstanceAction = "start" | "stop" | "remote" | "terminal";

export interface Instance {
  readonly id: string;
  /** `Name` tag. */
  readonly name: string | undefined;
  readonly type: string;
  readonly state: InstanceState;
  /** Epoch ms of the last start. */
  readonly launchTime: number | undefined;
  readonly imageId: string | undefined;
  /** EC2 `PlatformDetails`, e.g. "Linux/UNIX". */
  readonly platform: string | undefined;
  readonly tags: Readonly<Record<string, string>>;
  /** `undefined`: not registered with SSM, or not known yet. */
  readonly ssm: SsmPing | undefined;
}

export const INSTANCE_STATES: readonly InstanceState[] = [
  "pending",
  "running",
  "stopping",
  "stopped",
  "shutting-down",
  "terminated",
];

/** Tag that sets the SSH user of an instance for everyone. */
export const SSH_USER_TAG = "aws-view:ssh-user";

export function toInstanceState(value: string | undefined): InstanceState {
  return INSTANCE_STATES.find((s) => s === value) ?? "pending";
}

export function toSsmPing(value: string | undefined): SsmPing | undefined {
  return value === "Online" || value === "ConnectionLost" || value === "Inactive" ? value : undefined;
}

export function instanceLabel(i: Instance): string {
  return i.name || i.id;
}

export function isTransitional(state: InstanceState): boolean {
  return state === "pending" || state === "stopping" || state === "shutting-down";
}

/** Inline actions in the tree; "remote" on a stopped instance starts it first. */
export function instanceActions(i: Instance): InstanceAction[] {
  if (i.state === "stopped") return ["start", "remote"];
  if (i.state === "running") return i.ssm === "Online" ? ["remote", "terminal", "stop"] : ["stop"];
  return [];
}

export function uptimeMs(i: Instance, now: number): number | undefined {
  return i.state === "running" && i.launchTime !== undefined ? Math.max(0, now - i.launchTime) : undefined;
}

export function sshUserTag(i: Instance): string | undefined {
  return i.tags[SSH_USER_TAG]?.trim() || undefined;
}

/** Default login user of common AMIs, from the image name (e.g. `ubuntu/images/…`, `al2023-ami-…`). */
export function guessSshUser(imageName: string | undefined): string {
  const name = (imageName ?? "").toLowerCase();
  if (name.includes("ubuntu")) return "ubuntu";
  if (name.includes("debian")) return "admin";
  return "ec2-user";
}

export function byLabel(a: Instance, b: Instance): number {
  return instanceLabel(a).localeCompare(instanceLabel(b)) || a.id.localeCompare(b.id);
}

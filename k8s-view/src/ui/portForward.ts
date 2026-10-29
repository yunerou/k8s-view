export interface PortForwardRequest {
  readonly context: string;
  /** `pod` or `service`. */
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  /** `8080:80 9090` */
  readonly ports: string;
}

/** Port-forward session shown in the tree (views with `portForwards: true`) and status bar. */
export interface PortForwardInfo {
  readonly id: number;
  readonly request: PortForwardRequest;
  /** `starting`: kubectl has not printed "Forwarding from" yet. */
  readonly state: "starting" | "active";
  readonly localPorts: readonly number[];
  readonly startedAt: number;
}

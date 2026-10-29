/** Columns shared by generated Pod/Node kind views. Built-in JSON views use the same paths. */
export function metricColumns() {
  return (["cpu", "memory"] as const).flatMap((resource) =>
    (["used", "percent", "request", "limit"] as const).map((field) => ({
      id: `${resource}-${field}`,
      title: `${resource === "cpu" ? "CPU" : "Mem"} ${{ used: "Used", percent: "Used/Req %", request: "Request", limit: "Limit" }[field]}`,
      path: `$.resourceMetrics.${resource}.${field}`,
      render: field === "percent" ? "percentage" : resource,
      default: "-",
    })),
  );
}

import type { ReactNode } from "react";
import { Codicon } from "./Codicon";

export function Banner({
  kind,
  children,
}: {
  readonly kind: "warning" | "error" | "info";
  readonly children: ReactNode;
}) {
  return (
    <div className={`banner banner-${kind}`} role={kind === "info" ? "status" : "alert"}>
      <Codicon name={kind} />
      <div className="banner-body">{children}</div>
    </div>
  );
}

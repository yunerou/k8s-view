import type { RefFilterMode } from "../../core/gitlab/model";
import type { HostSetting } from "../../core/remote/remote";
import type { Event } from "../../core/util/Emitter";

export type NotificationMode = "off" | "failed" | "all";

/** Port: typed `gitlabCiView.*` settings with minimum values enforced. */
export abstract class Settings {
  /** Fires when settings change; the argument lists changed keys (without the prefix), e.g. `["hosts"]`. */
  abstract readonly onDidChange: Event<readonly string[]>;
  /** User values only (`application` scope). */
  abstract hosts(): readonly HostSetting[];
  abstract activeRefreshSeconds(): number;
  abstract idleRefreshSeconds(): number;
  abstract notifications(): NotificationMode;
  abstract tokenExpiryWarningDays(): number;
  abstract defaultRefFilter(): RefFilterMode;
}

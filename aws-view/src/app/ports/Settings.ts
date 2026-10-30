import type { TagFilter } from "../../core/ec2/filters";
import type { Event } from "../../core/util/Emitter";

/** Port: typed `awsView.*` settings with defaults and minimum values enforced. */
export abstract class Settings {
  /** Changed keys without the prefix, e.g. `["regions"]`. */
  abstract readonly onDidChange: Event<readonly string[]>;
  abstract regions(): readonly string[];
  abstract defaultTagFilters(): readonly TagFilter[];
  abstract idleReminderEnabled(): boolean;
  abstract idleReminderHours(): number;
  abstract confirmStop(): boolean;
  /** User value only (never from a workspace). */
  abstract awsCliPath(): string;
  /** User value only, `~` expanded. */
  abstract sshConfigPath(): string;
}

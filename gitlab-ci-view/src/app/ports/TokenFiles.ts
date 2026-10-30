import type { Event } from "../../core/util/Emitter";

/** User-configured token files, separate from stored credentials and their metadata. */
export abstract class TokenFiles {
  abstract readonly onDidChange: Event<void>;
  abstract hosts(): readonly string[];
  abstract path(host: string): string | undefined;
  abstract read(host: string): Promise<string>;
}

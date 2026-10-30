import { inject, injectable } from "@needle-di/core";
import { awsErrorMessage } from "../core/aws/errors";
import { type Instance, instanceLabel } from "../core/ec2/model";
import { isCanceled } from "../core/util/errors";
import { InstanceService } from "./InstanceService";
import type { AwsTarget } from "./ports/AwsApi";
import { Notifier } from "./ports/Notifier";
import { Prompter } from "./ports/Prompter";
import { Settings } from "./ports/Settings";

/** User-facing instance actions: confirmation and error reporting around InstanceService. */
@injectable()
export class InstanceActions {
  constructor(
    private readonly instances = inject(InstanceService),
    private readonly settings = inject(Settings),
    private readonly prompter = inject(Prompter),
    private readonly notifier = inject(Notifier),
  ) {}

  async start(i: Instance): Promise<void> {
    await this.report(() => this.instances.start(i.id));
  }

  /** `warning` (e.g. "this window will disconnect") asks even when `confirmStop` is off. */
  async stop(i: Instance, options: { readonly target?: AwsTarget; readonly warning?: string } = {}): Promise<boolean> {
    if (this.settings.confirmStop() || options.warning) {
      const detail = [`${i.id} · ${i.type}`, options.warning].filter(Boolean).join("\n");
      if (!(await this.prompter.confirm(`Stop ${instanceLabel(i)}?`, detail, "Stop"))) return false;
    }
    return this.report(() => this.instances.stop(i.id, options.target));
  }

  async rename(i: Instance): Promise<void> {
    const name = await this.prompter.input({
      title: `Rename ${instanceLabel(i)}`,
      prompt: "Value of the Name tag. Leave empty to remove it.",
      value: i.name ?? "",
      validate: (v) => (v.trim().length > 256 ? "At most 256 characters" : undefined),
    });
    if (name === undefined || name.trim() === (i.name ?? "")) return;
    await this.report(() => this.instances.rename(i.id, name));
  }

  private async report(task: () => Promise<unknown>): Promise<boolean> {
    try {
      await task();
      return true;
    } catch (e) {
      if (!isCanceled(e)) await this.notifier.error(awsErrorMessage(e));
      return false;
    }
  }
}

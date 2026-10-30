import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { cliScript, command, proxyCommand, shQuote } from "../../../src/core/ssh/shell";

describe("shell helpers", () => {
  test("quoting", () => {
    expect(shQuote("it's")).toBe("'it'\\''s'");
    expect(command(["aws", "ssm", "start-session", "--target", "i-1"])).toBe(
      "'aws' 'ssm' 'start-session' '--target' 'i-1'",
    );
  });

  test("cliScript clears inherited keys, exports env and execs the last line", () => {
    expect(cliScript({ AWS_PROFILE: "dev", AWS_REGION: "eu-west-1" }, ["first", "second"])).toBe(
      "unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; export AWS_PROFILE='dev' AWS_REGION='eu-west-1'; first; exec second",
    );
  });

  test("the ProxyCommand runs through ssh's /bin/sh with paths containing spaces, quotes and %", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aws view % it's "));
    const log = join(dir, "calls.log");
    const fakeAws = join(dir, "fake aws");
    await writeFile(
      fakeAws,
      [
        "#!/bin/sh",
        `printf '%s|' "$@" >> "${log}"`,
        `printf 'P=%s R=%s F=%s K=%s\\n' "$AWS_PROFILE" "$AWS_REGION" "$AWS_SHARED_CREDENTIALS_FILE" "$AWS_ACCESS_KEY_ID" >> "${log}"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const credentials = join(dir, "creds file");
    const publicKey = join(dir, "id key.pub");
    const cmd = proxyCommand({
      awsPath: fakeAws,
      env: { AWS_PROFILE: "dev-aws-view", AWS_REGION: "eu-west-1", AWS_SHARED_CREDENTIALS_FILE: credentials },
      publicKeyPath: publicKey,
    });
    // What ssh does: expand %-tokens, then run `/bin/sh -c "exec <command>"`.
    const tokens: Record<string, string> = { "%": "%", h: "i-0abc", r: "ec2-user", p: "22" };
    const expanded = cmd.replace(/%([%hrp])/g, (_, t: string) => tokens[t] ?? "");
    execFileSync("/bin/sh", ["-c", `exec ${expanded}`], { env: { ...process.env, AWS_ACCESS_KEY_ID: "LEAKED" } });
    const env = `P=dev-aws-view R=eu-west-1 F=${credentials} K=`;
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      `ec2-instance-connect|send-ssh-public-key|--instance-id|i-0abc|--instance-os-user|ec2-user|--ssh-public-key|file://${publicKey}|${env}`,
      `ssm|start-session|--target|i-0abc|--document-name|AWS-StartSSHSession|--parameters|portNumber=22|${env}`,
    ]);
  });
});

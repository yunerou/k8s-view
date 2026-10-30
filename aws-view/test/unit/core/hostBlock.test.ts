import { describe, expect, test } from "vitest";
import {
  addInclude,
  hasInclude,
  homeDir,
  includeLine,
  instanceIdFromAuthority,
  remoteAuthority,
  renderHostBlock,
  sshAlias,
  sshPath,
  upsertHostBlock,
} from "../../../src/core/ssh/hostBlock";

const HOME = "/Users/me";
const CONFIG = "/Users/me/.ssh/aws-view.config";
const HEADER = "# Managed by AWS View: changes to this file are overwritten.";

const block = (id: string, user = "ec2-user") =>
  renderHostBlock({
    instanceId: id,
    label: "dev\nbox",
    user,
    identityFiles: ["/Users/me/Library/Application Support/Code/id_ed25519", "~/.ssh/100%.pem"],
    knownHostsFile: "/Users/me/Library/Application Support/Code/known_hosts",
    proxyCommand: "sh -c 'x' aws-view %h %r %p",
  });

describe("host block", () => {
  test("names and paths", () => {
    expect(sshAlias("i-0abc")).toBe("aws-view-i-0abc");
    expect(remoteAuthority("i-0abc")).toBe("ssh-remote+aws-view-i-0abc");
    expect(instanceIdFromAuthority("ssh-remote+aws-view-i-0abc")).toBe("i-0abc");
    expect(instanceIdFromAuthority("ssh-remote+work")).toBeUndefined();
    expect(instanceIdFromAuthority(undefined)).toBeUndefined();
    expect(homeDir("ubuntu")).toBe("/home/ubuntu");
    expect(homeDir("root")).toBe("/root");
    expect(sshPath("/a b/c%d")).toBe('"/a b/c%%d"');
    expect(sshPath("/plain")).toBe("/plain");
  });

  test("renders a Host block", () => {
    expect(block("i-0abc")).toBe(
      [
        "Host aws-view-i-0abc",
        "  # dev box",
        "  HostName i-0abc",
        "  User ec2-user",
        '  IdentityFile "/Users/me/Library/Application Support/Code/id_ed25519"',
        "  IdentityFile ~/.ssh/100%%.pem",
        "  IdentitiesOnly yes",
        '  UserKnownHostsFile "/Users/me/Library/Application Support/Code/known_hosts"',
        "  StrictHostKeyChecking accept-new",
        "  ProxyCommand sh -c 'x' aws-view %h %r %p",
      ].join("\n"),
    );
  });

  test("upsert replaces the block of the same instance and keeps the others", () => {
    const first = upsertHostBlock("", "aws-view-i-1", block("i-1"));
    expect(first).toBe(`${HEADER}\n\n${block("i-1")}\n`);
    const second = upsertHostBlock(first, "aws-view-i-2", block("i-2"));
    const third = upsertHostBlock(second, "aws-view-i-1", block("i-1", "ubuntu"));
    expect(third).toBe(`${HEADER}\n\n${block("i-2")}\n\n${block("i-1", "ubuntu")}\n`);
    expect(upsertHostBlock(third, "aws-view-i-1", block("i-1", "ubuntu"))).toBe(third);
  });

  test("Include detection", () => {
    expect(hasInclude("Include ~/.ssh/aws-view.config\nHost x\n", CONFIG, HOME)).toBe(true);
    expect(hasInclude(`include "${CONFIG}"`, CONFIG, HOME)).toBe(true);
    expect(hasInclude("Include aws-view.config", CONFIG, HOME)).toBe(true);
    expect(hasInclude("Include ~/.ssh/other ~/.ssh/aws-view.config", CONFIG, HOME)).toBe(true);
    expect(hasInclude("# Include ~/.ssh/aws-view.config", CONFIG, HOME)).toBe(false);
    expect(hasInclude("Host x\n  User y\n", CONFIG, HOME)).toBe(false);
    expect(hasInclude("", CONFIG, HOME)).toBe(false);
  });

  test("the Include line goes at the very top and keeps the rest", () => {
    expect(includeLine(CONFIG, HOME)).toBe("Include ~/.ssh/aws-view.config");
    expect(includeLine("/opt/ssh hosts/aws", HOME)).toBe('Include "/opt/ssh hosts/aws"');
    expect(addInclude("Host work\n  User me\n", CONFIG, HOME)).toBe(
      "# Added by AWS View\nInclude ~/.ssh/aws-view.config\n\nHost work\n  User me\n",
    );
    expect(addInclude("", CONFIG, HOME)).toBe("# Added by AWS View\nInclude ~/.ssh/aws-view.config\n\n");
  });
});

describe("SSH configuration edge cases", () => {
  test("a scoped Include does not configure all hosts", () => {
    const scoped = "Host work\n  Include ~/.ssh/aws-view.config\n";
    expect(hasInclude(scoped, CONFIG, HOME)).toBe(false);
    const global = addInclude(scoped, CONFIG, HOME);
    expect(hasInclude(global, CONFIG, HOME)).toBe(true);
    expect(addInclude(global, CONFIG, HOME)).toBe(global);
  });

  test("upsert keeps global options, comments and unrelated hosts", () => {
    const original = "# My options\nServerAliveInterval 60\n\nHost work\n  # Keep this\n  User me\n";
    expect(upsertHostBlock(original, "aws-view-i-1", block("i-1"))).toContain(original.trim());
  });

  test("quotes apostrophes and rejects multiline paths", () => {
    expect(sshPath("/tmp/it's.pem")).toBe('"/tmp/it\'s.pem"');
    expect(() => sshPath("/tmp/key\nProxyCommand evil")).toThrow("one line");
    expect(() =>
      renderHostBlock({
        instanceId: "i-1",
        label: "box",
        user: "root\nProxyCommand evil",
        identityFiles: ["/tmp/key"],
        knownHostsFile: "/tmp/known_hosts",
        proxyCommand: "unused",
      }),
    ).toThrow("SSH user");
  });
});

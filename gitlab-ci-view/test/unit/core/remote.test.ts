import { describe, expect, test } from "vitest";
import { hostTarget, parseRemoteUrl, resolveRepoTarget, resolveTarget } from "../../../src/core/remote/remote";

describe("parseRemoteUrl", () => {
  test.each([
    ["git@gitlab.com:group/project.git", { host: "gitlab.com", path: "group/project" }],
    ["git@gitlab.com:group/sub/deep/project.git", { host: "gitlab.com", path: "group/sub/deep/project" }],
    ["ssh://git@Git.Company.VN:2222/group/project.git", { host: "git.company.vn", path: "group/project" }],
    ["https://gitlab.com/group/project.git", { host: "gitlab.com", path: "group/project" }],
    ["https://oauth2:secret@gitlab.com/group/project/", { host: "gitlab.com", path: "group/project" }],
    [
      "https://git.company.vn:8443/gitlab/group/project.git",
      { host: "git.company.vn", path: "gitlab/group/project", port: 8443 },
    ],
    ["gitlab-work:team/app.git", { host: "gitlab-work", path: "team/app" }],
  ])("%s", (url, expected) => {
    expect(parseRemoteUrl(url)).toEqual(expected);
  });

  test.each(["", "not a url", "file:///tmp/repo", "https://gitlab.com/", "/local/path/repo.git"])(
    "rejects %j",
    (url) => {
      expect(parseRemoteUrl(url)).toBeUndefined();
    },
  );
});

describe("resolveTarget", () => {
  test("gitlab.com is always GitLab", () => {
    expect(resolveTarget({ host: "gitlab.com", path: "g/p" }, [], [])).toEqual({
      host: "gitlab.com",
      apiUrl: "https://gitlab.com",
      projectPath: "g/p",
    });
  });

  test("unknown hosts are ignored unless configured or holding a token", () => {
    const loc = { host: "github.com", path: "a/b" };
    expect(resolveTarget(loc, [], [])).toBeUndefined();
    expect(resolveTarget({ host: "git.company.vn", path: "a/b" }, [], ["git.company.vn"])?.apiUrl).toBe(
      "https://git.company.vn",
    );
  });

  test("ssh alias maps to the configured host and api url", () => {
    const hosts = [{ host: "git.company.vn", apiUrl: "https://git.company.vn/", sshAlias: "gitlab-work" }];
    expect(resolveTarget({ host: "gitlab-work", path: "team/app" }, hosts, [])).toEqual({
      host: "git.company.vn",
      apiUrl: "https://git.company.vn",
      projectPath: "team/app",
    });
  });

  test("relative URL root is stripped from the project path", () => {
    const hosts = [{ host: "git.company.vn", apiUrl: "https://git.company.vn:8443/gitlab" }];
    const loc = parseRemoteUrl("https://git.company.vn:8443/gitlab/group/project.git")!;
    expect(resolveTarget(loc, hosts, [])).toEqual({
      host: "git.company.vn",
      apiUrl: "https://git.company.vn:8443/gitlab",
      projectPath: "group/project",
    });
  });

  test("https remote keeps its port in the default api url", () => {
    const loc = parseRemoteUrl("https://git.company.vn:8443/group/project.git")!;
    expect(resolveTarget(loc, [], ["git.company.vn"])?.apiUrl).toBe("https://git.company.vn:8443");
  });
});

describe("resolveRepoTarget", () => {
  test("prefers origin, then falls back to the first GitLab remote", () => {
    const remotes = [
      { name: "upstream", fetchUrl: "git@gitlab.com:upstream/app.git" },
      { name: "origin", fetchUrl: "git@gitlab.com:me/app.git" },
    ];
    expect(resolveRepoTarget(remotes, [], [])?.projectPath).toBe("me/app");
    const noGitlabOrigin = [
      { name: "origin", fetchUrl: "git@github.com:me/app.git" },
      { name: "gl", pushUrl: "git@gitlab.com:me/app.git" },
    ];
    expect(resolveRepoTarget(noGitlabOrigin, [], [])?.projectPath).toBe("me/app");
    expect(resolveRepoTarget([{ name: "origin" }], [], [])).toBeUndefined();
  });
});

describe("hostTarget", () => {
  test("uses the configured api url or https://host", () => {
    expect(hostTarget("gitlab.com", [])).toEqual({ host: "gitlab.com", apiUrl: "https://gitlab.com" });
    expect(hostTarget("Git.Company.VN", [{ host: "git.company.vn", apiUrl: "https://x.vn/gl/" }])).toEqual({
      host: "git.company.vn",
      apiUrl: "https://x.vn/gl",
    });
  });
});

test("ignores a malformed percent escape in a remote URL", () => {
  expect(parseRemoteUrl("https://gitlab.com/group/%ZZ.git")).toBeUndefined();
});

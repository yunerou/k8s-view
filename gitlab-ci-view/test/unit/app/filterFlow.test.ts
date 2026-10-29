import { beforeEach, describe, expect, test } from "vitest";
import { actionErrorMessage } from "../../../src/app/errors";
import { editFilters } from "../../../src/app/filterFlow";
import { GitLabError } from "../../../src/app/ports/GitLabApi";
import { RepoRegistry } from "../../../src/app/RepoRegistry";
import { RepoSelection } from "../../../src/app/RepoSelection";
import { TokenStore } from "../../../src/app/TokenStore";
import { FakePrompter, FakeRepoSource, FakeSecrets, FakeSettings, FakeState } from "../helpers/fakes";

let selection: RepoSelection;
let prompter: FakePrompter;

beforeEach(() => {
  const state = new FakeState();
  const settings = new FakeSettings();
  selection = new RepoSelection(
    new RepoRegistry(new FakeRepoSource(), settings, new TokenStore(new FakeSecrets(), state)),
    state,
    settings,
  );
  prompter = new FakePrompter();
});

describe("editFilters", () => {
  test("toggles branch scope and 'only mine'", async () => {
    prompter.answers.push("ref", "all");
    await editFilters(prompter, selection);
    prompter.answers.push("mine");
    await editFilters(prompter, selection);
    expect(selection.filters).toEqual({ ref: "all", refName: "", status: "", source: "", mine: true });
  });

  test("picks a status, then reset restores the defaults", async () => {
    prompter.answers.push("status", "failed");
    await editFilters(prompter, selection);
    expect(selection.filters.status).toBe("failed");
    expect(prompter.shown[0]?.items?.[1]).toMatchObject({ description: "any" });
    prompter.answers.push("reset");
    await editFilters(prompter, selection);
    expect(selection.filters).toEqual({ ref: "current", status: "", source: "", mine: false });
  });
});

describe("actionErrorMessage", () => {
  test("explains 403", () => {
    expect(actionErrorMessage(new GitLabError("forbidden", "403 Forbidden", "gitlab.com", 403))).toBe(
      "You do not have permission for this action on the project (403 Forbidden).",
    );
    expect(actionErrorMessage(new Error("boom"))).toBe("boom");
  });
});

test("finds the full history of an exact tag without the current branch filter", async () => {
  prompter.answers.push("refName", " v1.2.3 ");
  await editFilters(prompter, selection);
  expect(selection.filters).toMatchObject({ ref: "all", refName: "v1.2.3" });
});

test("selects tag scope and removes an old exact ref", async () => {
  await selection.setFilters({ ...selection.filters, refName: "main" });
  prompter.answers.push("ref", "tags");
  await editFilters(prompter, selection);
  expect(selection.filters).toMatchObject({ ref: "tags", refName: "" });
});

test("merge request event clears the implicit current branch restriction", async () => {
  prompter.answers.push("source", "merge_request_event");
  await editFilters(prompter, selection);
  expect(selection.filters).toMatchObject({ source: "merge_request_event", ref: "all" });
});

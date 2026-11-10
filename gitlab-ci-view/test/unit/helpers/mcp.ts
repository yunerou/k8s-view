import { vi } from "vitest";
import { McpTools } from "../../../src/app/mcp/McpTools";
import { PipelineService } from "../../../src/app/PipelineService";
import { Poller } from "../../../src/app/Poller";
import { RepoRegistry } from "../../../src/app/RepoRegistry";
import { TokenStore } from "../../../src/app/TokenStore";
import { FakeRepoSource, FakeSecrets, FakeSettings, FakeState, gitRepo } from "./fakes";
import { FakeGitLabApi, rawJob, rawPipeline } from "./gitlab";

export const P = "/projects/team%2Fweb";
export function mcpFixture() {
  const settings = new FakeSettings();
  const source = new FakeRepoSource();
  source.list = [gitRepo("web", "git@gitlab.com:team/web.git")];
  const tokens = new TokenStore(new FakeSecrets(), new FakeState());
  const repos = new RepoRegistry(source, settings, tokens);
  const api = new FakeGitLabApi();
  api
    .route(`GET ${P}/pipelines`, [rawPipeline()])
    .route(`GET ${P}/pipelines/1`, rawPipeline())
    .route(`GET ${P}/pipelines/1/jobs`, [rawJob({ status: "failed" })])
    .route(`GET ${P}/jobs/100`, rawJob())
    .route(`BYTES ${P}/jobs/100/trace`, new TextEncoder().encode("\x1b[31mhello\x1b[0m\nworld\n"));
  const service = new PipelineService(api);
  const confirmer = { confirm: vi.fn(async (_title: string, _detail: string) => true) };
  const poller = new Poller(settings);
  const now = vi.spyOn(poller, "now").mockImplementation(() => {});
  const log = { info: vi.fn((_message: string) => {}) };
  const tools = new McpTools(service, api, repos, confirmer, poller, log);
  return {
    tools,
    api,
    source,
    repos,
    tokens,
    settings,
    confirmer,
    service,
    poller,
    now,
    log,
    dispose() {
      repos.dispose();
      tokens.dispose();
      poller.dispose();
    },
  };
}
export const context = { cwd: "/ws/web", isCancelled: () => false };
export function textResult(result: { content: { text: string }[] }): string {
  return result.content[0]!.text;
}
export function dataResult(result: { content: { text: string }[] }): unknown {
  return JSON.parse(textResult(result));
}

import { errorMessage } from "../core/util/errors";
import { GitLabError } from "./ports/GitLabApi";

export function actionErrorMessage(e: unknown): string {
  if (e instanceof GitLabError && e.kind === "forbidden") {
    return `You do not have permission for this action on the project (${e.message}).`;
  }
  return errorMessage(e);
}

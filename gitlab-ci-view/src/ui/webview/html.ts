import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export type WebviewEntry = "pipeline" | "log";

export function webviewRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, "dist", "webview");
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [webviewRoot(extensionUri)] };
}

/** HTML with strict CSP: `default-src 'none'`, nonce-based scripts, resources only from `dist/webview`. */
export function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  entry: WebviewEntry,
  title: string,
): string {
  const root = webviewRoot(extensionUri);
  const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, file)).toString();
  const nonce = randomBytes(16).toString("base64");
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" id="vscode-codicon-stylesheet" href="${uri("codicon.css")}">
<link rel="stylesheet" href="${uri(`${entry}.css`)}">
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${uri(`${entry}.js`)}"></script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

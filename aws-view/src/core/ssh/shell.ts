/** POSIX single-quoted word. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function command(args: readonly string[]): string {
  return args.map(shQuote).join(" ");
}

/** Static keys inherited from VS Code's environment would override AWS_PROFILE in the AWS CLI. */
const OVERRIDING_VARS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];

/** One-line `sh` script: drop inherited static keys, export `env`, run `lines` (the last one with `exec`). */
export function cliScript(env: Readonly<Record<string, string>>, lines: readonly string[]): string {
  const exports = Object.entries(env).map(([k, v]) => `${k}=${shQuote(v)}`);
  return [
    `unset ${OVERRIDING_VARS.join(" ")}`,
    ...(exports.length > 0 ? [`export ${exports.join(" ")}`] : []),
    ...lines.map((line, i) => (i === lines.length - 1 ? `exec ${line}` : line)),
  ].join("; ");
}

export interface ProxyCommandInput {
  readonly awsPath: string;
  readonly env: Readonly<Record<string, string>>;
  readonly publicKeyPath: string;
}

/**
 * ssh `ProxyCommand`: push the temporary key with EC2 Instance Connect (a failure is ignored, ssh then tries the next
 * IdentityFile), then tunnel ssh through SSM. ssh expands `%`-tokens and runs it as `/bin/sh -c "exec …"`, so the
 * script goes through `sh -c` and receives `%h %r %p` as `$1 $2 $3`.
 */
export function proxyCommand(i: ProxyCommandInput): string {
  const aws = shQuote(i.awsPath);
  const publicKey = shQuote(`file://${i.publicKeyPath}`);
  const script = cliScript(i.env, [
    `${aws} ec2-instance-connect send-ssh-public-key --instance-id "$1" --instance-os-user "$2" --ssh-public-key ${publicKey} >/dev/null 2>&1`,
    `${aws} ssm start-session --target "$1" --document-name AWS-StartSSHSession --parameters "portNumber=$3"`,
  ]);
  return `sh -c ${shQuote(script).replace(/%/g, "%%")} aws-view %h %r %p`;
}

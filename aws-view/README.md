# AWS View

Start and stop your EC2 dev machines and open them in VS Code Remote over AWS Session Manager: no public IP, no open SSH port, no key to copy to the instance.

## Features

- **Profiles from `~/.aws/config`**: access keys, access keys + MFA, assume role (with or without MFA) and AWS SSO. MFA sessions are shared with the AWS CLI, other VS Code windows and the next VS Code start, so you type the code once per session. The status bar shows the time left.
- **Instances view** (activity bar): instances of the selected region with their state and SSM status. Filter by tag, state or name; pin your machines so they come first.
- **Start / Stop** with confirmation; the tree refreshes every 5 seconds while an instance changes state.
- **Open in Remote**: starts the instance if needed, waits until its SSM agent is online, then opens a VS Code Remote - SSH window on it.
- **SSM terminal** as `ssm-user`.
- **Edit tags** in a form, and **Rename** (the `Name` tag). Tags starting with `aws:` are never shown or changed.
- **Reminder to stop** instances that keep running (default after 4 hours), in the Remote window of the instance and for pinned instances.
- **Doctor** checks the AWS CLI, the Session Manager plugin, ssh and the Remote - SSH extension.

## Requirements

- macOS or Linux (Windows is planned).
- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html).
- OpenSSH client and the [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) extension.
- Instances with the SSM agent and an instance profile that has `AmazonSSMManagedInstanceCore`, and a way to reach SSM (NAT, or VPC endpoints `ssm`, `ssmmessages`, `ec2messages`).

Run **AWS View: Run Doctor** to check your machine.

## How Open in Remote works

AWS View writes one host per instance to `~/.ssh/aws-view.config` and, the first time, asks to add `Include ~/.ssh/aws-view.config` at the top of `~/.ssh/config` (a backup is saved as `~/.ssh/config.aws-view.bak`). Each connection:

1. pushes a temporary public key with **EC2 Instance Connect** (valid 60 seconds; Amazon Linux 2/2023 and Ubuntu ship the agent),
2. tunnels ssh through **Session Manager** (`AWS-StartSSHSession`).

If an instance has no Instance Connect agent, use **Set fallback SSH key…** on it and open it again. The SSH user is guessed from the AMI (`ec2-user`, `ubuntu`, `admin`) and remembered; set the tag `aws-view:ssh-user` on an instance to choose it for everyone.

## Minimum IAM permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeImages",
        "ec2:StartInstances",
        "ec2:StopInstances",
        "ec2:CreateTags",
        "ec2:DeleteTags",
        "ec2-instance-connect:SendSSHPublicKey",
        "ssm:DescribeInstanceInformation",
        "ssm:StartSession",
        "ssm:TerminateSession"
      ],
      "Resource": "*"
    }
  ]
}
```

MFA and role profiles also need `sts:GetSessionToken` or `sts:AssumeRole` on the role. Narrow `Resource` and add conditions (for example on an `Owner` tag) as your organisation requires.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `awsView.regions` | `[]` | Regions offered by **Select region** (empty: the profile's region). |
| `awsView.defaultTagFilters` | `[]` | Tag filters applied until you change the filter, e.g. `[{ "key": "Owner", "values": ["alice"] }]`. |
| `awsView.idleReminder.enabled` | `true` | Remind to stop running instances. |
| `awsView.idleReminder.hours` | `4` | Hours of uptime before the reminder. |
| `awsView.confirmStop` | `true` | Ask before stopping an instance. |
| `awsView.awsCliPath` | `"aws"` | AWS CLI v2 executable (user settings only). |
| `awsView.sshConfigPath` | `"~/.ssh/aws-view.config"` | File where AWS View writes its SSH hosts (user settings only). |

## Where things are stored

- Temporary MFA/role credentials: `credentials` in the extension's global storage folder (file mode 600), profile `<profile>-aws-view`. Your `~/.aws` files are never modified.
- Instance Connect key and known hosts: same folder (`id_ed25519`, `known_hosts`).
- Per-instance SSH user, fallback key and pins: VS Code global state.

export interface KeyPair {
  readonly privateKey: string;
  readonly publicKey: string;
}

/** Port: the extension's ssh config file, the Include line in ~/.ssh/config, and the Instance Connect key pair. */
export abstract class SshConfigStore {
  /** known_hosts used for AWS View hosts only. */
  abstract readonly knownHostsFile: string;
  abstract hasInclude(): Promise<boolean>;
  /** Puts the Include line at the top of ~/.ssh/config (after saving a backup). */
  abstract addInclude(): Promise<void>;
  abstract upsertHost(alias: string, block: string): Promise<void>;
  abstract ensureKeyPair(): Promise<KeyPair>;
}

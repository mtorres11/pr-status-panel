// GitHub sign-in through the editor's own providers (github.com and, when set up, GitHub Enterprise): the
// accounts to choose from, the one in use, its API target and login.

import { ApiTarget, apiTargetFor } from "./github";
import type { Auth, AuthAccount, HostUi } from "./ports";
import { TtlCache } from "./ttlCache";
import type { UiStateStore } from "./uiState";

const SCOPES = ["repo", "read:org"];
const GITHUB = "github";
const ENTERPRISE = "github-enterprise";

export interface AccountOption {
  key: string;
  providerId: string;
  account: AuthAccount;
  label: string;
}

/** The signed-in account's API, account key and GitHub login. */
export interface Connection {
  api: ApiTarget;
  key: string;
  viewer: string;
}

/** The stored key of an account: its provider and id. */
export const accountKey = (providerId: string, accountId: string): string => `${providerId}:${accountId}`;

export interface GitHubAuthDeps {
  auth: Auth;
  ui: HostUi;
  uiState: UiStateStore;
  /** The https GitHub Enterprise server, "" when not set up. */
  enterpriseUri: () => string;
  /** The login of the account behind an API target. */
  viewerLogin: (api: ApiTarget) => Promise<string>;
}

export class GitHubAuth {
  private list: AccountOption[] = [];
  private readonly logins = new TtlCache<string>(Infinity);
  /** The last connect found no usable session. */
  needsSignIn = false;
  /** Login of the last connected account. */
  viewer?: string;

  constructor(private readonly deps: GitHubAuthDeps) {}

  get accounts(): AccountOption[] {
    return this.list;
  }

  /** The chosen account, or the first one. */
  current(): AccountOption | undefined {
    const key = this.deps.uiState.get().accountKey;
    return this.list.find((a) => a.key === key) ?? this.list[0];
  }

  /** Reloads the accounts, then returns the current one's API and login (undefined when signed out). */
  async connect(): Promise<Connection | undefined> {
    await this.loadAccounts();
    const acct = this.current();
    const session = acct && (await this.deps.auth.session(acct.providerId, SCOPES, { account: acct.account, silent: true }));
    this.needsSignIn = !session;
    if (!acct || !session) return undefined;
    const enterprise = acct.providerId === ENTERPRISE ? this.deps.enterpriseUri() : undefined;
    const api = apiTargetFor(enterprise, session.accessToken);
    this.viewer = await this.logins.get(acct.key, () => this.deps.viewerLogin(api));
    return { api, key: acct.key, viewer: this.viewer };
  }

  /**
   * Signs in and makes that account the current one: `another` adds an account (asking which GitHub when
   * Enterprise is set up), otherwise it renews the current account's session. True when signed in.
   */
  async signIn(another: boolean): Promise<boolean> {
    const acct = another ? undefined : this.current();
    const providerId = another ? await this.pickProvider() : (acct?.providerId ?? GITHUB);
    if (!providerId) return false;
    try {
      const session = await this.deps.auth.session(providerId, SCOPES, {
        createIfNone: true,
        ...(another ? { clearSessionPreference: true } : { account: acct?.account }),
      });
      if (!session) return false;
      await this.deps.uiState.update({ accountKey: accountKey(providerId, session.account.id) });
      return true;
    } catch (e) {
      this.deps.ui.error(`PR Status: sign-in failed: ${(e as Error).message}`);
      return false;
    }
  }

  private providerIds(): string[] {
    return this.deps.enterpriseUri() ? [GITHUB, ENTERPRISE] : [GITHUB];
  }

  private async pickProvider(): Promise<string | undefined> {
    if (this.providerIds().length === 1) return GITHUB;
    const choices = [
      { label: "github.com", id: GITHUB },
      { label: "GitHub Enterprise", id: ENTERPRISE },
    ];
    return (await this.deps.ui.pick(choices, "Which GitHub?"))?.id;
  }

  private async loadAccounts(): Promise<void> {
    const out: AccountOption[] = [];
    for (const providerId of this.providerIds()) {
      const accounts = await this.deps.auth.accounts(providerId).catch(() => []); // provider not available
      for (const account of accounts)
        out.push({
          key: accountKey(providerId, account.id),
          providerId,
          account,
          label: `${account.label} (${providerId === GITHUB ? "github.com" : "Enterprise"})`,
        });
    }
    this.list = out;
  }
}

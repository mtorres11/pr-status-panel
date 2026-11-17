// Which use case each webview message runs. Messages arrive already parsed (see protocol.ts); the use cases
// check the values again against the extension's own data.

import type { DeployTab } from "./deployTab";
import type { PrActions } from "./prActions";
import type { HostUi } from "./ports";
import type { MessageHandlers } from "./protocol";

export interface RouterTargets {
  panel: {
    /** The webview loaded: send it everything, then refresh. */
    ready(): void;
    refresh(): Promise<void>;
    setState(patch: Record<string, unknown>): Promise<void>;
    signIn(another: boolean): Promise<void>;
  };
  actions: PrActions;
  deploy: Pick<DeployTab, "pickProfile" | "signIn">;
  ui: HostUi;
}

export function messageHandlers({ panel, actions, deploy, ui }: RouterTargets): MessageHandlers {
  return {
    ready: () => panel.ready(),
    refresh: () => panel.refresh(),
    setState: (m) => panel.setState(m.patch),
    copyUrl: (m) => actions.copyUrl(m.prId, m.which),
    copyLinks: (m) => actions.copyLinks(m.ids, m.group, m.format),
    rerun: (m) => actions.rerun(m.prId, m.failedOnly),
    updateBranch: (m) => actions.updateBranch(m.prId, m.method),
    configureJira: (m) => actions.configureJira(m.ticket),
    open: (m) => ui.openUrl(m.url),
    toggleFavorite: (m) => actions.toggleFavorite(m.repo),
    addAccount: () => panel.signIn(true),
    signIn: () => panel.signIn(false),
    openSettings: () => ui.openSettings(""),
    awsProfile: () => deploy.pickProfile(),
    awsSignIn: () => deploy.signIn(),
  };
}

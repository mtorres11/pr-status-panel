// GitHub organization teams: who is in a team (used to explain pending code-owner reviews).

import { ApiTarget, graphql } from "./github";
import { isLogin } from "./validate";

/** A member of an organization team. */
export interface TeamMember {
  login: string;
  name?: string;
}

const TEAM_MEMBERS = `query($org: String!, $slug: String!) {
  organization(login: $org) { team(slug: $slug) { members(first: 100) { nodes { login name } } } }
}`;

const TEAM_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Team members (needs read:org); undefined when the team is hidden from this account or the call fails. */
export async function teamMembers(api: ApiTarget, org: string, slug: string): Promise<TeamMember[] | undefined> {
  if (!isLogin(org) || !TEAM_SLUG_RE.test(slug)) return undefined;
  type Data = { organization: { team: { members: { nodes: { login: string; name: string | null }[] } } | null } | null };
  try {
    const data = await graphql<Data>(api, TEAM_MEMBERS, { org, slug });
    const nodes = data?.organization?.team?.members.nodes;
    return nodes?.map((m) => ({ login: m.login, ...(m.name ? { name: m.name } : {}) }));
  } catch {
    return undefined;
  }
}

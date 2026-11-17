// The footer's credit line, read from the extension's package.json.

import type { About } from "./protocol";
import { asRecord } from "./validate";

/** Author, repository link and version; "" for anything missing. */
export function aboutFrom(packageJson: unknown): About {
  const pkg = asRecord(packageJson);
  const field = (v: unknown, key: string): string =>
    typeof v === "string" ? v : String(asRecord(v)[key] ?? "");
  return {
    author: field(pkg.author, "name"),
    repoUrl: field(pkg.repository, "url").replace(/^git\+/, "").replace(/\.git$/, ""),
    version: typeof pkg.version === "string" ? pkg.version : "",
  };
}

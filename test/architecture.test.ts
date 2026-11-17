// Layering rules: the core never touches VS Code, and every core module is loaded (so coverage sees them all).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
/** The only folder that may talk to VS Code: activation, the view and the port adapters. */
const HOST = "src/host-vscode/";

function files(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name), ext) : e.name.endsWith(ext) ? [join(dir, e.name)] : [],
  );
}

const rel = (f: string) => relative(ROOT, f).split("\\").join("/");

test("only the host layer imports vscode", () => {
  const offenders = files(join(ROOT, "src"), ".ts")
    .map(rel)
    .filter((f) => !f.startsWith(HOST))
    .filter((f) => /from\s+["']vscode["']|require\(\s*["']vscode["']\s*\)/.test(readFileSync(join(ROOT, f), "utf8")));
  assert.deepEqual(offenders, []);
});

test("the core does not reach into the host layer", () => {
  const offenders = files(join(ROOT, "src", "core"), ".ts")
    .map(rel)
    .filter((f) => /from\s+["'][./]*host-vscode/.test(readFileSync(join(ROOT, f), "utf8")));
  assert.deepEqual(offenders, []);
});

test("every core module loads without VS Code", () => {
  const core = files(join(__dirname, "..", "src", "core"), ".js");
  assert.ok(core.length > 20);
  for (const f of core) assert.doesNotThrow(() => require(f), rel(f));
});

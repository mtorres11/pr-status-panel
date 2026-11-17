import { test } from "node:test";
import * as assert from "node:assert/strict";
import { aboutFrom } from "../src/core/about";

test("aboutFrom reads author, repository link and version", () => {
  assert.deepEqual(
    aboutFrom({ author: { name: "Ann" }, repository: { url: "git+https://github.com/o/r.git" }, version: "1.2.3" }),
    { author: "Ann", repoUrl: "https://github.com/o/r", version: "1.2.3" },
  );
  assert.deepEqual(aboutFrom({ author: "Bob", repository: "https://x.io/r" }), { author: "Bob", repoUrl: "https://x.io/r", version: "" });
  assert.deepEqual(aboutFrom(undefined), { author: "", repoUrl: "", version: "" });
});

// Runs read-only AWS CodePipeline commands through the user's own `aws` CLI.
// No shell: arguments go straight to the process. The CLI path, profile and region come only from
// USER settings, so a cloned workspace cannot change what runs or which account is used.

import { execFile } from "child_process";

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 16 * 1024 * 1024;

export interface AwsConfig {
  cliPath: string;
  profile: string;
  region: string;
}

/** Why AWS data is missing: no CLI, not signed in, or another error (with its message). */
export class AwsError extends Error {
  constructor(
    message: string,
    public readonly kind: "nocli" | "signin" | "other",
  ) {
    super(message);
  }
}

const SIGNIN_RE =
  /ExpiredToken|InvalidClientTokenId|UnrecognizedClient|Unable to locate credentials|could not be found|token has expired|SSO session|AccessDenied.*assumed-role/i;

function toError(
  err: { code?: string | number | null; message: string },
  stderr: string,
): AwsError {
  if (err.code === "ENOENT")
    return new AwsError(
      "The AWS CLI was not found. Install it or set PR Status › Aws: Cli Path.",
      "nocli",
    );
  const text = (stderr || err.message)
    .trim()
    .split("\n")
    .slice(-2)
    .join(" ")
    .slice(0, 300);
  return SIGNIN_RE.test(text)
    ? new AwsError(`AWS sign-in needed: ${text}`, "signin")
    : new AwsError(`AWS: ${text}`, "other");
}

/** Runs `aws codepipeline <args> --output json` and parses the result. */
export function codepipeline<T>(cfg: AwsConfig, args: string[]): Promise<T> {
  const full = [
    "codepipeline",
    ...args,
    "--output",
    "json",
    "--region",
    cfg.region,
  ];
  if (cfg.profile) full.push("--profile", cfg.profile);
  return new Promise((resolve, reject) => {
    execFile(
      cfg.cliPath,
      full,
      {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, AWS_PAGER: "" },
      },
      (err, stdout, stderr) => {
        if (err) return reject(toError(err, String(stderr)));
        try {
          resolve(JSON.parse(String(stdout)) as T);
        } catch {
          reject(new AwsError("AWS: could not read the CLI output.", "other"));
        }
      },
    );
  });
}

/** Profiles the CLI knows (names only, never credentials). */
export function listProfiles(cliPath: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      cliPath,
      ["configure", "list-profiles"],
      { timeout: TIMEOUT_MS },
      (err, stdout) => {
        resolve(
          err
            ? []
            : String(stdout)
                .split("\n")
                .map((s) => s.trim())
                .filter((s) => /^[\w.@+-]{1,128}$/.test(s)),
        );
      },
    );
  });
}

import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { assertPublicHostLiteral, assertPublicUrl, isPrivateIp } from "../../lib/ssrf-guard";
import type { ProjectInfo, ProjectSourceEnv, ResolveOptions } from "./prepare.service";

const execFileAsync = promisify(execFile);

/** Validate a credential-free HTTPS Git remote. Keep identity separate from
 * transport so future auth/SSH support can extend this boundary. */
export async function validatePublicGitUrl(raw: string): Promise<string> {
  if (typeof raw !== "string" || raw.length > 2000) throw new Error("Git URL is invalid.");
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error("Enter a valid HTTPS Git URL."); }
  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    url.search || url.hash || !url.pathname || url.pathname === "/"
  ) throw new Error("Use a public HTTPS Git URL without credentials or query parameters.");
  await assertPublicUrl(url.toString());
  return url.toString().replace(/\/$/, "");
}

async function gitCloneArgs(remote: string, checkout: string, branch?: string): Promise<string[]> {
  const url = new URL(remote);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  assertPublicHostLiteral(host);
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("Git host must resolve only to public addresses.");
  }
  const address = addresses[0]?.address;
  if (!address) throw new Error("Git host did not resolve to a public address.");
  const resolveAddress = address.includes(":") ? `[${address}]` : address;
  const resolveHost = host.includes(":") ? `[${host}]` : host;
  const args = ["-c", `http.curloptResolve=${resolveHost}:443:${resolveAddress}`, "-c", "http.followRedirects=false", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "credential.helper=", "clone", "--depth=1", "--no-tags", "--single-branch"];
  if (branch?.trim()) {
    await execFileAsync("git", ["check-ref-format", "--branch", branch.trim()], {
      timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: "1" },
    });
    args.push("--branch", branch.trim());
  }
  args.push("--", remote, checkout);
  return args;
}

export async function resolveFromGitUrl(rawUrl: string, branch: string | undefined, opts: ResolveOptions = {}): Promise<ProjectInfo> {
  const remote = await validatePublicGitUrl(rawUrl);
  const dir = await mkdtemp(join(tmpdir(), "openship-git-url-"));
  const checkout = join(dir, "repo");
  try {
    // Disable redirects and every transport except HTTPS. No credentials or
    // ambient Git config are inherited; the URL stays separate from auth.
    const args = await gitCloneArgs(remote, checkout, branch);
    await execFileAsync("git", args, {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https" },
    });
    const branchResult = await execFileAsync("git", ["-C", checkout, "symbolic-ref", "--short", "HEAD"], {
      timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
    });
    const branchName = branch?.trim() || branchResult.stdout.trim() || "main";
    const { resolveFromLocal } = await import("./local-source");
    const info = await resolveFromLocal(checkout, opts);
    const url = new URL(remote);
    const repoName = url.pathname.split("/").filter(Boolean).at(-1)?.replace(/\.git$/i, "") || url.hostname;
    info.repository.name = repoName;
    info.repository.full_name = `${url.hostname}/${repoName}`;
    info.repository.owner = { login: url.hostname };
    info.repository.private = false;
    info.repository.default_branch = branchName;
    info.repository.selected_branch = branchName;
    info.repository.clone_url = remote;
    info.repository.html_url = remote;
    info.repository.branches = [{ name: branchName }];
    return info;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Git clone failed.";
    throw new Error(message.slice(0, 500));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function resolveSourceEnvFromGitUrl(rawUrl: string, branch: string | undefined, rootDirectory = ""): Promise<ProjectSourceEnv> {
  const remote = await validatePublicGitUrl(rawUrl);
  const dir = await mkdtemp(join(tmpdir(), "openship-git-url-"));
  const checkout = join(dir, "repo");
  try {
    const args = await gitCloneArgs(remote, checkout, branch);
    await execFileAsync("git", args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https" } });
    const { resolveSourceEnvFromLocal } = await import("./local-source");
    return await resolveSourceEnvFromLocal(checkout, rootDirectory);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

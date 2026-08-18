#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_UPSTREAM_REPOSITORY = "earendil-works/pi";
const DEFAULT_GITHUB_API = "https://api.github.com";
const ISSUE_MARKER = "<!-- pi-update-monitor -->";
const LATEST_MARKER_PATTERN = /<!-- pi-update-monitor-latest:([0-9]+\.[0-9]+\.[0-9]+) -->/;

function parseVersion(value, label = "version") {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value || "").trim());
  if (!match) throw new Error(`${label} must be a stable x.y.z version, received: ${value}`);
  return {
    value: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
    parts: match.slice(1).map(Number),
  };
}

export function compareVersions(left, right) {
  const leftParts = parseVersion(left, "left version").parts;
  const rightParts = parseVersion(right, "right version").parts;
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] > rightParts[index] ? 1 : -1;
  }
  return 0;
}

async function requestJson({ url, token, fetchImpl = fetch, method = "GET", body }) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "pi-provider-manager-update-monitor",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`GitHub API returned non-JSON content for ${method} ${url}`);
    }
  }
  if (!response.ok) {
    const detail = data?.message || `${response.status} ${response.statusText}`;
    throw new Error(`GitHub API ${method} ${url} failed: ${detail}`);
  }
  return data;
}

export function evaluateRelease(validatedVersion, release) {
  const validated = parseVersion(validatedVersion, "piValidatedVersion").value;
  if (!release || release.draft || release.prerelease) {
    throw new Error("The latest Pi release response must describe a published stable release.");
  }
  const latest = parseVersion(release.tag_name, "Pi release tag").value;
  if (typeof release.html_url !== "string" || !release.html_url.startsWith("https://github.com/")) {
    throw new Error("The latest Pi release response has no valid GitHub URL.");
  }
  if (typeof release.published_at !== "string" || !release.published_at) {
    throw new Error("The latest Pi release response has no publication time.");
  }

  const comparison = compareVersions(latest, validated);
  return {
    validatedVersion: validated,
    latestVersion: latest,
    state: comparison > 0 ? "update-available" : comparison === 0 ? "current" : "baseline-ahead",
    release: {
      tag: String(release.tag_name),
      url: release.html_url,
      publishedAt: release.published_at,
    },
  };
}

export async function checkPiUpdate({
  validatedVersion,
  upstreamRepository = DEFAULT_UPSTREAM_REPOSITORY,
  githubApi = DEFAULT_GITHUB_API,
  token,
  fetchImpl = fetch,
}) {
  const releaseUrl = `${githubApi.replace(/\/$/, "")}/repos/${upstreamRepository}/releases/latest`;
  const release = await requestJson({ url: releaseUrl, token, fetchImpl });
  return evaluateRelease(validatedVersion, release);
}

export function buildReminderBody({ repository, upstreamRepository = DEFAULT_UPSTREAM_REPOSITORY, status }) {
  const upstreamUrl = `https://github.com/${upstreamRepository}`;
  const releaseTag = encodeURIComponent(status.release.tag);
  const baselineTag = encodeURIComponent(`v${status.validatedVersion}`);
  const docsRoot = `${upstreamUrl}/blob/${releaseTag}/packages/coding-agent/docs`;
  return `${ISSUE_MARKER}
<!-- pi-update-monitor-latest:${status.latestVersion} -->

A newer stable Pi release needs compatibility triage. This is a maintenance reminder, not evidence that compatibility is broken.

| Item | Version |
| --- | --- |
| Validated by Pi Provider Manager | \`${status.validatedVersion}\` |
| Latest stable Pi release | [\`${status.latestVersion}\`](${status.release.url}) |
| Published | \`${status.release.publishedAt}\` |

## Triage

- [ ] Read the [release notes](${status.release.url}) and [compare changes](${upstreamUrl}/compare/${baselineTag}...${releaseTag}).
- [ ] Review the pinned [models](${docsRoot}/models.md), [settings](${docsRoot}/settings.md), and [providers](${docsRoot}/providers.md) documentation.
- [ ] Run the repository's [Pi compatibility checklist](https://github.com/${repository}/blob/main/docs/compatibility.md) with the released Pi version and a temporary \`PI_CODING_AGENT_DIR\`.
- [ ] Record whether config paths, schemas, API identifiers, model fields, thinking levels, settings, or live reload behavior changed.
- [ ] Update \`piValidatedVersion\` only after the checklist passes; open a compatibility PR first if behavior changed.

The monitor only compares release metadata. It never imports Pi code, changes the runtime dependency graph, or advances the compatibility baseline automatically.
`;
}

function issueTitle(status) {
  return `Review Pi ${status.latestVersion} compatibility`;
}

function issueVersion(issue) {
  return issue.body?.match(LATEST_MARKER_PATTERN)?.[1] || null;
}

async function listOpenMonitorIssues({ repository, githubApi, token, fetchImpl }) {
  const root = githubApi.replace(/\/$/, "");
  const matches = [];
  for (let page = 1; page <= 10; page += 1) {
    const issues = await requestJson({
      url: `${root}/repos/${repository}/issues?state=open&per_page=100&page=${page}`,
      token,
      fetchImpl,
    });
    if (!Array.isArray(issues)) throw new Error("GitHub issues response must be an array.");
    matches.push(...issues.filter((issue) => !issue.pull_request && issue.body?.includes(ISSUE_MARKER)));
    if (issues.length < 100) break;
  }
  if (matches.length > 1) throw new Error("More than one open Pi update monitor issue exists; merge or close duplicates manually.");
  return matches;
}

export async function syncReminder({
  repository,
  status,
  token,
  upstreamRepository = DEFAULT_UPSTREAM_REPOSITORY,
  githubApi = DEFAULT_GITHUB_API,
  fetchImpl = fetch,
}) {
  if (!/^[^/]+\/[^/]+$/.test(repository || "")) throw new Error("GITHUB_REPOSITORY must use owner/name format.");
  if (!token) throw new Error("GITHUB_TOKEN is required with --sync-issue.");
  if (status.state === "baseline-ahead") {
    throw new Error("piValidatedVersion is newer than Pi's latest stable release; review the release source and baseline manually.");
  }

  const root = githubApi.replace(/\/$/, "");
  const [existing] = await listOpenMonitorIssues({ repository, githubApi: root, token, fetchImpl });

  if (status.state !== "update-available") {
    if (!existing) return "no-reminder-needed";
    await requestJson({
      url: `${root}/repos/${repository}/issues/${existing.number}/comments`,
      token,
      fetchImpl,
      method: "POST",
      body: { body: `The validated baseline now meets the latest stable Pi release (\`${status.latestVersion}\`). Closing this reminder.` },
    });
    await requestJson({
      url: `${root}/repos/${repository}/issues/${existing.number}`,
      token,
      fetchImpl,
      method: "PATCH",
      body: { state: "closed", state_reason: "completed" },
    });
    return "closed-reminder";
  }

  const body = buildReminderBody({ repository, upstreamRepository, status });
  const title = issueTitle(status);
  if (!existing) {
    const [owner] = repository.split("/");
    await requestJson({
      url: `${root}/repos/${repository}/issues`,
      token,
      fetchImpl,
      method: "POST",
      body: { title, body, labels: ["enhancement"], assignees: [owner] },
    });
    return "created-reminder";
  }

  const previousVersion = issueVersion(existing);
  if (previousVersion === status.latestVersion && existing.title === title && existing.body === body) {
    return "reminder-current";
  }
  await requestJson({
    url: `${root}/repos/${repository}/issues/${existing.number}`,
    token,
    fetchImpl,
    method: "PATCH",
    body: { title, body },
  });
  if (previousVersion !== status.latestVersion) {
    await requestJson({
      url: `${root}/repos/${repository}/issues/${existing.number}/comments`,
      token,
      fetchImpl,
      method: "POST",
      body: { body: `The latest stable Pi release advanced from \`${previousVersion || "unknown"}\` to \`${status.latestVersion}\`; the triage links and checklist above were refreshed.` },
    });
  }
  return "updated-reminder";
}

async function readValidatedVersion() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  return manifest.piValidatedVersion;
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const unknown = argumentsList.filter((argument) => argument !== "--sync-issue");
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown.join(", ")}`);

  const validatedVersion = await readValidatedVersion();
  const status = await checkPiUpdate({
    validatedVersion,
    token: process.env.GITHUB_TOKEN,
  });
  process.stdout.write(
    `Pi compatibility baseline ${status.validatedVersion}; latest stable release ${status.latestVersion}; status ${status.state}.\n`,
  );
  if (status.state === "baseline-ahead") {
    throw new Error("The validated baseline is newer than the latest stable Pi release; refusing to update reminder state.");
  }

  if (argumentsList.includes("--sync-issue")) {
    const action = await syncReminder({
      repository: process.env.GITHUB_REPOSITORY,
      status,
      token: process.env.GITHUB_TOKEN,
    });
    process.stdout.write(`Issue action: ${action}.\n`);
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

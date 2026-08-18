import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReminderBody,
  checkPiUpdate,
  compareVersions,
  evaluateRelease,
  syncReminder,
} from "../scripts/check-pi-update.mjs";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function release(version = "0.85.0") {
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/earendil-works/pi/releases/tag/v${version}`,
    published_at: "2026-08-20T10:00:00Z",
    draft: false,
    prerelease: false,
  };
}

test("compares stable Pi versions without a semver dependency", () => {
  assert.equal(compareVersions("0.84.2", "0.84.2"), 0);
  assert.equal(compareVersions("v0.85.0", "0.84.2"), 1);
  assert.equal(compareVersions("0.84.1", "0.84.2"), -1);
  assert.throws(() => compareVersions("0.85.0-beta.1", "0.84.2"), /stable x\.y\.z/);
});

test("checks only the latest published stable release", async () => {
  const requested = [];
  const status = await checkPiUpdate({
    validatedVersion: "0.84.2",
    githubApi: "https://github.example/api",
    fetchImpl: async (url) => {
      requested.push(url);
      return jsonResponse(release());
    },
  });

  assert.deepEqual(requested, ["https://github.example/api/repos/earendil-works/pi/releases/latest"]);
  assert.equal(status.state, "update-available");
  assert.equal(status.latestVersion, "0.85.0");
  assert.equal(evaluateRelease("0.85.0", release()).state, "current");
  assert.throws(() => evaluateRelease("0.84.2", { ...release(), prerelease: true }), /published stable release/);
});

test("creates one assigned compatibility reminder with pinned triage links", async () => {
  const calls = [];
  const status = evaluateRelease("0.84.2", release());
  const action = await syncReminder({
    repository: "wowayou/pi-provider-manager",
    status,
    token: "test-token",
    githubApi: "https://github.example/api",
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
      if (options.method === "GET") return jsonResponse([]);
      return jsonResponse({ number: 42 }, 201);
    },
  });

  assert.equal(action, "created-reminder");
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /issues\?state=open/);
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(calls[1].body.assignees, ["wowayou"]);
  assert.deepEqual(calls[1].body.labels, ["enhancement"]);
  assert.match(calls[1].body.body, /pi-update-monitor/);
  assert.match(calls[1].body.body, /blob\/v0\.85\.0\/packages\/coding-agent\/docs\/models\.md/);
  assert.match(calls[1].body.body, /never imports Pi code/);
});

test("updates an existing reminder only when the latest release advances", async () => {
  const status = evaluateRelease("0.84.2", release("0.86.0"));
  const existingBody = buildReminderBody({
    repository: "wowayou/pi-provider-manager",
    status: evaluateRelease("0.84.2", release("0.85.0")),
  });
  const calls = [];
  const action = await syncReminder({
    repository: "wowayou/pi-provider-manager",
    status,
    token: "test-token",
    githubApi: "https://github.example/api",
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
      if (options.method === "GET") {
        return jsonResponse([{ number: 9, title: "Review Pi 0.85.0 compatibility", body: existingBody }]);
      }
      return jsonResponse({ ok: true });
    },
  });

  assert.equal(action, "updated-reminder");
  assert.deepEqual(calls.map((call) => call.method), ["GET", "PATCH", "POST"]);
  assert.match(calls[2].body.body, /0\.85\.0.*0\.86\.0/);
});

test("leaves an up-to-date reminder unchanged on repeated runs", async () => {
  const status = evaluateRelease("0.84.2", release("0.85.0"));
  const body = buildReminderBody({ repository: "wowayou/pi-provider-manager", status });
  const calls = [];
  const action = await syncReminder({
    repository: "wowayou/pi-provider-manager",
    status,
    token: "test-token",
    githubApi: "https://github.example/api",
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      return jsonResponse([{ number: 10, title: "Review Pi 0.85.0 compatibility", body }]);
    },
  });

  assert.equal(action, "reminder-current");
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});

test("does not create a reminder when the validated baseline is current", async () => {
  const calls = [];
  const action = await syncReminder({
    repository: "wowayou/pi-provider-manager",
    status: evaluateRelease("0.85.0", release("0.85.0")),
    token: "test-token",
    githubApi: "https://github.example/api",
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      return jsonResponse([]);
    },
  });

  assert.equal(action, "no-reminder-needed");
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});

test("closes the reminder after the validated baseline catches up", async () => {
  const calls = [];
  const action = await syncReminder({
    repository: "wowayou/pi-provider-manager",
    status: evaluateRelease("0.85.0", release("0.85.0")),
    token: "test-token",
    githubApi: "https://github.example/api",
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
      if (options.method === "GET") {
        return jsonResponse([{ number: 12, title: "Review Pi 0.85.0 compatibility", body: "<!-- pi-update-monitor -->" }]);
      }
      return jsonResponse({ ok: true });
    },
  });

  assert.equal(action, "closed-reminder");
  assert.deepEqual(calls.map((call) => call.method), ["GET", "POST", "PATCH"]);
  assert.deepEqual(calls[2].body, { state: "closed", state_reason: "completed" });
});

test("refuses to touch issues when the validated baseline is ahead of releases", async () => {
  let calls = 0;
  await assert.rejects(
    syncReminder({
      repository: "wowayou/pi-provider-manager",
      status: evaluateRelease("0.86.0", release("0.85.0")),
      token: "test-token",
      githubApi: "https://github.example/api",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse([]);
      },
    }),
    /newer than Pi's latest stable release/,
  );
  assert.equal(calls, 0);
});

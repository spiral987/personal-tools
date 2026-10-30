// Read-only smoke checks. Uses only a publishable/anon key and never creates users or sends email.
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {fileURLToPath} from "node:url";

const envPath = fileURLToPath(new URL("../apps/recall/.env.local", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!projectUrl || !publicKey) {
  throw new Error("apps/recall/.env.local にSupabase URLと公開キーを設定してください。");
}
if (publicKey.startsWith("sb_secret_")) throw new Error("この確認に秘密キーは使用できません。");
if (publicKey.split(".").length === 3) {
  const claims = JSON.parse(Buffer.from(publicKey.split(".")[1], "base64url").toString("utf8"));
  assert.equal(claims.role, "anon", "この確認には公開anonキーだけを使用してください。");
}

const report = [];
async function request(path, options = {}) {
  const response = await fetch(new URL(path, projectUrl), {
    ...options,
    headers: {apikey: publicKey, "Content-Type": "application/json", ...options.headers},
    signal: AbortSignal.timeout(15000),
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  return {response, body};
}
function denied(path, response) {
  report.push({endpoint: path, status: response.status, outcome: "anonymous access denied"});
  assert.ok([401, 403].includes(response.status), `${path}: expected access denied; got HTTP ${response.status}`);
}

const settings = await request("/auth/v1/settings");
assert.equal(settings.response.status, 200, "Auth公開設定を取得できませんでした。");
assert.equal(typeof settings.body?.external, "object", "Auth公開設定の応答形式を確認してください。");
report.push({endpoint: "/auth/v1/settings", status: settings.response.status, emailEnabled: settings.body.external.email === true});

const items = await request("/rest/v1/items?select=id&limit=1");
denied("/rest/v1/items", items.response);

const pull = await request("/rest/v1/rpc/pull_sync_changes", {
  method: "POST", body: JSON.stringify({p_cursor: "0", p_limit: 1}),
});
denied("/rest/v1/rpc/pull_sync_changes", pull.response);

// Empty payload cannot mutate data even if authorization is accidentally weakened.
const push = await request("/rest/v1/rpc/apply_sync_operation", {
  method: "POST", body: JSON.stringify({p_operation: {}}),
});
denied("/rest/v1/rpc/apply_sync_operation", push.response);

console.log(JSON.stringify({checks: report.length, passed: true, results: report}, null, 2));

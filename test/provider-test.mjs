import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const quota = await jiti.import(new URL("../quota-providers.ts", import.meta.url).pathname);
const zai = await jiti.import(new URL("../providers/zai.ts", import.meta.url).pathname);
const codex = await jiti.import(new URL("../providers/openai-codex.ts", import.meta.url).pathname);
const copilot = await jiti.import(new URL("../providers/github-copilot.ts", import.meta.url).pathname);

test("provider registry contains one adapter per supported provider", () => {
	assert.deepEqual(quota.quotaProviders.map((provider) => provider.providerId), [
		"zai",
		"openai-codex",
		"github-copilot",
	]);
});

function makeJwt(payload) {
	return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function isolateAgentDir(t) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-quota-test-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	});
	return agentDir;
}

function context(provider, options = {}) {
	return {
		model: { provider, id: "test-model" },
		modelRegistry: {
			getProviderAuth: async () => options.token ? { auth: { apiKey: options.token } } : undefined,
			isUsingOAuth: () => options.oauth === true,
		},
		mode: "tui",
	};
}

test("Z.ai response parses into normalized quota samples", () => {
	const snapshot = zai.parseZaiLimits([
		{ unit: 3, number: 5, usage: 2000, currentValue: 400, percentage: 20, nextResetTime: 1_800_000 },
		{ unit: 6, number: 1, usage: 10000, currentValue: 2000, percentage: 20 },
	], "pro", 1_000_000);
	assert.equal(snapshot.provider, "z.ai");
	assert.deepEqual(snapshot.samples.map(({ label, percent }) => [label, percent]), [["5h", 20], ["1w", 20]]);
});

test("Codex parser labels windows by reported duration and converts reset time", () => {
	const snapshot = codex.parseCodexUsage({
		plan_type: "plus",
		rate_limit: {
			primary_window: { used_percent: 33.4, limit_window_seconds: 18000, reset_at: 2000 },
			secondary_window: { used_percent: 12, limit_window_seconds: 604800, reset_after_seconds: 3600 },
		},
	}, 1_000_000);
	assert.equal(snapshot.provider, "Codex");
	assert.equal(snapshot.level, "plus");
	assert.deepEqual(snapshot.samples.map(({ label, percent, resetMs }) => [label, percent, resetMs]), [
		["5h", 33, 2_000_000],
		["1w", 12, 4_600_000],
	]);
});

test("Codex parser supports window variants and rejects empty quota responses", () => {
	const snapshot = codex.parseCodexUsage({ rateLimit: { primaryWindow: { usedPercent: 77, windowDurationMins: 60 } } });
	assert.equal(snapshot.samples[0].label, "1h");
	assert.throws(() => codex.parseCodexUsage({ rate_limit: {} }), /no quota windows/i);
});

test("GitHub Copilot quota parser shows only AI usage and ignores other quota snapshots", () => {
	const reset = "2026-05-01T00:00:00.000Z";
	const snapshot = copilot.parseCopilotUsage({
		copilot_plan: "individual_pro",
		quota_reset_date_utc: reset,
		quota_snapshots: {
			premium_interactions: { entitlement: 300, remaining: 84, percent_remaining: 28, unlimited: false },
			chat: { entitlement: 200, remaining: 160 },
			completions: { unlimited: true },
		},
	}, 1234);
	assert.equal(snapshot.provider, "GitHub Copilot");
	assert.equal(snapshot.level, "individual_pro");
	assert.deepEqual(snapshot.samples.map(({ label, percent, used, total, resetMs, unlimited }) => ({
		label, percent, used, total, resetMs, unlimited,
	})), [
		{ label: "1mo", percent: 72, used: 216, total: 300, resetMs: Date.parse(reset), unlimited: false },
	]);
	assert.throws(() => copilot.parseCopilotUsage({ quota_snapshots: { chat: { unlimited: true } } }), /no premium interactions quota/i);
});

test("GitHub Copilot adapter tries the undocumented endpoint with active-provider auth", async (t) => {
	isolateAgentDir(t);
	let requested;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		requested = { url, init };
		return new Response(JSON.stringify({
			quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 270 } },
		}), { status: 200 });
	};
	t.after(() => { globalThis.fetch = originalFetch; });

	const snapshot = await quota.fetchCurrentQuota(context("github-copilot", { token: "active-copilot-token" }));
	assert.equal(snapshot.samples[0].percent, 10);
	assert.equal(requested.url, "https://api.github.com/copilot_internal/user");
	assert.equal(requested.init.headers.Authorization, "Bearer active-copilot-token");
	assert.equal(await quota.fetchCurrentQuota(context("github-copilot")), undefined);
});

test("Copilot adapter uses the stored original OAuth token for its undocumented endpoint", async (t) => {
	const agentDir = isolateAgentDir(t);
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
		"github-copilot": { type: "oauth", refresh: "raw-github-oauth-token", access: "copilot-session-token" },
	}));
	const originalFetch = globalThis.fetch;
	let authorization;
	globalThis.fetch = async (_url, init) => {
		authorization = init.headers.Authorization;
		return new Response(JSON.stringify({
			quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 240 } },
		}), { status: 200 });
	};
	t.after(() => { globalThis.fetch = originalFetch; });

	await quota.fetchCurrentQuota(context("github-copilot", { token: "copilot-session-token" }));
	assert.equal(authorization, "Bearer raw-github-oauth-token");
});

test("ChatGPT account id is extracted from Codex OAuth JWT", () => {
	const token = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: " acct-123 " } });
	assert.equal(codex.extractChatGptAccountId(token), "acct-123");
	assert.equal(codex.extractChatGptAccountId("not-a-jwt"), undefined);
});

test("Codex adapter calls ChatGPT usage endpoint with account header only for OAuth", async (t) => {
	const token = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } });
	let requested;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		requested = { url, init };
		return new Response(JSON.stringify({
			rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } },
		}), { status: 200 });
	};
	t.after(() => { globalThis.fetch = originalFetch; });

	const snapshot = await quota.fetchCurrentQuota(context("openai-codex", { token, oauth: true }));
	assert.equal(snapshot.provider, "Codex");
	assert.equal(requested.url, "https://chatgpt.com/backend-api/wham/usage");
	assert.equal(requested.init.headers.Authorization, `Bearer ${token}`);
	assert.equal(requested.init.headers["ChatGPT-Account-Id"], "acct-123");

	requested = undefined;
	assert.equal(await quota.fetchCurrentQuota(context("openai-codex", { token, oauth: false })), undefined);
	assert.equal(requested, undefined);
	assert.equal(await quota.fetchCurrentQuota(context("openai", { token, oauth: true })), undefined);
});

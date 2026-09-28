import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const quota = await jiti.import(new URL("../quota-providers.ts", import.meta.url).pathname);

function makeJwt(payload) {
	return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
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
	const snapshot = quota.parseZaiLimits([
		{ unit: 3, number: 5, usage: 2000, currentValue: 400, percentage: 20, nextResetTime: 1_800_000 },
		{ unit: 6, number: 1, usage: 10000, currentValue: 2000, percentage: 20 },
	], "pro", 1_000_000);
	assert.equal(snapshot.provider, "z.ai");
	assert.deepEqual(snapshot.samples.map(({ label, percent }) => [label, percent]), [["5h", 20], ["1w", 20]]);
});

test("Codex parser labels windows by reported duration and converts reset time", () => {
	const snapshot = quota.parseCodexUsage({
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
	const snapshot = quota.parseCodexUsage({ rateLimit: { primaryWindow: { usedPercent: 77, windowDurationMins: 60 } } });
	assert.equal(snapshot.samples[0].label, "1h");
	assert.throws(() => quota.parseCodexUsage({ rate_limit: {} }), /no quota windows/i);
});

test("ChatGPT account id is extracted from Codex OAuth JWT", () => {
	const token = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: " acct-123 " } });
	assert.equal(quota.extractChatGptAccountId(token), "acct-123");
	assert.equal(quota.extractChatGptAccountId("not-a-jwt"), undefined);
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

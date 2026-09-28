/** Offline integration test for extension lifecycle, footer rendering, and /quota. */
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const themeJs = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js", import.meta.url).pathname;
const themeModule = await jiti.import(themeJs);
themeModule.initTheme("dark");

const tokenPayload = Buffer.from(JSON.stringify({
	"https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
})).toString("base64url");
const token = `header.${tokenPayload}.signature`;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
	assert.equal(init.headers["ChatGPT-Account-Id"], "test-account");
	return new Response(JSON.stringify({
		plan_type: "plus",
		rate_limit: {
			primary_window: { used_percent: 16, limit_window_seconds: 18000, reset_after_seconds: 10800 },
			secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_after_seconds: 590400 },
		},
	}), { status: 200 });
};

try {
	const handlers = new Map();
	const commands = new Map();
	const mockPi = {
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: (name, def) => commands.set(name, def),
	};
	const extension = await jiti.import(new URL("../quota.ts", import.meta.url).pathname);
	let footerFactory;
	const mockTheme = { fg: (_name, text) => text, bold: (text) => text };
	const mockCtx = {
		mode: "tui",
		model: { id: "codex-test", provider: "openai-codex", reasoning: true, contextWindow: 200000 },
		thinkingLevel: "high",
		ui: {
			theme: mockTheme,
			setFooter: (factory) => { footerFactory = factory; },
			notify: (message, type) => { mockCtx.lastNotification = { message, type }; },
		},
		sessionManager: {
			getCwd: () => process.cwd(),
			getSessionName: () => "quota-test",
			getEntries: () => [],
		},
		getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
		modelRegistry: {
			getProviderAuth: async (provider) => provider === "openai-codex" ? { auth: { apiKey: token } } : undefined,
			isUsingOAuth: () => true,
		},
	};

	extension.default(mockPi);
	await handlers.get("session_start")({ reason: "startup" }, mockCtx);
	for (let attempt = 0; attempt < 50 && !footerFactory; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(footerFactory, "session start should install the quota footer");
	const footer = footerFactory({}, mockTheme, {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	});
	const renderedLines = footer.render(120);
	const lines = renderedLines.join("\n");
	assert.match(lines, /Codex/);
	assert.match(lines, /5h 16%/);
	assert.match(lines, /1w 3%/);
	assert.match(renderedLines[0], /Codex/, "quota should use the top footer row");
	assert.match(renderedLines[1], /codex-test.*high/, "quota should appear above model and effort labels");

	// Pi clears extension footers on session rebind; the extension must restore
	// its cached snapshot without needing to wait for a network refresh.
	footerFactory = undefined;
	await handlers.get("session_start")({ reason: "resume" }, mockCtx);
	assert.ok(footerFactory, "session rebind should restore the cached quota footer");

	await commands.get("quota").handler("", mockCtx);
	assert.equal(mockCtx.lastNotification.type, "info");
	assert.match(mockCtx.lastNotification.message, /plan: plus/);
	assert.ok(commands.has("zai-quota"), "legacy command alias remains registered");
	console.log("Codex footer and /quota integration test passed.");
} finally {
	globalThis.fetch = originalFetch;
}

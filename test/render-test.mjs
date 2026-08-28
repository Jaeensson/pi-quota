/**
 * Test harness: loads zai-quota.ts with jiti, drives it with a mocked pi/ctx,
 * runs the real fetch against the Z.ai API, and renders the resulting footer.
 *
 * Usage: node test/render-test.mjs [width]
 */
import { createJiti } from "jiti";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const width = Number(process.argv[2] ?? 100);

// Load the real API key from pi's auth.json (provider "zai").
const auth = JSON.parse(readFileSync(`${homedir()}/.pi/agent/auth.json`, "utf8"));
const realKey = auth?.zai?.key;
if (!realKey) {
	console.error("No zai key in auth.json — cannot run live test.");
	process.exit(1);
}

const jiti = createJiti(import.meta.url);

// Initialize pi's global theme singleton (the built-in FooterComponent reads it).
// (Subpath not exported by the package, so import by file path.)
const themeJs = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js", import.meta.url).pathname;
const themeModule = await jiti.import(themeJs);
themeModule.initTheme("dark");

// Mock of pi's extension API: capture event handlers + registered commands.
// TEST_KEY=none  -> simulate no configured key (must render nothing)
// TEST_KEY=bad   -> simulate a rejected key (401, must render nothing)
const keyMode = process.env.TEST_KEY ?? "real";
const handlers = new Map();
const commands = new Map();
const mockPi = {
	on: (event, handler) => handlers.set(event, handler),
	registerCommand: (name, def) => commands.set(name, def),
	registerTool: () => {},
};

const extension = await jiti.import(new URL("../zai-quota.ts", import.meta.url).pathname);
// Mock ExtensionContext (TUI mode), with real key resolution from auth.json.
let footerFactory = undefined;
const mockTheme = {
	fg: (_name, text) => text,
	bold: (t) => t,
};
const mockCtx = {
	mode: "tui",
	hasUI: true,
	cwd: "/home/rasmus/pi-zai-quota",
	model: { id: "glm-5.3-flash", provider: "zai", reasoning: true, contextWindow: 200000 },
	thinkingLevel: "high",
	ui: {
		theme: mockTheme,
		setFooter: (factory) => {
			footerFactory = factory;
			console.log("[mock] setFooter called:", factory ? "with factory" : "undefined");
		},
		notify: (message, type) => console.log(`[mock notify:${type}] ${message.replaceAll("\n", " | ")}`),
	},
	sessionManager: {
		getCwd: () => "/home/rasmus/pi-zai-quota",
		getSessionName: () => "test-session",
		getEntries: () => [],
	},
	getContextUsage: () => ({ tokens: 42000, contextWindow: 200000, percent: 21 }),
	modelRegistry: {
		// Real resolution path is getProviderAuth(); emulate it with the auth.json value.
		getProviderAuth: async (provider) => {
			if (provider !== "zai") return undefined;
			if (keyMode === "none") return undefined;
			return { auth: { apiKey: keyMode === "bad" ? "invalid-key-for-401-test" : realKey }, source: "auth.json" };
		},
	},
};

extension.default ? extension.default(mockPi) : extension(mockPi);

// Fire session_start and wait for the async activate() to finish.
console.log("=== firing session_start ===");
await handlers.get("session_start")({ reason: "startup" }, mockCtx);
await new Promise((r) => setTimeout(r, 3000)); // wait for fetch

if (!footerFactory) {
	console.error("FAIL: footer factory was not set");
	process.exit(1);
}

// Build the footer like interactive-mode does: factory(tui, theme, footerData).
const footerData = {
	getGitBranch: () => "main",
	// TEST_STATUS=1 simulates another extension publishing a footer status.
	getExtensionStatuses: () => (process.env.TEST_STATUS ? new Map([["mode", "● plan-mode"]]) : new Map()),
	getAvailableProviderCount: () => 2,
	onBranchChange: () => () => {},
};
const component = footerFactory({}, mockTheme, footerData);
const lines = component.render(width);

console.log(`\n=== footer render(width=${width}) ===`);
for (const line of lines) {
	console.log(`|${line}|  (visible width: ${line.replace(/\x1b\[[0-9;]*m/g, "").length})`);
}

// Sanity checks
const last = lines[lines.length - 1];
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const lastPlain = plain(last);
const ok = lastPlain.includes("z.ai") && /\d+h \d+%/.test(lastPlain) && /\d+w \d+%/.test(lastPlain);
console.log(`\nquota present on last line: ${ok ? "PASS" : "FAIL"}`);
console.log(`right-aligned: ${lastPlain.trimEnd().length === lastPlain.length && lastPlain.startsWith(" ") ? "PASS" : "CHECK"}`);

// Also render at a narrow width to check truncation behavior.
console.log(`\n=== footer render(width=40) ===`);
for (const line of component.render(40)) console.log(`|${plain(line)}|`);

// And the /zai-quota detail command.
console.log(`\n=== /zai-quota command ===`);
await commands.get("zai-quota").handler("", mockCtx);

process.exit(ok ? 0 : 1);

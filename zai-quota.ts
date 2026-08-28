/**
 * zai-quota — pi extension
 *
 * Shows Z.ai coding-plan quotas (5-hour rolling window + weekly) in the TUI,
 * right-aligned at the bottom-right corner of the footer. The built-in footer
 * (cwd, tokens, context %, model, ...) is preserved: this extension wraps pi's
 * own FooterComponent and appends the quota, e.g.:
 *
 *   z.ai 5h 16% (3h) · 1w 3% (6d 22h)
 *
 * - Uses the Z.ai API key already configured in pi (provider "zai", see /login).
 *   As a fallback, $ZAI_API_KEY is honored. If no key is available, nothing is
 *   rendered at all.
 * - Quota endpoint (unofficial): GET https://api.z.ai/api/monitor/usage/quota/limit
 *   `limits[]` entries carry `unit` (3 = hours, 6 = weeks), `number`,
 *   `usage` (limit), `currentValue` (used) and `percentage`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PROVIDER_ID = "zai";
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const CACHE_TTL_MS = 60_000; // serve cached data within this window
const MIN_REFRESH_MS = 30_000; // throttle forced refreshes (turn_end etc.)
const IDLE_REFRESH_MS = 5 * 60_000; // periodic refresh while idle
const FETCH_TIMEOUT_MS = 10_000;

/** One entry of the quota/limit response. */
interface QuotaLimit {
	type: string;
	unit: number;
	number: number;
	usage: number;
	currentValue: number;
	remaining: number;
	percentage: number;
	nextResetTime?: number;
}

interface QuotaSample {
	label: string;
	percent: number;
	used: number;
	total: number;
	resetMs?: number;
}

interface QuotaSnapshot {
	fetchedAt: number;
	level?: string;
	samples: QuotaSample[];
}

// ---------------------------------------------------------------------------
// API access
// ---------------------------------------------------------------------------

/** Resolve the Z.ai API key from pi's credential store (provider "zai"). */
async function resolveApiKey(ctx: ExtensionContext): Promise<string | undefined> {
	const fromEnv = process.env.ZAI_API_KEY ?? process.env.Z_AI_API_KEY;
	try {
		const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
		return auth?.auth?.apiKey ?? fromEnv;
	} catch {
		return fromEnv;
	}
}

/**
 * Fetch raw limits from the monitor endpoint. Tries "Bearer <key>" first and
 * falls back to the bare key, mirroring the zai-usage-tracker reference.
 */
async function fetchLimits(apiKey: string): Promise<{ limits: QuotaLimit[]; level?: string }> {
	let lastError: unknown;
	for (const authorization of [`Bearer ${apiKey}`, apiKey]) {
		let response: Response;
		try {
			response = await fetch(QUOTA_URL, {
				headers: { Authorization: authorization, Accept: "application/json" },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
		} catch (error) {
			throw error; // network error — no point retrying the other auth format
		}
		if (response.status === 401) {
			lastError = new Error("401 Unauthorized");
			continue;
		}
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				lastError = new Error(`${response.status} Unauthorized`);
				continue;
			}
			throw new Error(`HTTP ${response.status} from ${QUOTA_URL}`);
		}
		const body = await response.json() as {
			code?: number;
			success?: boolean;
			data?: { limits?: QuotaLimit[]; level?: string };
		};
		if (!Array.isArray(body?.data?.limits)) {
			throw new Error("Unexpected quota response shape");
		}
		return { limits: body.data.limits, level: body.data.level };
	}
	throw lastError ?? new Error("Unauthorized");
}

/** Map unit codes to short labels: 3 = hours, 4 = days, 6 = weeks. */
function unitLabel(limit: QuotaLimit, index: number): string {
	const n = typeof limit.number === "number" ? limit.number : 1;
	if (limit.unit === 3) return `${n}h`;
	if (limit.unit === 4) return `${n}d`;
	if (limit.unit === 6) return `${n}w`;
	// Unknown unit — fall back to observed response order (5h first, weekly second).
	return index === 0 ? "5h" : "1w";
}

function parseLimits(limits: QuotaLimit[], level?: string): QuotaSnapshot {
	const samples: QuotaSample[] = limits.slice(0, 2).map((limit, index) => {
		const percent = typeof limit.percentage === "number"
			? limit.percentage
			: limit.usage > 0
				? (limit.currentValue / limit.usage) * 100
				: 0;
		return {
			label: unitLabel(limit, index),
			percent: Math.max(0, Math.min(100, Math.round(percent))),
			used: limit.currentValue ?? 0,
			total: limit.usage ?? 0,
			resetMs: limit.nextResetTime,
		};
	});
	return { fetchedAt: Date.now(), level, samples };
}

function formatReset(resetMs?: number): string {
	if (!resetMs) return "";
	const ms = resetMs - Date.now();
	if (ms <= 0) return ", resetting now";
	const minutes = Math.round(ms / 60_000);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	if (days > 0) return `, resets in ${days}d ${hours % 24}h`;
	if (hours > 0) return `, resets in ${hours}h ${minutes % 60}m`;
	return `, resets in ${Math.max(1, minutes)}m`;
}

/** Short reset countdown for the footer: "37m", "4h" or "6d 22h". Empty when unknown/expired. */
function shortReset(resetMs?: number): string {
	if (!resetMs) return "";
	const minutes = Math.round((resetMs - Date.now()) / 60_000);
	if (minutes < 1) return "";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	const days = Math.floor(hours / 24);
	return days >= 1 ? `${days}d ${hours % 24}h` : `${hours}h`;
}

// ---------------------------------------------------------------------------
// Footer rendering
// ---------------------------------------------------------------------------

/** Color a "5h 16% (3h)" chunk: percentages by fullness, countdown dim. */
function formatSample(sample: QuotaSample, theme: any): string {
	const text = `${sample.label} ${sample.percent}%`;
	const colored = sample.percent >= 90
		? theme.fg("error", text)
		: sample.percent >= 70
			? theme.fg("warning", text)
			: text;
	const reset = shortReset(sample.resetMs);
	return reset ? colored + theme.fg("dim", ` (${reset})`) : colored;
}

function quotaText(snapshot: QuotaSnapshot | undefined, theme: any): string | undefined {
	if (!snapshot || snapshot.samples.length === 0) return undefined;
	const prefix = theme.fg("dim", "z.ai ");
	const parts = snapshot.samples.map((sample) => formatSample(sample, theme));
	return prefix + parts.join(theme.fg("dim", " · "));
}

/** Right-align `text` onto the footer's last line when it fits, else add a new line. */
function appendRight(lines: string[], text: string, width: number): void {
	const textWidth = visibleWidth(text);
	const rightAligned = " ".repeat(Math.max(0, width - textWidth)) + text;
	if (lines.length === 0) {
		lines.push(truncateToWidth(rightAligned, width));
		return;
	}
	const last = lines[lines.length - 1];
	const free = width - visibleWidth(last) - textWidth;
	if (free >= 2) {
		lines[lines.length - 1] = last + " ".repeat(free) + text;
	} else {
		lines.push(truncateToWidth(rightAligned, width));
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let apiKey: string | undefined;
	let unauthorized = false; // key rejected by the API — stop fetching/rendering
	let snapshot: QuotaSnapshot | undefined;
	let lastFetchAt = 0;
	let inFlight: Promise<void> | undefined;
	let footerSet = false;
	let idleTimer: ReturnType<typeof setInterval> | undefined;

	/** Wrap pi's built-in footer and append the quota at the bottom right. */
	function updateFooter(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || footerSet) return;
		if (!snapshot || snapshot.samples.length === 0) return;

		// Structural shim for the parts of AgentSession FooterComponent reads.
		const sessionShim = {
			get state() {
				return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
			},
			sessionManager: ctx.sessionManager,
			getContextUsage: () => ctx.getContextUsage(),
			modelRuntime: { isUsingSubscription: () => false },
		};

		ctx.ui.setFooter((_tui, _theme, footerData) => {
			const builtIn = new FooterComponent(sessionShim as never, footerData);
			return {
				invalidate: () => builtIn.invalidate(),
				dispose: () => builtIn.dispose(),
				render(width: number): string[] {
					const lines = [...builtIn.render(width)];
					const text = quotaText(snapshot, ctx.ui.theme);
					if (text) appendRight(lines, text, width);
					return lines;
				},
			};
		});
		footerSet = true;
	}

	function removeFooter(ctx: ExtensionContext): void {
		if (!footerSet) return;
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
		footerSet = false;
	}

	function startIdleTimer(ctx: ExtensionContext): void {
		stopIdleTimer();
		idleTimer = setInterval(() => {
			void refresh(ctx, true);
		}, IDLE_REFRESH_MS);
		(idleTimer as unknown as { unref?: () => void })?.unref?.();
	}

	function stopIdleTimer(): void {
		if (idleTimer) {
			clearInterval(idleTimer);
			idleTimer = undefined;
		}
	}

	/** Fetch quotas and update the footer. `force` bypasses the cache TTL (throttled). */
	async function refresh(ctx: ExtensionContext, force = false): Promise<void> {
		if (!apiKey || unauthorized) return;
		const now = Date.now();
		if (inFlight) return inFlight;
		if (!force && now - lastFetchAt < CACHE_TTL_MS) return;
		if (force && now - lastFetchAt < MIN_REFRESH_MS) return;

		inFlight = (async () => {
			try {
				const { limits, level } = await fetchLimits(apiKey!);
				snapshot = parseLimits(limits, level);
				updateFooter(ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("401") || /unauthorized/i.test(message)) {
					// Key exists but is not valid — render nothing.
					unauthorized = true;
					removeFooter(ctx);
				}
				// Other errors (offline, 5xx): keep last snapshot, retry on next trigger.
			} finally {
				lastFetchAt = Date.now();
				inFlight = undefined;
			}
		})();
		return inFlight;
	}

	/** Begin: resolve key, fetch quotas, start periodic refresh. TUI only. */
	function activate(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		footerSet = false; // pi clears extension footers when sessions are rebound
		void (async () => {
			apiKey = await resolveApiKey(ctx);
			if (!apiKey) return; // no key configured — render nothing
			unauthorized = false;
			await refresh(ctx, true);
			startIdleTimer(ctx);
		})();
	}

	pi.on("session_start", (_event, ctx) => {
		activate(ctx);
	});

	// Quota usage changes after each LLM turn — refresh (throttled).
	pi.on("turn_end", (_event, ctx) => {
		void refresh(ctx, true);
	});

	pi.on("session_shutdown", () => {
		stopIdleTimer();
	});

	pi.registerCommand("zai-quota", {
		description: "Show detailed Z.ai quota usage",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
			if (!apiKey) apiKey = await resolveApiKey(ctx);
			if (!apiKey) {
				ctx.ui.notify("No Z.ai API key configured (provider 'zai').", "warning");
				return;
			}
			unauthorized = false;
			lastFetchAt = 0; // always fetch fresh data for the detail view
			await refresh(ctx, true);
			if (!snapshot || snapshot.samples.length === 0) {
				ctx.ui.notify(unauthorized ? "Z.ai API key was rejected." : "Could not fetch Z.ai quota.", "error");
				return;
			}
			const lines = snapshot.samples.map(
				(sample) => `${sample.label}: ${sample.used.toLocaleString()} / ${sample.total.toLocaleString()} credits (${sample.percent}%)${formatReset(sample.resetMs)}`,
			);
			if (snapshot.level) lines.push(`plan level: ${snapshot.level}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

/**
 * pi-quota — provider-aware quota display for the active model.
 *
 * Supported adapters:
 * - Z.ai: coding-plan quota endpoint (provider `zai`)
 * - OpenAI Codex: ChatGPT subscription usage endpoint (provider `openai-codex` + OAuth)
 * - GitHub Copilot: undocumented quota endpoint (provider `github-copilot`, best effort)
 *
 * Each adapter normalizes its response into shared quota samples. No matching
 * provider credential means no quota is fetched or rendered.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fetchCurrentQuota } from "./quota-providers.ts";
import type { QuotaSample, QuotaSnapshot } from "./quota-types.ts";

const CACHE_TTL_MS = 60_000;
const MIN_REFRESH_MS = 30_000;
const IDLE_REFRESH_MS = 5 * 60_000;

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

function shortReset(resetMs?: number): string {
	if (!resetMs) return "";
	const minutes = Math.round((resetMs - Date.now()) / 60_000);
	if (minutes < 1) return "";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	const days = Math.floor(hours / 24);
	return days >= 1 ? `${days}d ${hours % 24}h` : `${hours}h`;
}

function formatSample(sample: QuotaSample, theme: any): string {
	if (sample.unlimited) return `${sample.label} ${theme.fg("dim", "unlimited")}`;
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
	const prefix = theme.fg("dim", `${snapshot.provider} `);
	return prefix + snapshot.samples.map((sample) => formatSample(sample, theme)).join(theme.fg("dim", " · "));
}

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

function formatDetails(snapshot: QuotaSnapshot): string[] {
	const lines = snapshot.samples.map((sample) => {
		if (sample.unlimited) return `${sample.label}: unlimited`;
		const total = sample.total > 0 ? sample.total.toLocaleString() : "unknown limit";
		const used = sample.total > 0 ? `${sample.used.toLocaleString()} / ${total}` : `${Math.round(sample.percent)}% used`;
		return `${sample.label}: ${used}${sample.total > 0 ? ` (${sample.percent}%)` : ""}${formatReset(sample.resetMs)}`;
	});
	if (snapshot.level) lines.push(`plan: ${snapshot.level}`);
	return lines;
}

export default function (pi: ExtensionAPI) {
	let snapshot: QuotaSnapshot | undefined;
	let lastFetchAt = 0;
	let inFlight: Promise<void> | undefined;
	let footerSet = false;
	let idleTimer: ReturnType<typeof setInterval> | undefined;
	let activeProvider: string | undefined;

	function updateFooter(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || footerSet || !snapshot || snapshot.samples.length === 0) return;
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

	function stopIdleTimer(): void {
		if (idleTimer) {
			clearInterval(idleTimer);
			idleTimer = undefined;
		}
	}

	function startIdleTimer(ctx: ExtensionContext): void {
		stopIdleTimer();
		idleTimer = setInterval(() => void refresh(ctx, true), IDLE_REFRESH_MS);
		(idleTimer as unknown as { unref?: () => void })?.unref?.();
	}

	async function refresh(ctx: ExtensionContext, force = false): Promise<void> {
		if ((ctx.mode !== "tui" && ctx.mode !== "rpc") || !ctx.model) return;
		const provider = ctx.model.provider;
		const now = Date.now();
		if (inFlight) {
			await inFlight;
			if (ctx.model?.provider === provider && activeProvider === provider && lastFetchAt === 0) {
				return refresh(ctx, force);
			}
			return;
		}
		if (!force && now - lastFetchAt < CACHE_TTL_MS) return;
		if (force && now - lastFetchAt < MIN_REFRESH_MS) return;

		inFlight = (async () => {
			try {
				const next = await fetchCurrentQuota(ctx);
				// A model switch may have occurred while the request was in flight.
				if (ctx.model?.provider !== provider) return;
				if (next) {
					snapshot = next;
					updateFooter(ctx);
				} else {
					snapshot = undefined;
					removeFooter(ctx);
					stopIdleTimer();
				}
			} catch {
				// Keep the last good snapshot on transient errors; the next event retries.
			} finally {
				if (activeProvider === provider) lastFetchAt = Date.now();
				inFlight = undefined;
			}
		})();
		return inFlight;
	}

	function activate(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		const provider = ctx.model?.provider;
		if (provider !== activeProvider) {
			snapshot = undefined;
			lastFetchAt = 0;
			removeFooter(ctx);
		}
		activeProvider = provider;
		stopIdleTimer();
		void (async () => {
			await refresh(ctx, true);
			if (snapshot && ctx.model?.provider === activeProvider) startIdleTimer(ctx);
		})();
	}

	pi.on("session_start", (_event, ctx) => {
		// Pi clears extension footers when sessions are rebound; reinstall a
		// cached active-provider snapshot before attempting its refresh.
		footerSet = false;
		activate(ctx);
		if (snapshot && ctx.model?.provider === activeProvider) updateFooter(ctx);
	});
	pi.on("model_select", (_event, ctx) => activate(ctx));
	pi.on("turn_end", (_event, ctx) => void refresh(ctx, true));
	pi.on("session_shutdown", () => stopIdleTimer());

	const quotaCommand = {
		description: "Show quota usage for the active model provider",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
			if (!ctx.model) {
				ctx.ui.notify("No model is currently selected.", "warning");
				return;
			}
			lastFetchAt = 0;
			await refresh(ctx, true);
			if (!snapshot) {
				ctx.ui.notify(`No quota data available for active provider '${ctx.model.provider}'.`, "warning");
				return;
			}
			ctx.ui.notify(formatDetails(snapshot).join("\n"), "info");
		},
	};
	pi.registerCommand("quota", quotaCommand);
	// Preserve the original command name for existing users.
	pi.registerCommand("zai-quota", { ...quotaCommand, description: "Show quota usage for the active provider" });
}

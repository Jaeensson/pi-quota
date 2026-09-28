import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaProvider, QuotaSample, QuotaSnapshot } from "../quota-types.ts";
import { asRecord, clampPercent, fetchJson, finiteNumber, getProviderToken, timestampMs } from "../quota-utils.ts";

const PROVIDER_ID = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** Extract the account id used by ChatGPT's Codex usage endpoint from its JWT. */
export function extractChatGptAccountId(token: string): string | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const parsed = asRecord(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
		const auth = asRecord(parsed?.["https://api.openai.com/auth"]);
		const id = auth?.chatgpt_account_id;
		return typeof id === "string" && id.trim() ? id.trim() : undefined;
	} catch {
		return undefined;
	}
}

function windowLabel(seconds: number | undefined, fallback: string): string {
	if (seconds === undefined || seconds <= 0) return fallback;
	if (seconds % 604800 === 0) return `${seconds / 604800}w`;
	if (seconds % 86400 === 0) return `${seconds / 86400}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	return `${Math.round(seconds / 60)}m`;
}

function parseWindow(value: unknown, fallback: string, now: number): QuotaSample | undefined {
	const window = asRecord(value);
	if (!window) return undefined;
	const usedPercent = finiteNumber(window.used_percent, window.usedPercent);
	if (usedPercent === undefined) return undefined;
	const durationSeconds = finiteNumber(
		window.limit_window_seconds,
		window.window_duration_seconds,
		window.windowDurationSecs,
		window.windowDurationSeconds,
		window.window_minutes !== undefined ? Number(window.window_minutes) * 60 : undefined,
		window.windowDurationMins !== undefined ? Number(window.windowDurationMins) * 60 : undefined,
	);
	const reset = timestampMs(window.reset_at ?? window.resets_at ?? window.resetsAt);
	const resetAfterSeconds = finiteNumber(window.reset_after_seconds, window.resetAfterSeconds);
	return {
		label: windowLabel(durationSeconds, fallback),
		percent: clampPercent(usedPercent),
		used: usedPercent,
		total: 100,
		resetMs: reset ?? (resetAfterSeconds !== undefined ? now + resetAfterSeconds * 1000 : undefined),
	};
}

export function parseCodexUsage(payload: unknown, now = Date.now()): QuotaSnapshot {
	const root = asRecord(payload);
	const limits = asRecord(root?.rate_limit ?? root?.rateLimit);
	if (!limits) throw new Error("Unexpected Codex usage response: missing rate_limit");
	const windows = [
		parseWindow(limits.primary_window ?? limits.primaryWindow, "Primary", now),
		parseWindow(limits.secondary_window ?? limits.secondaryWindow, "Secondary", now),
	];
	const additional = Array.isArray(limits.additional_rate_limits)
		? limits.additional_rate_limits.map((item, index) => parseWindow(item, `Limit ${index + 1}`, now))
		: [];
	const samples = [...windows, ...additional].filter((sample): sample is QuotaSample => sample !== undefined);
	if (samples.length === 0) throw new Error("Codex usage response contained no quota windows");
	return {
		fetchedAt: now,
		provider: "Codex",
		level: typeof root?.plan_type === "string" ? root.plan_type : typeof root?.planType === "string" ? root.planType : undefined,
		samples,
	};
}

async function fetch(ctx: ExtensionContext): Promise<QuotaSnapshot | undefined> {
	if (!ctx.model || ctx.model.provider !== PROVIDER_ID || !ctx.modelRegistry.isUsingOAuth(ctx.model)) return undefined;
	const token = await getProviderToken(ctx, PROVIDER_ID);
	if (!token) return undefined;
	const accountId = extractChatGptAccountId(token);
	if (!accountId) return undefined;
	const payload = await fetchJson(USAGE_URL, token, {
		"ChatGPT-Account-Id": accountId,
		originator: "pi",
	});
	return parseCodexUsage(payload);
}

export const openAICodexQuotaProvider: QuotaProvider = { providerId: PROVIDER_ID, fetch };

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const FETCH_TIMEOUT_MS = 10_000;
const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export interface QuotaSample {
	label: string;
	percent: number;
	used: number;
	total: number;
	resetMs?: number;
	unlimited?: boolean;
}

export interface QuotaSnapshot {
	fetchedAt: number;
	provider: string;
	level?: string;
	samples: QuotaSample[];
}

interface ProviderContext extends Pick<ExtensionContext, "model" | "modelRegistry"> {}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function finiteNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
		if (Number.isFinite(number)) return number;
	}
	return undefined;
}

function timestampMs(value: unknown): number | undefined {
	const number = finiteNumber(value);
	if (number !== undefined) return number < 10_000_000_000 ? number * 1000 : number;
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function clampPercent(percent: number): number {
	return Math.max(0, Math.min(100, Math.round(percent)));
}

async function getProviderToken(ctx: ProviderContext, provider: string): Promise<string | undefined> {
	try {
		const auth = await ctx.modelRegistry.getProviderAuth(provider);
		const token = auth?.auth?.apiKey;
		return typeof token === "string" && token.length > 0 ? token : undefined;
	} catch {
		return undefined;
	}
}

async function fetchJson(url: string, token: string, headers: Record<string, string> = {}): Promise<unknown> {
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
			"User-Agent": "pi-quota",
			...headers,
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
	return response.json();
}

// ---------------------------------------------------------------------------
// Z.ai adapter
// ---------------------------------------------------------------------------

interface ZaiLimit {
	unit?: number;
	number?: number;
	usage?: number;
	currentValue?: number;
	percentage?: number;
	nextResetTime?: number;
}

export function parseZaiLimits(limits: ZaiLimit[], level?: string, now = Date.now()): QuotaSnapshot {
	const samples = limits.slice(0, 2).map((limit, index): QuotaSample => {
		const percent = typeof limit.percentage === "number"
			? limit.percentage
			: (limit.usage ?? 0) > 0
				? ((limit.currentValue ?? 0) / (limit.usage ?? 1)) * 100
				: 0;
		const count = typeof limit.number === "number" ? limit.number : 1;
		const label = limit.unit === 3 ? `${count}h`
			: limit.unit === 4 ? `${count}d`
				: limit.unit === 6 ? `${count}w`
					: index === 0 ? "5h" : "1w";
		return {
			label,
			percent: clampPercent(percent),
			used: limit.currentValue ?? 0,
			total: limit.usage ?? 0,
			resetMs: limit.nextResetTime,
		};
	});
	return { fetchedAt: now, provider: "z.ai", level, samples };
}

async function fetchZai(ctx: ProviderContext): Promise<QuotaSnapshot | undefined> {
	const token = await getProviderToken(ctx, "zai") ?? process.env.ZAI_API_KEY ?? process.env.Z_AI_API_KEY;
	if (!token) return undefined;
	let lastError: unknown;
	for (const authorization of [`Bearer ${token}`, token]) {
		const response = await fetch(ZAI_QUOTA_URL, {
			headers: { Authorization: authorization, Accept: "application/json" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (response.status === 401 || response.status === 403) {
			lastError = new Error(`${response.status} Unauthorized`);
			continue;
		}
		if (!response.ok) throw new Error(`HTTP ${response.status} from ${ZAI_QUOTA_URL}`);
		const body = asRecord(await response.json());
		const data = asRecord(body?.data);
		if (!Array.isArray(data?.limits)) throw new Error("Unexpected Z.ai quota response shape");
		return parseZaiLimits(data.limits as ZaiLimit[], typeof data.level === "string" ? data.level : undefined);
	}
	throw lastError ?? new Error("Unauthorized");
}

// ---------------------------------------------------------------------------
// OpenAI Codex subscription adapter
// ---------------------------------------------------------------------------

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

function parseCodexWindow(value: unknown, fallback: string, now: number): QuotaSample | undefined {
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
		parseCodexWindow(limits.primary_window ?? limits.primaryWindow, "Primary", now),
		parseCodexWindow(limits.secondary_window ?? limits.secondaryWindow, "Secondary", now),
	];
	const additional = Array.isArray(limits.additional_rate_limits)
		? limits.additional_rate_limits.map((item, index) => parseCodexWindow(item, `Limit ${index + 1}`, now))
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

async function fetchCodex(ctx: ProviderContext): Promise<QuotaSnapshot | undefined> {
	if (!ctx.model || ctx.model.provider !== "openai-codex" || !ctx.modelRegistry.isUsingOAuth(ctx.model)) return undefined;
	const token = await getProviderToken(ctx, "openai-codex");
	if (!token) return undefined;
	const accountId = extractChatGptAccountId(token);
	if (!accountId) return undefined;
	const payload = await fetchJson(CODEX_USAGE_URL, token, {
		"ChatGPT-Account-Id": accountId,
		originator: "pi",
	});
	return parseCodexUsage(payload);
}

/**
 * Fetch quota for the currently selected provider only. Unrecognized providers
 * and providers without matching credentials intentionally render no quota.
 */
export async function fetchCurrentQuota(ctx: ProviderContext): Promise<QuotaSnapshot | undefined> {
	if (!ctx.model) return undefined;
	switch (ctx.model.provider) {
		case "zai": return fetchZai(ctx);
		case "openai-codex": return fetchCodex(ctx);
		default: return undefined;
	}
}

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaProvider, QuotaSample, QuotaSnapshot } from "../quota-types.ts";
import { asRecord, clampPercent, FETCH_TIMEOUT_MS } from "../quota-utils.ts";

const PROVIDER_ID = "zai";
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

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

async function fetch(ctx: ExtensionContext): Promise<QuotaSnapshot | undefined> {
	let token: string | undefined;
	try {
		token = (await ctx.modelRegistry.getProviderAuth(PROVIDER_ID))?.auth?.apiKey;
	} catch {
		// Environment fallback below.
	}
	token ??= process.env.ZAI_API_KEY ?? process.env.Z_AI_API_KEY;
	if (!token) return undefined;

	let lastError: unknown;
	for (const authorization of [`Bearer ${token}`, token]) {
		const response = await globalThis.fetch(QUOTA_URL, {
			headers: { Authorization: authorization, Accept: "application/json" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (response.status === 401 || response.status === 403) {
			lastError = new Error(`${response.status} Unauthorized`);
			continue;
		}
		if (!response.ok) throw new Error(`HTTP ${response.status} from ${QUOTA_URL}`);
		const body = asRecord(await response.json());
		const data = asRecord(body?.data);
		if (!Array.isArray(data?.limits)) throw new Error("Unexpected Z.ai quota response shape");
		return parseZaiLimits(data.limits as ZaiLimit[], typeof data.level === "string" ? data.level : undefined);
	}
	throw lastError ?? new Error("Unauthorized");
}

export const zaiQuotaProvider: QuotaProvider = { providerId: PROVIDER_ID, fetch };

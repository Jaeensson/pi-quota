import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaProvider, QuotaSample, QuotaSnapshot } from "../quota-types.ts";
import { asRecord, clampPercent, fetchJson, finiteNumber, getProviderToken, timestampMs } from "../quota-utils.ts";

const PROVIDER_ID = "opencode-go";
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/** Server window key -> display label. The endpoint reports only percentages. */
const WINDOWS: ReadonlyArray<readonly [key: string, label: string]> = [
	["rolling", "5h"],
	["weekly", "1w"],
	["monthly", "1mo"],
];

function parseWindow(value: unknown, label: string): QuotaSample | undefined {
	const window = asRecord(value);
	if (!window) return undefined;
	const percent = finiteNumber(window.percent);
	if (percent === undefined) return undefined;
	return {
		label,
		percent: clampPercent(percent),
		used: percent,
		total: 100,
		resetMs: timestampMs(window.resetsAt ?? window.resets_at),
	};
}

export function parseOpenCodeUsage(payload: unknown, now = Date.now()): QuotaSnapshot {
	const usage = asRecord(asRecord(payload)?.usage);
	if (!usage) throw new Error("Unexpected OpenCode Go usage response: missing usage");
	const samples = WINDOWS
		.map(([key, label]) => parseWindow(usage[key], label))
		.filter((sample): sample is QuotaSample => sample !== undefined);
	if (samples.length === 0) throw new Error("OpenCode Go response contained no usage windows");
	return { fetchedAt: now, provider: "OpenCode Go", samples };
}

async function fetch(ctx: ExtensionContext): Promise<QuotaSnapshot | undefined> {
	if (!ctx.model || ctx.model.provider !== PROVIDER_ID) return undefined;
	const token = await getProviderToken(ctx, PROVIDER_ID) ?? process.env.OPENCODE_API_KEY;
	if (!token) return undefined;
	const payload = await fetchJson(USAGE_URL, token);
	return parseOpenCodeUsage(payload);
}

export const openCodeGoQuotaProvider: QuotaProvider = { providerId: PROVIDER_ID, fetch };

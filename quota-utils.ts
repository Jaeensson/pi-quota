import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const FETCH_TIMEOUT_MS = 10_000;

export type QuotaProviderContext = Pick<ExtensionContext, "model" | "modelRegistry">;

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

export function finiteNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
		if (Number.isFinite(number)) return number;
	}
	return undefined;
}

export function timestampMs(value: unknown): number | undefined {
	const number = finiteNumber(value);
	if (number !== undefined) return number < 10_000_000_000 ? number * 1000 : number;
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function clampPercent(percent: number): number {
	return Math.max(0, Math.min(100, Math.round(percent)));
}

export async function getProviderToken(ctx: QuotaProviderContext, provider: string): Promise<string | undefined> {
	try {
		const auth = await ctx.modelRegistry.getProviderAuth(provider);
		const token = auth?.auth?.apiKey;
		return typeof token === "string" && token.length > 0 ? token : undefined;
	} catch {
		return undefined;
	}
}

export async function fetchJson(url: string, token: string, headers: Record<string, string> = {}): Promise<unknown> {
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

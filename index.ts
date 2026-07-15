import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AuthStorage, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	getApiProvider,
	type GoogleOptions,
	type GoogleThinkingLevel,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
} from "@earendil-works/pi-ai/compat";

type ModelInput = "text" | "image";
type NewApiBackendApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
type NewApiModelApi = typeof NEWAPI_WRAPPER_API;
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;
type MaxTokensField = "max_tokens" | "max_completion_tokens";
type ThinkingFormat = "openai" | "openrouter" | "deepseek" | "together" | "zai" | "qwen" | "qwen-chat-template";
type SessionAffinityFormat = "openai" | "openai-nosession" | "openrouter";
type NotifyType = "info" | "warning" | "error";
type NotifyFn = (message: string, type?: NotifyType) => void;

// Module-level notify bridge: utility code has no ExtensionContext, so bind
// ctx.ui.notify on session_start and queue any messages that arrive earlier.
const pendingNotifications: Array<{ message: string; type: NotifyType }> = [];
let uiNotify: NotifyFn | undefined;

function notify(message: string, type: NotifyType = "warning"): void {
	if (uiNotify) {
		uiNotify(message, type);
		return;
	}
	pendingNotifications.push({ message, type });
}

function bindUiNotify(notifyFn: NotifyFn): void {
	uiNotify = notifyFn;
	if (pendingNotifications.length === 0) return;

	const queued = pendingNotifications.splice(0, pendingNotifications.length);
	for (const item of queued) {
		uiNotify(item.message, item.type);
	}
}

interface NewApiModelConfig {
	id: string;
	name: string;
	api?: NewApiModelApi;
	baseUrl?: string;
	thinkingLevelMap?: ThinkingLevelMap;
	reasoning: boolean;
	input: ModelInput[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	compat: {
		supportsDeveloperRole: boolean;
		maxTokensField: MaxTokensField;
		supportsReasoningEffort?: boolean;
		thinkingFormat?: ThinkingFormat;
		sendSessionAffinityHeaders?: boolean;
		sessionAffinityFormat?: SessionAffinityFormat;
		supportsLongCacheRetention?: boolean;
		supportsTemperature?: boolean;
		forceAdaptiveThinking?: boolean;
	};
}

interface NewApiModelsResponse {
	data?: Array<{ id?: unknown; name?: unknown }>;
}

interface PublicModelMetadata {
	id?: string;
	name?: string;
	reasoning?: boolean;
	input?: ModelInput[];
	contextWindow?: number;
	maxTokens?: number;
}

interface ModelsJsonProviderConfig {
	baseUrl?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
}

type CacheRefreshMode = "background" | "blocking" | "off";
type CacheState = "fresh" | "stale";

interface CacheLoadResult<T> {
	value?: T;
	shouldRefresh: boolean;
}

interface CacheReadResult<T> {
	value: T;
	state: CacheState;
}

interface CachePayload<T> {
	version: number;
	key: string;
	updatedAt: number;
	value: T;
}

interface CachedValueOptions<T> {
	namespace: string;
	key: string;
	ttlMs: number;
	readValue: (value: unknown) => T | undefined;
	fetchValue: () => Promise<T | undefined>;
}

interface CachedPublicModelMetadata {
	lookupId: string;
	metadata: PublicModelMetadata;
}

type PublicModelMetadataCacheValue = CachedPublicModelMetadata[];

interface PublicModelMetadataLoadResult {
	metadata: Map<string, PublicModelMetadata>;
	shouldRefresh: boolean;
}

interface DiscoveredModelIdsLoadResult {
	ids: string[];
	shouldRefresh: boolean;
}

interface ProviderModelLoadResult {
	models: NewApiModelConfig[];
	publicModelMetadata: Map<string, PublicModelMetadata>;
	discoveredModelIds: string[];
	shouldRefresh: boolean;
}

interface NewApiDiscoverySource {
	cacheKey: string;
	headers: Record<string, string>;
}

const NEWAPI_WRAPPER_API = "newapi-gateway" as const;
const PROVIDER_ID = process.env.NEWAPI_PROVIDER_ID?.trim() || "newapi";
const MODELS_JSON_PROVIDER_CONFIG = readModelsJsonProviderConfig(PROVIDER_ID);
const PROVIDER_NAME = process.env.NEWAPI_PROVIDER_NAME?.trim() || "NewAPI Gateway";
const BASE_URL = normalizeGatewayBaseUrl(
	MODELS_JSON_PROVIDER_CONFIG?.baseUrl ?? process.env.NEWAPI_BASE_URL ?? "http://localhost:3000",
);
const MODELS_DEV_URL = process.env.NEWAPI_MODELS_DEV_URL?.trim() || "https://models.dev/models.json";
const PROVIDER_API_KEY = MODELS_JSON_PROVIDER_CONFIG?.apiKey ?? "$NEWAPI_API_KEY";
const MODEL_CACHE_VERSION = 1;
const MODEL_CACHE_ENABLED = parseBoolean(process.env.NEWAPI_MODEL_CACHE, true);
const MODEL_CACHE_DIR = join(getAgentDir(), "cache", "newapi-provider");
const MODELS_CACHE_TTL_MS = parseDurationSeconds(process.env.NEWAPI_MODELS_CACHE_TTL, 30 * 60) * 1000;
const MODEL_METADATA_CACHE_TTL_MS =
	parseDurationSeconds(process.env.NEWAPI_MODEL_METADATA_CACHE_TTL, 24 * 60 * 60) * 1000;
const MODEL_CACHE_STALE_TTL_MS =
	parseDurationSeconds(process.env.NEWAPI_MODEL_CACHE_STALE_TTL, 7 * 24 * 60 * 60) * 1000;
const MODEL_CACHE_REFRESH_MODE = parseCacheRefreshMode(process.env.NEWAPI_MODEL_CACHE_REFRESH);

const DEFAULT_CONTEXT_WINDOW = parsePositiveInteger(process.env.NEWAPI_CONTEXT_WINDOW, 128_000);
const DEFAULT_MAX_TOKENS = parsePositiveInteger(process.env.NEWAPI_MAX_TOKENS, 4096);
const DEFAULT_REASONING = parseBoolean(process.env.NEWAPI_REASONING, false);
const DEFAULT_INPUT = parseInputs(process.env.NEWAPI_INPUTS || "text");
const SESSION_ID_HEADER = process.env.NEWAPI_SESSION_ID_HEADER?.trim() || "x-session-id";
const DEBUG_SESSION_HEADERS = parseBoolean(process.env.NEWAPI_DEBUG_SESSION_HEADERS, false);
const EXTRA_HEADERS = MODELS_JSON_PROVIDER_CONFIG?.headers ?? parseHeaders(process.env.NEWAPI_HEADERS);
const AUTH_HEADER = MODELS_JSON_PROVIDER_CONFIG?.authHeader;
const ROUTES_BY_MODEL_ID = new Map<string, { api: NewApiBackendApi; baseUrl: string }>();

function readModelsJsonProviderConfig(providerId: string): ModelsJsonProviderConfig | undefined {
	const modelsPath = join(getAgentDir(), "models.json");
	if (!existsSync(modelsPath)) return undefined;

	try {
		const payload = asRecord(JSON.parse(readFileSync(modelsPath, "utf8")) as unknown);
		const providers = asRecord(payload?.providers);
		const provider = asRecord(providers?.[providerId]);
		if (!provider) return undefined;

		const headers = readHeaderRecord(provider.headers);
		const authHeader = typeof provider.authHeader === "boolean" ? provider.authHeader : undefined;

		return {
			...(readString(provider, "baseUrl") ? { baseUrl: readString(provider, "baseUrl") } : {}),
			...(readString(provider, "apiKey") ? { apiKey: readString(provider, "apiKey") } : {}),
			...(headers ? { headers } : {}),
			...(authHeader !== undefined ? { authHeader } : {}),
		};
	} catch (error) {
		notify(
			`[${PROVIDER_ID}] Failed to read models.json provider config: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
		return undefined;
	}
}

async function loadCachedValue<T>(options: CachedValueOptions<T>): Promise<CacheLoadResult<T>> {
	const cached = MODEL_CACHE_ENABLED ? readCacheValue(options) : undefined;
	if (cached?.state === "fresh") return { value: cached.value, shouldRefresh: false };

	if (cached?.state === "stale") {
		if (MODEL_CACHE_REFRESH_MODE === "blocking") {
			const value = await refreshCachedValue(options);
			if (value !== undefined) return { value, shouldRefresh: false };
		}

		return {
			value: cached.value,
			shouldRefresh: MODEL_CACHE_REFRESH_MODE === "background",
		};
	}

	return { value: await refreshCachedValue(options), shouldRefresh: false };
}

async function refreshCachedValue<T>(options: CachedValueOptions<T>): Promise<T | undefined> {
	const value = await options.fetchValue();
	if (value !== undefined && MODEL_CACHE_ENABLED) writeCacheValue(options, value);
	return value;
}

function readCacheValue<T>(options: CachedValueOptions<T>): CacheReadResult<T> | undefined {
	const cachePath = getCachePath(options.namespace, options.key);
	if (!existsSync(cachePath)) return undefined;

	try {
		const payload = asRecord(JSON.parse(readFileSync(cachePath, "utf8")) as unknown);
		if (!payload) return undefined;
		if (payload.version !== MODEL_CACHE_VERSION) return undefined;
		if (payload.key !== options.key) return undefined;
		if (typeof payload.updatedAt !== "number" || !Number.isFinite(payload.updatedAt)) return undefined;

		const value = options.readValue(payload.value);
		if (value === undefined) return undefined;

		const ageMs = Math.max(0, Date.now() - payload.updatedAt);
		const maxAgeMs = Math.max(options.ttlMs, MODEL_CACHE_STALE_TTL_MS);
		if (ageMs > maxAgeMs) return undefined;

		return { value, state: ageMs <= options.ttlMs ? "fresh" : "stale" };
	} catch (error) {
		notify(
			`[${PROVIDER_ID}] Failed to read model cache: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
		return undefined;
	}
}

function writeCacheValue<T>(options: CachedValueOptions<T>, value: T): void {
	try {
		mkdirSync(MODEL_CACHE_DIR, { recursive: true });
		const payload: CachePayload<T> = {
			version: MODEL_CACHE_VERSION,
			key: options.key,
			updatedAt: Date.now(),
			value,
		};
		writeFileSync(getCachePath(options.namespace, options.key), JSON.stringify(payload), "utf8");
	} catch (error) {
		notify(
			`[${PROVIDER_ID}] Failed to write model cache: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}
}

function getCachePath(namespace: string, key: string): string {
	return join(MODEL_CACHE_DIR, `${namespace}-${hashValue(key).slice(0, 32)}.json`);
}

function getPublicModelMetadataCacheKey(): string {
	return stableStringify({ url: MODELS_DEV_URL });
}

function getNewApiDiscoveryCacheKey(apiKey: string, headers: Record<string, string>): string {
	return stableStringify({
		providerId: PROVIDER_ID,
		baseUrl: getOpenAiBaseUrl(),
		apiKeyHash: hashValue(apiKey),
		headersHash: hashValue(stableStringify(headers)),
	});
}

function readModelIdsCacheValue(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;

	const ids = value.map((id) => (typeof id === "string" ? id.trim() : "")).filter((id) => id.length > 0);
	return [...new Set(ids)].sort();
}

function readPublicModelMetadataCacheValue(value: unknown): PublicModelMetadataCacheValue | undefined {
	if (!Array.isArray(value)) return undefined;

	const entries: PublicModelMetadataCacheValue = [];
	for (const entry of value) {
		const record = asRecord(entry);
		if (!record) continue;

		const lookupId = readString(record, "lookupId");
		const metadata = readCachedPublicModelMetadata(record.metadata);
		if (lookupId && metadata) entries.push({ lookupId: normalizeModelLookupId(lookupId), metadata });
	}

	return entries;
}

function readCachedPublicModelMetadata(value: unknown): PublicModelMetadata | undefined {
	const record = asRecord(value);
	if (!record) return undefined;

	const metadata: PublicModelMetadata = {};
	const id = readString(record, "id");
	const name = readString(record, "name");
	const input = parsePublicModelInputs(record.input);
	const contextWindow = readPositiveInteger(record, "contextWindow");
	const maxTokens = readPositiveInteger(record, "maxTokens");

	if (id) metadata.id = id;
	if (name) metadata.name = name;
	if (typeof record.reasoning === "boolean") metadata.reasoning = record.reasoning;
	if (input) metadata.input = input;
	if (contextWindow) metadata.contextWindow = contextWindow;
	if (maxTokens) metadata.maxTokens = maxTokens;

	return metadata;
}

function hashValue(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
			.join(",")}}`;
	}

	return JSON.stringify(value) ?? "undefined";
}

function parseCacheRefreshMode(value: string | undefined): CacheRefreshMode {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return "background";
	if (["0", "false", "no", "off", "none"].includes(normalized)) return "off";
	if (normalized === "blocking") return "blocking";
	return "background";
}

function parseDurationSeconds(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;

	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const OFFICIAL_MODELS_DEV_PATTERNS: Array<{ provider: string; model: RegExp }> = [
	{ provider: "deepseek", model: /^deepseek/i },
	{ provider: "openai", model: /^(?:gpt|o\d)/i },
	{ provider: "google", model: /^gemini/i },
	{ provider: "anthropic", model: /^claude/i },
	{ provider: "moonshotai", model: /^kimi/i },
	{ provider: "zhipuai", model: /^glm/i },
	{ provider: "minimax", model: /^minimax/i },
	{ provider: "alibaba", model: /^qwen/i },
	{ provider: "xiaomi", model: /^mimo/i },
	{ provider: "xai", model: /^grok/i },
];

export default async function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		bindUiNotify((message, type) => ctx.ui.notify(message, type));
	});

	const providerModels = await loadProviderModels();

	registerNewApiProvider(pi, providerModels.models);

	if (!providerModels.shouldRefresh) return;

	// The `pi` captured here goes stale when this extension instance is replaced
	// (session switch, fork, reload). The new instance re-runs the factory with a
	// fresh `pi`, so the old background refresh has nothing useful left to do —
	// cancel it on `session_shutdown` and never call `registerProvider` after that.
	const refreshAbort = new AbortController();
	pi.on("session_shutdown", () => {
		uiNotify = undefined;
		pendingNotifications.length = 0;
		refreshAbort.abort();
	});

	void refreshProviderModelsInBackground(
		pi,
		providerModels.publicModelMetadata,
		providerModels.discoveredModelIds,
		refreshAbort.signal,
	);
}

async function loadProviderModels(): Promise<ProviderModelLoadResult> {
	const publicModelMetadata = await loadPublicModelMetadata();
	const discoveredModelIds = await loadDiscoveredModelIds();
	const models =
		discoveredModelIds.ids.length > 0
			? modelsFromIds(discoveredModelIds.ids, publicModelMetadata.metadata)
			: modelsFromEnvironment(publicModelMetadata.metadata);

	return {
		models,
		publicModelMetadata: publicModelMetadata.metadata,
		discoveredModelIds: discoveredModelIds.ids,
		shouldRefresh: publicModelMetadata.shouldRefresh || discoveredModelIds.shouldRefresh,
	};
}

async function refreshProviderModelsInBackground(
	pi: ExtensionAPI,
	currentPublicModelMetadata: Map<string, PublicModelMetadata>,
	currentDiscoveredModelIds: string[],
	signal: AbortSignal,
): Promise<void> {
	try {
		const [publicModelMetadataEntries, discoveredModelIds] = await Promise.all([
			refreshPublicModelMetadataCache(),
			refreshDiscoveredModelIdsCache(),
		]);

		if (signal.aborted) return;
		if (publicModelMetadataEntries === undefined && discoveredModelIds === undefined) return;

		const publicModelMetadata = publicModelMetadataEntries
			? toPublicModelMetadataMap(publicModelMetadataEntries)
			: currentPublicModelMetadata;
		const modelIds = discoveredModelIds ?? currentDiscoveredModelIds;
		const models =
			modelIds.length > 0 ? modelsFromIds(modelIds, publicModelMetadata) : modelsFromEnvironment(publicModelMetadata);

		registerNewApiProvider(pi, models);
	} catch (error) {
		if (signal.aborted) return;
		notify(
			`[${PROVIDER_ID}] Failed to refresh model cache: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}
}

function registerNewApiProvider(pi: ExtensionAPI, models: NewApiModelConfig[]): void {
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: getOpenAiBaseUrl(),
		apiKey: PROVIDER_API_KEY,
		api: NEWAPI_WRAPPER_API,
		streamSimple: streamNewApiGateway,
		...(Object.keys(EXTRA_HEADERS).length > 0 ? { headers: EXTRA_HEADERS } : {}),
		...(AUTH_HEADER !== undefined ? { authHeader: AUTH_HEADER } : {}),
		models,
	});
}

function streamNewApiGateway(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		try {
			const route = ROUTES_BY_MODEL_ID.get(model.id) ?? getModelRoute(model.id, undefined);
			const routedModel = { ...model, api: route.api, baseUrl: route.baseUrl };
			const routedOptions = await addModelsJsonRequestAuth(addSessionIdHeader(options));
			const innerStream = streamBackendApi(route.api, routedModel, context, routedOptions);

			for await (const event of innerStream) stream.push(event);
			stream.end();
		} catch (error) {
			stream.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				},
			});
			stream.end();
		}
	})();

	return stream;
}

function addSessionIdHeader(options: SimpleStreamOptions | undefined): SimpleStreamOptions | undefined {
	const sessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
	if (!sessionId) {
		if (DEBUG_SESSION_HEADERS) {
			notify(`[${PROVIDER_ID}] No session id available for request; ${SESSION_ID_HEADER} was not injected.`, "warning");
		}
		return options;
	}

	const headers = {
		...(options?.headers ?? {}),
		[SESSION_ID_HEADER]: sessionId,
	};

	if (DEBUG_SESSION_HEADERS) {
		notify(`[${PROVIDER_ID}] Injected ${SESSION_ID_HEADER} for session ${sessionId}.`, "info");
	}

	return {
		...(options ?? {}),
		headers,
	};
}

async function addModelsJsonRequestAuth(
	options: SimpleStreamOptions | undefined,
): Promise<SimpleStreamOptions | undefined> {
	const apiKey = await resolveConfigValue(MODELS_JSON_PROVIDER_CONFIG?.apiKey);
	if (!apiKey) return options;

	const headers = MODELS_JSON_PROVIDER_CONFIG?.authHeader
		? { ...(options?.headers ?? {}), Authorization: `Bearer ${apiKey}` }
		: options?.headers;

	return {
		...(options ?? {}),
		apiKey,
		...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
	};
}

function streamBackendApi(
	api: NewApiBackendApi,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
	switch (api) {
		case "anthropic-messages":
			return streamSimple(model as Model<"anthropic-messages">, context, options);
		case "google-generative-ai":
			return streamNewApiGoogle(model as Model<"google-generative-ai">, context, options);
		case "openai-responses":
			return streamSimple(model as Model<"openai-responses">, context, options);
		case "openai-completions":
			return streamSimple(model as Model<"openai-completions">, context, options);
	}
}

function streamNewApiGoogle(
	model: Model<"google-generative-ai">,
	context: Context,
	options: SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
	const provider = getApiProvider("google-generative-ai");
	if (!provider) throw new Error("Google Generative AI provider is not registered");

	return provider.stream(model, context, {
		...options,
		thinking: getGoogleThinkingConfig(model.id, options?.reasoning),
	} as GoogleOptions);
}

function getGoogleThinkingConfig(
	modelId: string,
	reasoning: SimpleStreamOptions["reasoning"] | undefined,
): { enabled: boolean; budgetTokens?: number; level?: GoogleThinkingLevel } {
	if (!reasoning) {
		return isGemini25ProModelId(modelId) ? { enabled: true, budgetTokens: 128 } : { enabled: false };
	}

	if (isGemini25ModelId(modelId)) {
		return { enabled: true, budgetTokens: getGemini25ThinkingBudget(modelId, reasoning) };
	}

	return { enabled: true, level: getGeminiThinkingLevel(modelId, reasoning) };
}

function getGeminiThinkingLevel(
	modelId: string,
	reasoning: NonNullable<SimpleStreamOptions["reasoning"]>,
): GoogleThinkingLevel {
	if (isGemini31ProModelId(modelId)) {
		return reasoning === "low" ? "LOW" : reasoning === "medium" ? "MEDIUM" : "HIGH";
	}
	if (isGemini3ProModelId(modelId)) {
		return reasoning === "low" ? "LOW" : "HIGH";
	}

	switch (reasoning) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
		case "xhigh":
		case "max":
			return "HIGH";
	}
}

function getGemini25ThinkingBudget(modelId: string, reasoning: NonNullable<SimpleStreamOptions["reasoning"]>): number {
	if (isGemini25ProModelId(modelId)) {
		const budgets = { minimal: 128, low: 2048, medium: 8192, high: 32768, xhigh: 32768, max: 32768 };
		return budgets[reasoning];
	}
	if (modelId.includes("gemini-2.5-flash-lite")) {
		const budgets = { minimal: 512, low: 2048, medium: 8192, high: 24576, xhigh: 24576, max: 24576 };
		return budgets[reasoning];
	}

	const budgets = { minimal: 128, low: 2048, medium: 8192, high: 24576, xhigh: 24576, max: 24576 };
	return budgets[reasoning];
}

async function loadDiscoveredModelIds(): Promise<DiscoveredModelIdsLoadResult> {
	if (process.env.NEWAPI_FETCH_MODELS === "false") return { ids: [], shouldRefresh: false };

	const discoverySource = await getNewApiDiscoverySource();
	if (!discoverySource) return { ids: [], shouldRefresh: false };

	const result = await loadCachedValue({
		namespace: "models",
		key: discoverySource.cacheKey,
		ttlMs: MODELS_CACHE_TTL_MS,
		readValue: readModelIdsCacheValue,
		fetchValue: () => fetchNewApiModelIds(discoverySource.headers),
	});

	return { ids: result.value ?? [], shouldRefresh: result.shouldRefresh };
}

async function refreshDiscoveredModelIdsCache(): Promise<string[] | undefined> {
	if (process.env.NEWAPI_FETCH_MODELS === "false") return undefined;

	const discoverySource = await getNewApiDiscoverySource();
	if (!discoverySource) return undefined;

	return await refreshCachedValue({
		namespace: "models",
		key: discoverySource.cacheKey,
		ttlMs: MODELS_CACHE_TTL_MS,
		readValue: readModelIdsCacheValue,
		fetchValue: () => fetchNewApiModelIds(discoverySource.headers),
	});
}

async function getNewApiDiscoverySource(): Promise<NewApiDiscoverySource | undefined> {
	const apiKey = await getNewApiApiKey();
	if (!apiKey) return undefined;

	const headers = await getNewApiDiscoveryHeaders(apiKey);

	return {
		cacheKey: getNewApiDiscoveryCacheKey(apiKey, headers),
		headers,
	};
}

async function fetchNewApiModelIds(headers: Record<string, string>): Promise<string[] | undefined> {
	try {
		const response = await fetch(`${getOpenAiBaseUrl()}/models`, { headers });

		if (!response.ok) {
			notify(`[${PROVIDER_ID}] Failed to fetch models: ${response.status} ${await response.text()}`, "warning");
			return undefined;
		}

		const payload = (await response.json()) as NewApiModelsResponse;
		const ids = (payload.data ?? [])
			.map((model) => (typeof model.id === "string" ? model.id.trim() : ""))
			.filter((id) => id.length > 0);

		return [...new Set(ids)].sort();
	} catch (error) {
		notify(
			`[${PROVIDER_ID}] Failed to fetch models: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
		return undefined;
	}
}

async function getNewApiApiKey(): Promise<string | undefined> {
	const configuredApiKey = await resolveConfigValue(MODELS_JSON_PROVIDER_CONFIG?.apiKey);
	if (configuredApiKey) return configuredApiKey;

	const authStorage = AuthStorage.create();
	if (authStorage.has(PROVIDER_ID)) {
		return await authStorage.getApiKey(PROVIDER_ID, { includeFallback: false });
	}

	return process.env.NEWAPI_API_KEY;
}

async function getNewApiDiscoveryHeaders(apiKey: string): Promise<Record<string, string>> {
	return {
		Authorization: `Bearer ${apiKey}`,
		...(await resolveHeaders(EXTRA_HEADERS)),
	};
}

async function resolveHeaders(
	headers: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
	if (!headers) return undefined;

	const resolvedEntries = await Promise.all(
		Object.entries(headers).map(async ([key, value]) => [key, await resolveConfigValue(value)] as const),
	);
	const resolvedHeaders = Object.fromEntries(
		resolvedEntries.filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);

	return Object.keys(resolvedHeaders).length > 0 ? resolvedHeaders : undefined;
}

async function resolveConfigValue(value: string | undefined): Promise<string | undefined> {
	if (!value) return undefined;
	if (value.startsWith("!")) return await execConfigCommand(value.slice(1));
	return resolveEnvironmentReferences(value);
}

function execConfigCommand(command: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		exec(command, (error, stdout) => {
			if (error) {
				notify(`[${PROVIDER_ID}] Failed to resolve models.json command: ${error.message}`, "warning");
				resolve(undefined);
				return;
			}

			const value = stdout.trim();
			resolve(value.length > 0 ? value : undefined);
		});
	});
}

function resolveEnvironmentReferences(value: string): string | undefined {
	let resolved = "";

	for (let index = 0; index < value.length; index++) {
		const char = value[index];
		if (char !== "$") {
			resolved += char;
			continue;
		}

		const next = value[index + 1];
		if (next === "$" || next === "!") {
			resolved += next;
			index++;
			continue;
		}

		if (next === "{") {
			const end = value.indexOf("}", index + 2);
			if (end === -1) {
				resolved += char;
				continue;
			}

			const envValue = process.env[value.slice(index + 2, end)];
			if (envValue === undefined) return undefined;
			resolved += envValue;
			index = end;
			continue;
		}

		const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(index + 1));
		if (!match) {
			resolved += char;
			continue;
		}

		const envValue = process.env[match[0]];
		if (envValue === undefined) return undefined;
		resolved += envValue;
		index += match[0].length;
	}

	return resolved;
}

function modelsFromEnvironment(publicModelMetadata: Map<string, PublicModelMetadata>): NewApiModelConfig[] {
	const ids = (process.env.NEWAPI_MODELS || "gpt-4o-mini")
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0);

	return modelsFromIds(ids, publicModelMetadata);
}

function modelsFromIds(ids: string[], publicModelMetadata: Map<string, PublicModelMetadata>): NewApiModelConfig[] {
	ROUTES_BY_MODEL_ID.clear();
	return [...new Set(ids)].map((id) => toProviderModel(id, publicModelMetadata));
}

function toProviderModel(id: string, publicModelMetadata: Map<string, PublicModelMetadata>): NewApiModelConfig {
	const metadata = findPublicModelMetadata(id, publicModelMetadata);
	const route = getModelRoute(id, metadata);
	ROUTES_BY_MODEL_ID.set(id, route);
	const candidates = getModelRouteCandidates(id, metadata);
	const reasoning = metadata?.reasoning ?? (DEFAULT_REASONING || candidates.some(supportsThinking));
	const compat = getModelCompat(id, metadata, reasoning);
	const thinkingLevelMap = getThinkingLevelMap(id, metadata);

	return {
		id,
		name: metadata?.name ?? formatModelName(id),
		api: NEWAPI_WRAPPER_API,
		baseUrl: route.baseUrl,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		reasoning,
		input: metadata?.input ?? DEFAULT_INPUT,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: metadata?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: metadata?.maxTokens ?? DEFAULT_MAX_TOKENS,
		compat,
	};
}

async function loadPublicModelMetadata(): Promise<PublicModelMetadataLoadResult> {
	if (process.env.NEWAPI_FETCH_MODEL_METADATA === "false") {
		return { metadata: new Map<string, PublicModelMetadata>(), shouldRefresh: false };
	}

	const result = await loadCachedValue({
		namespace: "metadata",
		key: getPublicModelMetadataCacheKey(),
		ttlMs: MODEL_METADATA_CACHE_TTL_MS,
		readValue: readPublicModelMetadataCacheValue,
		fetchValue: fetchPublicModelMetadataEntries,
	});

	return {
		metadata: toPublicModelMetadataMap(result.value ?? []),
		shouldRefresh: result.shouldRefresh,
	};
}

async function refreshPublicModelMetadataCache(): Promise<PublicModelMetadataCacheValue | undefined> {
	if (process.env.NEWAPI_FETCH_MODEL_METADATA === "false") return undefined;

	return await refreshCachedValue({
		namespace: "metadata",
		key: getPublicModelMetadataCacheKey(),
		ttlMs: MODEL_METADATA_CACHE_TTL_MS,
		readValue: readPublicModelMetadataCacheValue,
		fetchValue: fetchPublicModelMetadataEntries,
	});
}

async function fetchPublicModelMetadataEntries(): Promise<PublicModelMetadataCacheValue | undefined> {
	try {
		const response = await fetch(MODELS_DEV_URL);
		if (!response.ok) {
			notify(
				`[${PROVIDER_ID}] Failed to fetch public model metadata: ${response.status} ${response.statusText}`,
				"warning",
			);
			return undefined;
		}

		const payload = asRecord(await response.json());
		if (!payload) return [];

		const entries: PublicModelMetadataCacheValue = [];
		for (const [key, value] of Object.entries(payload)) {
			if (!isOfficialModelsDevId(key)) continue;

			const model = asRecord(value);
			if (!model) continue;

			const metadata = toPublicModelMetadata(model);
			for (const lookupId of getPublicModelLookupIds(key, metadata.id ?? key)) {
				entries.push({ lookupId: normalizeModelLookupId(lookupId), metadata });
			}
		}

		return entries;
	} catch (error) {
		notify(
			`[${PROVIDER_ID}] Failed to fetch public model metadata: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
		return undefined;
	}
}

function toPublicModelMetadataMap(entries: PublicModelMetadataCacheValue): Map<string, PublicModelMetadata> {
	const metadataById = new Map<string, PublicModelMetadata>();
	for (const entry of entries) {
		metadataById.set(normalizeModelLookupId(entry.lookupId), entry.metadata);
	}
	return metadataById;
}

function toPublicModelMetadata(model: Record<string, unknown>): PublicModelMetadata {
	const metadata: PublicModelMetadata = {};
	const id = readString(model, "id");
	const name = readString(model, "name");
	const modalities = asRecord(model.modalities);
	const limit = asRecord(model.limit);
	const input = parsePublicModelInputs(modalities?.input);
	const contextWindow = readPositiveInteger(limit, "context");
	const maxTokens = readPositiveInteger(limit, "output");

	if (id) metadata.id = id;
	if (name) metadata.name = name;
	if (typeof model.reasoning === "boolean") metadata.reasoning = model.reasoning;
	if (input) metadata.input = input;
	if (contextWindow) metadata.contextWindow = contextWindow;
	if (maxTokens) metadata.maxTokens = maxTokens;

	return metadata;
}

function findPublicModelMetadata(
	id: string,
	publicModelMetadata: Map<string, PublicModelMetadata>,
): PublicModelMetadata | undefined {
	return (
		publicModelMetadata.get(normalizeModelLookupId(id)) ??
		publicModelMetadata.get(normalizeModelLookupId(stripProviderPrefix(id)))
	);
}

function getPublicModelLookupIds(key: string, id: string): string[] {
	return [
		...new Set([key, id, stripProviderPrefix(key), stripProviderPrefix(id)].filter((lookupId) => lookupId.length > 0)),
	];
}

function isOfficialModelsDevId(id: string): boolean {
	const slashIndex = id.indexOf("/");
	if (slashIndex <= 0 || slashIndex === id.length - 1) return false;

	const provider = id.slice(0, slashIndex).toLowerCase();
	const model = id.slice(slashIndex + 1);
	return OFFICIAL_MODELS_DEV_PATTERNS.some((pattern) => pattern.provider === provider && pattern.model.test(model));
}

function stripProviderPrefix(id: string): string {
	const slashIndex = id.indexOf("/");
	return slashIndex === -1 ? id : id.slice(slashIndex + 1);
}

function normalizeModelLookupId(id: string): string {
	return id.trim().toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readHeaderRecord(value: unknown): Record<string, string> | undefined {
	const record = asRecord(value);
	if (!record) return undefined;

	const headers = Object.fromEntries(
		Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function readPositiveInteger(record: Record<string, unknown> | undefined, key: string): number | undefined {
	if (!record) return undefined;

	const value = record[key];
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parsePublicModelInputs(value: unknown): ModelInput[] | undefined {
	if (!Array.isArray(value)) return undefined;

	const inputs = value.filter((input): input is ModelInput => input === "text" || input === "image");
	return inputs.length > 0 ? [...new Set(inputs)] : undefined;
}

function getModelRoute(
	id: string,
	metadata: PublicModelMetadata | undefined,
): { api: NewApiBackendApi; baseUrl: string } {
	const candidates = getModelRouteCandidates(id, metadata);

	if (candidates.some(isClaudeModelId)) {
		return { api: "anthropic-messages", baseUrl: BASE_URL };
	}

	if (candidates.some(isGoogleModelId)) {
		return { api: "google-generative-ai", baseUrl: getGatewayBaseUrl("v1beta") };
	}

	if (candidates.some(supportsOpenAiResponsesApi)) {
		return { api: "openai-responses", baseUrl: getOpenAiBaseUrl() };
	}

	return { api: "openai-completions", baseUrl: getOpenAiBaseUrl() };
}

function getModelRouteCandidates(id: string, metadata: PublicModelMetadata | undefined): string[] {
	return [
		...new Set(
			[
				id,
				stripProviderPrefix(id),
				metadata?.id,
				metadata?.id ? stripProviderPrefix(metadata.id) : undefined,
				metadata?.name,
			]
				.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
				.map(normalizeModelLookupId),
		),
	];
}

function isClaudeModelId(id: string): boolean {
	return id.startsWith("anthropic/claude") || id.startsWith("claude");
}

function isGoogleModelId(id: string): boolean {
	return id.startsWith("google/gemini") || id.startsWith("gemini");
}

function supportsOpenAiResponsesApi(id: string): boolean {
	return id.startsWith("openai/gpt-5") || id.startsWith("gpt-5") || /^openai\/o\d/.test(id) || /^o\d/.test(id);
}

function getModelCompat(
	id: string,
	metadata: PublicModelMetadata | undefined,
	reasoning: boolean,
): NewApiModelConfig["compat"] {
	const candidates = getModelRouteCandidates(id, metadata);
	const thinkingFormat = getThinkingFormat(candidates);

	return {
		supportsDeveloperRole: candidates.some(isOpenAiModelId),
		maxTokensField: getMaxTokensField(candidates),
		sendSessionAffinityHeaders: true,
		sessionAffinityFormat: "openai",
		...(reasoning ? { supportsReasoningEffort: supportsReasoningEffort(candidates) } : {}),
		...(thinkingFormat ? { thinkingFormat } : {}),
		...(candidates.some(usesClaudeAdaptiveThinking) ? { forceAdaptiveThinking: true } : {}),
		...(candidates.some(isClaudeAdaptiveTemperatureUnsupported) ? { supportsTemperature: false } : {}),
	};
}

function getThinkingFormat(candidates: string[]): ThinkingFormat | undefined {
	if (candidates.some(isDeepSeekModelId)) return "deepseek";
	if (candidates.some(isQwenModelId)) return "qwen";
	if (candidates.some(isGlmModelId)) return "zai";

	return undefined;
}

function getThinkingLevelMap(id: string, metadata: PublicModelMetadata | undefined): ThinkingLevelMap | undefined {
	const candidates = getModelRouteCandidates(id, metadata);

	if (candidates.some(isDeepSeekModelId) || candidates.some(isGlmModelId)) {
		return {
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		};
	}

	return (
		getGeminiThinkingLevelMap(candidates) ??
		getClaudeThinkingLevelMap(candidates) ??
		getOpenAiThinkingLevelMap(candidates)
	);
}

function getGeminiThinkingLevelMap(candidates: string[]): ThinkingLevelMap | undefined {
	if (candidates.some(isGemini31ProModelId)) {
		return { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
	}
	if (candidates.some(isGemini3ProModelId)) {
		return { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null };
	}
	if (candidates.some(isGemini3ModelId)) {
		return { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null };
	}
	if (candidates.some(isGemini25ProModelId)) {
		return { off: null, minimal: "128", low: "2048", medium: "8192", high: "32768", xhigh: null, max: null };
	}
	if (candidates.some(isGemini25ModelId)) {
		return { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null };
	}

	return undefined;
}

function getClaudeThinkingLevelMap(candidates: string[]): ThinkingLevelMap | undefined {
	if (candidates.some(isClaudeOpus47OrLaterModelId)) {
		return { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
	}
	if (candidates.some(isClaudeAdaptiveMaxModelId)) {
		return { minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: "max" };
	}
	if (candidates.some(isClaudeEffortModelId)) {
		return { minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
	}

	return undefined;
}

function getOpenAiThinkingLevelMap(candidates: string[]): ThinkingLevelMap | undefined {
	if (candidates.some(isGptProReasoningModelId)) {
		return { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null };
	}
	if (candidates.some(isGpt51CodexMaxModelId)) {
		return { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null };
	}
	if (candidates.some(isGpt51ReasoningModelId)) {
		return { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
	}
	if (candidates.some(isGpt56ReasoningModelId)) {
		return {
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		};
	}
	if (candidates.some(isLatestGptReasoningModelId)) {
		return {
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		};
	}
	if (candidates.some(isGpt5ReasoningModelId)) {
		return { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null };
	}
	if (candidates.some(isOpenAiOModelId)) {
		return { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
	}

	return undefined;
}

function getMaxTokensField(candidates: string[]): MaxTokensField {
	if (candidates.some(usesMaxTokensField)) return "max_tokens";
	return "max_completion_tokens";
}

function supportsReasoningEffort(candidates: string[]): boolean {
	return (
		candidates.some(isOpenAiReasoningModelId) || candidates.some(isDeepSeekModelId) || candidates.some(isGlmModelId)
	);
}

function supportsThinking(id: string): boolean {
	return (
		isOpenAiReasoningModelId(id) ||
		isDeepSeekModelId(id) ||
		isGeminiThinkingModelId(id) ||
		isClaudeThinkingModelId(id) ||
		isGlmModelId(id)
	);
}

function isOpenAiModelId(id: string): boolean {
	return id.startsWith("openai/gpt") || id.startsWith("gpt") || isOpenAiOModelId(id);
}

function isOpenAiReasoningModelId(id: string): boolean {
	return isGpt5ReasoningModelId(id) || isOpenAiOModelId(id);
}

function isOpenAiOModelId(id: string): boolean {
	return /^openai\/o\d/.test(id) || /^o\d/.test(id);
}

function isGpt5ReasoningModelId(id: string): boolean {
	return id.startsWith("openai/gpt-5") || id.startsWith("gpt-5");
}

function isGpt56ReasoningModelId(id: string): boolean {
	return /^(?:openai\/)?gpt-5\.6(?:$|[-_/])/.test(id);
}

function isLatestGptReasoningModelId(id: string): boolean {
	return /^(?:openai\/)?gpt-5\.(?:4|5)(?:$|[-_/])/.test(id);
}

function isGpt51ReasoningModelId(id: string): boolean {
	return /^(?:openai\/)?gpt-5\.1(?:$|[-_/])/.test(id);
}

function isGpt51CodexMaxModelId(id: string): boolean {
	return /^(?:openai\/)?gpt-5\.1-codex-max(?:$|[-_/])/.test(id);
}

function isGptProReasoningModelId(id: string): boolean {
	// Matches gpt-5-pro / gpt-5.5-pro style IDs. GPT-5.6 pro variants use
	// names like gpt-5.6-sol-pro and are handled by isGpt56ReasoningModelId.
	return /^(?:openai\/)?gpt-5(?:\.\d+)?-pro(?:$|[-_/])/.test(id);
}

function usesMaxTokensField(id: string): boolean {
	return (
		id.startsWith("moonshotai/kimi") ||
		id.startsWith("kimi") ||
		id.startsWith("minimax/") ||
		id.startsWith("minimax") ||
		id.startsWith("zhipuai/glm") ||
		id.startsWith("glm") ||
		id.startsWith("alibaba/qwen") ||
		id.startsWith("qwen") ||
		id.startsWith("deepseek/deepseek") ||
		id.startsWith("deepseek")
	);
}

function isDeepSeekModelId(id: string): boolean {
	return id.startsWith("deepseek/deepseek") || id.startsWith("deepseek");
}

function isQwenModelId(id: string): boolean {
	return id.startsWith("alibaba/qwen") || id.startsWith("qwen");
}

function isGlmModelId(id: string): boolean {
	return id.startsWith("zhipuai/glm") || id.startsWith("glm");
}

function isGeminiThinkingModelId(id: string): boolean {
	return isGemini25ModelId(id) || isGemini3ModelId(id);
}

function isGemini25ModelId(id: string): boolean {
	return id.includes("gemini-2.5-");
}

function isGemini25ProModelId(id: string): boolean {
	return id.includes("gemini-2.5-pro");
}

function isGemini3ModelId(id: string): boolean {
	return /gemini-3(?:\.\d+)?-/.test(id);
}

function isGemini31ProModelId(id: string): boolean {
	return id.includes("gemini-3.1-pro");
}

function isGemini3ProModelId(id: string): boolean {
	return id.includes("gemini-3-pro") || id.includes("gemini-3.0-pro");
}

function isClaudeThinkingModelId(id: string): boolean {
	const version = getClaudeVersion(id);
	return (
		id.includes("claude-mythos") || !!(version && (version.major >= 4 || (version.major === 3 && version.minor >= 7)))
	);
}

function usesClaudeAdaptiveThinking(id: string): boolean {
	const version = getClaudeVersion(id);
	if (id.includes("claude-mythos")) return true;
	if (!version) return false;
	if (version.family === "opus") return version.major > 4 || (version.major === 4 && version.minor >= 6);
	if (version.family === "sonnet") return version.major > 4 || (version.major === 4 && version.minor >= 6);
	return false;
}

function isClaudeAdaptiveTemperatureUnsupported(id: string): boolean {
	const version = getClaudeVersion(id);
	return id.includes("claude-mythos") || !!(version?.family === "opus" && version.major === 4 && version.minor >= 7);
}

function isClaudeOpus47OrLaterModelId(id: string): boolean {
	const version = getClaudeVersion(id);
	return !!(version?.family === "opus" && version.major === 4 && version.minor >= 7);
}

function isClaudeAdaptiveMaxModelId(id: string): boolean {
	const version = getClaudeVersion(id);
	if (id.includes("claude-mythos")) return true;
	return !!(
		version &&
		((version.family === "opus" && version.major === 4 && version.minor === 6) ||
			(version.family === "sonnet" && version.major === 4 && version.minor === 6))
	);
}

function isClaudeEffortModelId(id: string): boolean {
	const version = getClaudeVersion(id);
	return id.includes("claude-mythos") || !!(version?.family === "opus" && version.major === 4 && version.minor >= 5);
}

function getClaudeVersion(
	id: string,
): { family: "opus" | "sonnet" | "haiku"; major: number; minor: number } | undefined {
	const match = /claude-(opus|sonnet|haiku)-(\d+)(?:[.-](\d+))?/.exec(id);
	if (!match) return undefined;

	return {
		family: match[1] as "opus" | "sonnet" | "haiku",
		major: Number(match[2]),
		minor: match[3] ? Number(match[3]) : 0,
	};
}

function getOpenAiBaseUrl(): string {
	return getGatewayBaseUrl("v1");
}

function getGatewayBaseUrl(path: string): string {
	return `${BASE_URL}/${path.replace(/^\/+/, "")}`;
}

function normalizeGatewayBaseUrl(value: string): string {
	return normalizeBaseUrl(value).replace(/\/v1(?:beta)?$/i, "");
}

function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
	if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
	return fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseInputs(value: string): ModelInput[] {
	const inputs = value
		.split(",")
		.map((input) => input.trim())
		.filter((input): input is ModelInput => input === "text" || input === "image");
	return inputs.length > 0 ? [...new Set(inputs)] : ["text"];
}

function parseHeaders(value: string | undefined): Record<string, string> {
	if (!value) return {};

	try {
		const parsed = JSON.parse(value) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

		return Object.fromEntries(
			Object.entries(parsed)
				.filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
				.map(([key, headerValue]) => [key, headerValue]),
		);
	} catch {
		return {};
	}
}

function formatModelName(id: string): string {
	return id
		.split(/[._/-]+/)
		.filter(Boolean)
		.map((part) => (part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
		.join(" ");
}

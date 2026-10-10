// ABOUTME: Tests models.dev catalog parsing and pi thinking-level conversion.
// ABOUTME: Checks cache compatibility, official-source precedence, and special mappings.

import assert from "node:assert/strict";
import { test } from "node:test";

import { getThinkingLevelMap, parsePublicModelMetadataEntries, readCachedPublicModelMetadata } from "../index.js";

const MODEL_ID = "gpt-5.4";
const CANONICAL_ID = `openai/${MODEL_ID}`;
const MODEL_CONTEXT_WINDOW = 1_050_000;
const PROVIDER_CONTEXT_WINDOW = 200_000;
const EFFORTS = ["none", "low", "medium", "high", "xhigh"];

function catalog(reasoningOptions: unknown) {
	return {
		models: {
			[CANONICAL_ID]: {
				id: CANONICAL_ID,
				name: "GPT-5.4",
				reasoning: true,
				limit: { context: MODEL_CONTEXT_WINDOW },
				modalities: { input: ["text", "image"] },
			},
		},
		providers: {
			openai: {
				models: {
					[MODEL_ID]: {
						id: MODEL_ID,
						reasoning: true,
						reasoning_options: reasoningOptions,
						limit: { context: PROVIDER_CONTEXT_WINDOW },
					},
				},
			},
			openrouter: {
				models: {
					[CANONICAL_ID]: { reasoning_options: [{ type: "effort", values: ["max"] }] },
				},
			},
		},
	};
}

function metadataFrom(payload: Record<string, unknown>, id = MODEL_ID) {
	return new Map(parsePublicModelMetadataEntries(payload).map((entry) => [entry.lookupId, entry.metadata])).get(id);
}

test("catalog joins official effort data without replacing model facts", () => {
	const metadata = metadataFrom(catalog([{ type: "effort", values: EFFORTS }]));
	assert.equal(metadata?.contextWindow, MODEL_CONTEXT_WINDOW);
	assert.deepEqual(metadata?.input, ["text", "image"]);
	assert.equal(metadata?.id, CANONICAL_ID);
	assert.deepEqual(metadata?.reasoningEfforts, EFFORTS);
	assert.deepEqual(getThinkingLevelMap(MODEL_ID, metadata), {
		off: "none",
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: null,
	});
});

test("effort data overrides stale model-name hardcodes", () => {
	assert.deepEqual(getThinkingLevelMap("gpt-5.6", { reasoningEfforts: ["high"] }), {
		off: null,
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	});
});

test("unknown, default, and null effort values do not enable pi levels", () => {
	const metadata = metadataFrom(
		catalog([{ type: "effort", values: [null, "null", "default", "future", "low", "low"] }]),
	);
	assert.deepEqual(metadata?.reasoningEfforts, ["default", "future", "low"]);
	assert.deepEqual(getThinkingLevelMap(MODEL_ID, metadata), {
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: null,
		xhigh: null,
		max: null,
	});
});

test("explicit empty effort list disables all levels", () => {
	const metadata = metadataFrom(catalog([{ type: "effort", values: [] }]));
	assert.deepEqual(metadata?.reasoningEfforts, []);
	assert.ok(Object.values(getThinkingLevelMap(MODEL_ID, metadata) ?? {}).every((value) => value === null));
});

test("toggle, budget, and malformed options do not become effort lists", () => {
	for (const options of [
		[],
		[{ type: "toggle" }],
		[{ type: "budget_tokens", min: 0 }],
		[null, { type: "effort", values: "high" }],
	]) {
		const metadata = metadataFrom(catalog(options));
		assert.equal(metadata?.reasoningEfforts, undefined);
		assert.deepEqual(getThinkingLevelMap(MODEL_ID, metadata), getThinkingLevelMap(MODEL_ID, undefined));
	}
});

test("legacy flat metadata and provider-only api responses remain readable", () => {
	const payload = catalog([{ type: "effort", values: EFFORTS }]);
	assert.equal(metadataFrom(payload.models)?.reasoningEfforts, undefined);
	assert.deepEqual(metadataFrom(payload.providers)?.reasoningEfforts, EFFORTS);
});

test("provider entries can supply metadata for models absent from the model-only catalog", () => {
	const payload = catalog([{ type: "effort", values: EFFORTS }]);
	payload.models = {} as typeof payload.models;
	assert.equal(metadataFrom(payload)?.contextWindow, PROVIDER_CONTEXT_WINDOW);
	assert.deepEqual(metadataFrom(payload)?.reasoningEfforts, EFFORTS);
});

test("effort values survive a metadata cache round trip", () => {
	const metadata = metadataFrom(catalog([{ type: "effort", values: EFFORTS }]));
	const restored = readCachedPublicModelMetadata(JSON.parse(JSON.stringify(metadata)));
	assert.deepEqual(restored, metadata);
	assert.deepEqual(getThinkingLevelMap(MODEL_ID, restored), getThinkingLevelMap(MODEL_ID, metadata));
	assert.deepEqual(readCachedPublicModelMetadata({ reasoningEfforts: [] })?.reasoningEfforts, []);
});

test("old and malformed cache entries keep the fallback", () => {
	assert.equal(readCachedPublicModelMetadata({ reasoning: true })?.reasoningEfforts, undefined);
	assert.equal(readCachedPublicModelMetadata({ reasoningEfforts: ["high", null] })?.reasoningEfforts, undefined);
});

test("Gemini 2.5 Pro token mappings remain unchanged even with effort metadata", () => {
	const map = getThinkingLevelMap("gemini-2.5-pro", { reasoningEfforts: ["low", "high"] });
	assert.deepEqual(map, {
		off: null,
		minimal: "128",
		low: "2048",
		medium: "8192",
		high: "32768",
		xhigh: null,
		max: null,
	});
});

test("DeepSeek effort data and legacy mappings both retain high/max", () => {
	for (const metadata of [undefined, { reasoningEfforts: ["high", "max"] }]) {
		const map = getThinkingLevelMap("deepseek-v4.1-flash", metadata);
		assert.equal(map?.high, "high");
		assert.equal(map?.max, "max");
		assert.equal(map?.low, null);
	}
});

# Pi NewAPI Provider

A pi custom provider template for NewAPI gateways.

## Usage

```bash
# Install
pi install https://github.com/pzyyll/pi-newapi-provider
```

Set `NEWAPI_*` values in the environment before starting pi. This extension does not load `.env` files.

```bash
export NEWAPI_BASE_URL="http://localhost:3000"

# Option 1: provide the API key through the environment
export NEWAPI_API_KEY="sk-..."

# Test this local package directly
# pi -e .
```

You can also configure the matching provider in `~/.pi/agent/models.json`. Provider-level `baseUrl`, `apiKey`, `headers`, and `authHeader` values from `models.json` take precedence over this extension's environment-based settings.

```json
{
	"providers": {
		"newapi": {
			"baseUrl": "http://localhost:3000",
			"apiKey": "$NEWAPI_API_KEY",
			"headers": {
				"x-custom-header": "$CUSTOM_HEADER"
			}
		}
	}
}
```

The extension only uses those `models.json` fields as provider parameter overrides; model discovery and model compatibility metadata still come from this extension.

For the API key, you can also run `/login`, choose **Use an API key**, and select **NewAPI Gateway**. pi stores that credential in `~/.pi/agent/auth.json` under the provider id, `newapi` by default. API key priority is `models.json` provider config, then `auth.json`, then `NEWAPI_API_KEY`.

Then select a model from the `newapi/...` provider in `/model`.

## Model discovery

On startup, the extension calls `GET <baseUrl>/v1/models` when an API key is available from `models.json`, `auth.json` for the provider id, or `NEWAPI_API_KEY`. If discovery fails, it falls back to `NEWAPI_MODELS`.

If you save the API key with `/login`, pi refreshes configured providers (including this extension's `refreshModels`) so discovered models become available without a manual restart.

```bash
export NEWAPI_MODELS="gpt-4o-mini,qwen3-coder"
export NEWAPI_FETCH_MODELS=false
```

## Model cache

Model discovery cache is enabled by default to keep pi startup fast after the first successful discovery. Cache files are stored under `~/.pi/agent/cache/newapi-provider/`.

- The extension registers immediately from cache/env models.
- Pi 0.80.8+ calls provider `refreshModels` during ModelRuntime startup, after `/login`, and when refreshing models (for example via `/model` or `pi update --models`).
- Fresh cache is reused without calling remote endpoints.
- Stale or missing cache is refreshed during `refreshModels` when network access is allowed.
- If discovery fails or is disabled, the extension falls back to `NEWAPI_MODELS`.

Cache TTL values are seconds:

```bash
export NEWAPI_MODEL_CACHE=true
export NEWAPI_MODELS_CACHE_TTL=1800          # /v1/models, 30 minutes
export NEWAPI_MODEL_METADATA_CACHE_TTL=86400 # models.dev metadata, 24 hours
export NEWAPI_MODEL_CACHE_STALE_TTL=604800   # stale cache usable up to 7 days
export NEWAPI_MODEL_CACHE_REFRESH=background # background/blocking both refresh on demand; off disables network refresh
```

Set `NEWAPI_MODEL_CACHE=false` to disable all local model cache reads and writes.

## Useful settings

- `NEWAPI_PROVIDER_ID` — provider id used in `/model` and `auth.json`. Defaults to `newapi`.
- `NEWAPI_PROVIDER_NAME` — display name shown in pi. Defaults to `NewAPI Gateway`.
- `NEWAPI_BASE_URL` — gateway base URL. Overridden by matching `models.json` provider `baseUrl`.
- `NEWAPI_API_KEY` — gateway API key fallback when neither matching `models.json` provider `apiKey` nor `auth.json` contains this provider id.
- `NEWAPI_INPUTS` — comma-separated inputs: `text` or `text,image`.
- `NEWAPI_REASONING` — set `true` if all configured models support reasoning.
- `NEWAPI_THINKING_FORMAT` — one of `openai`, `openrouter`, `deepseek`, `together`, `zai`, `qwen`, or `qwen-chat-template`.
- `NEWAPI_HEADERS` — JSON object of additional headers. Overridden by matching `models.json` provider `headers`.
- `NEWAPI_SESSION_ID_HEADER` — header name used for the pi session id. Defaults to `x-session-id`.
- `NEWAPI_DEBUG_SESSION_HEADERS` — set to `1` to log whether the session header was injected.
- `NEWAPI_MODEL_CACHE` — set to `false` to disable local cache for `/v1/models` and `models.dev` metadata.
- `NEWAPI_MODELS_CACHE_TTL` — fresh-cache TTL for NewAPI `/v1/models`, in seconds. Defaults to `1800`.
- `NEWAPI_MODEL_METADATA_CACHE_TTL` — fresh-cache TTL for `models.dev` metadata, in seconds. Defaults to `86400`.
- `NEWAPI_MODEL_CACHE_STALE_TTL` — maximum stale cache age, in seconds. Defaults to `604800`.
- `NEWAPI_MODEL_CACHE_REFRESH` — network refresh policy for `refreshModels`: `background`/`blocking` (default behavior, refresh when stale) or `off` (cache/env only).

For per-model metadata, edit `toProviderModel()` in `index.ts`.

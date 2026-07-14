# Code Context: pi Provider Session ID 发送机制分析

## 概述

pi 的 `sessionId`（定义于 `StreamOptions.sessionId`）用于会话级 prompt caching 和路由亲和性（cache affinity routing）。不同的 provider API 以不同的方式将这个值发送到上游。

---

## 一、Provider 维度：sessionId 发送方式汇总

### 1. `openai-completions` (Chat Completions API)

**源文件**: `packages/ai/src/providers/openai-completions.ts`

**机制**: 受 `compat.sendSessionAffinityHeaders` 控制（默认 `false`）

- **条件**: `sessionId` 非空 + `cacheRetention !== "none"` + `compat.sendSessionAffinityHeaders === true`
- **HTTP Headers**：三个头同时发送
  - `session_id` → `sessionId`
  - `x-client-request-id` → `sessionId`
  - `x-session-affinity` → `sessionId`
- **JSON Body**（`buildParams`）:
  - `prompt_cache_key` → `clampOpenAIPromptCacheKey(sessionId)`，仅当 `model.baseUrl` 含 `api.openai.com` 或 `cacheRetention === "long"` 时
  - `prompt_cache_retention` → `"24h"`，仅限 `cacheRetention === "long"` 且 `compat.supportsLongCacheRetention === true`

**关键代码 (第 468-471 行)**:

```typescript
if (sessionId && compat.sendSessionAffinityHeaders) {
	headers.session_id = sessionId;
	headers["x-client-request-id"] = sessionId;
	headers["x-session-affinity"] = sessionId;
}
```

**注意**: `sendSessionAffinityHeaders` 在 `detectCompat()` 中硬编码为 `false`。若要启用，必须在模型定义中显式设置 `compat.sendSessionAffinityHeaders: true`。

---

### 2. `openai-responses` (OpenAI Responses API)

**源文件**: `packages/ai/src/api/openai-responses.ts`

**机制**: 受 `compat.sessionAffinityFormat` 控制（默认自动检测：OpenRouter 为 `"openrouter"`，其余为 `"openai"`）

- **条件**: `sessionId` 非空 + `cacheRetention !== "none"`
- **HTTP Headers**:
  - `session_id` → 仅当 `compat.sessionAffinityFormat === "openai"`
  - `x-client-request-id` → `sessionId`（当 `sessionAffinityFormat` 为 `"openai"` 或 `"openai-nosession"` 时发送）
  - `x-session-id` → `sessionId`（仅当 `compat.sessionAffinityFormat === "openrouter"`）
- **JSON Body**:
  - `prompt_cache_key` → `clampOpenAIPromptCacheKey(sessionId)`，仅当 `cacheRetention !== "none"`
  - `prompt_cache_retention` → `"24h"`，仅当 `cacheRetention === "long"` 且 `compat.supportsLongCacheRetention === true`

**关键代码**:

```typescript
if (sessionId) {
	if (compat.sessionAffinityFormat === "openrouter") {
		headers["x-session-id"] = sessionId;
	} else {
		if (compat.sessionAffinityFormat === "openai") {
			headers.session_id = sessionId;
		}
		headers["x-client-request-id"] = sessionId;
	}
}
```

**注意**: `sessionAffinityFormat` 取代了已移除的 `sendSessionIdHeader` 标志（pi 0.80.7）。取值：`"openai"`（发 `session_id` + `x-client-request-id`，等价于旧 `sendSessionIdHeader: true`）、`"openai-nosession"`（仅 `x-client-request-id`，等价于旧 `sendSessionIdHeader: false`）、`"openrouter"`（仅 `x-session-id`）。默认由 `detectSessionAffinityFormat(model)` 自动检测。

---

### 3. `openai-codex-responses` (OpenAI Codex Responses API)

**源文件**: `packages/ai/src/providers/openai-codex-responses.ts`

**机制**: 始终发送，无条件

- **SSE Transport (第 1464-1466 行)**:
  - `session-id` (注意是连字符，不是下划线) → `sessionId`
  - `x-client-request-id` → `sessionId`
- **WebSocket Transport (第 1487-1488 行)**:
  - `session-id` → `requestId` (从 `sessionId` 派生，若无则用 UUID)
  - `x-client-request-id` → `requestId`
- **JSON Body**:
  - `prompt_cache_key` → `clampOpenAIPromptCacheKey(sessionId)`（无条件，始终发送）
- **WebSocket Session 缓存**:
  - 以 `sessionId` 为 key 缓存 WebSocket 连接，5 分钟无活动后过期
  - 同一个 `sessionId` 的后续请求复用 WebSocket，通过 `previous_response_id` 实现增量上下文

**关键代码 (SSE, 第 1464-1466 行)**:

```typescript
if (sessionId) {
	headers.set("session-id", sessionId);
	headers.set("x-client-request-id", sessionId);
}
```

**注意**: Codex 使用 `session-id`（连字符）而非 `session_id`（下划线），这是为了与 OpenAI Codex CLI 的代理兼容（`session_id` 在 HTTP 头规范中不标准，某些代理会拦截）。

---

### 4. `anthropic-messages` (Anthropic Messages API)

**源文件**: `packages/ai/src/providers/anthropic.ts`

**机制**: 受 `compat.sendSessionAffinityHeaders` 控制（默认根据 provider 自动检测）

- **条件**: `sessionId` 非空 + `cacheRetention !== "none"` + `compat.sendSessionAffinityHeaders === true`
- **HTTP Headers**:
  - `x-session-affinity` → `sessionId`（仅当 `sendSessionAffinityHeaders === true`）
- **自动检测规则 (第 176-177 行)**:
  - Fireworks（`api.fireworks.ai`）: `true`
  - Cloudflare AI Gateway Anthropic: `true`
  - 其他 provider: `false`

**关键代码 (第 872 行)**:

```typescript
const sessionAffinityHeaders: Record<string, string | null> =
	sessionId && getAnthropicCompat(model).sendSessionAffinityHeaders ? { "x-session-affinity": sessionId } : {};
```

**注意**: Anthropic provider 不发送 `session_id` 或 `x-client-request-id`。它使用 Anthropic SDK，session ID 只通过自定义头 `x-session-affinity` 传递。Anthropic 自己的 prompt caching 机制通过 `cache_control` 标记处理，与 sessionId 无关。

---

### 5. `mistral-conversations` (Mistral API)

**源文件**: `packages/ai/src/providers/mistral.ts`

**机制**: 始终发送（无条件）

- **HTTP Headers**:
  - `x-affinity` → `sessionId`（Mistral KV-cache 复用专用头）
- **条件**: `sessionId` 存在且 `headers["x-affinity"]` 未被显式覆盖

**关键代码 (第 229-231 行)**:

```typescript
if (options?.sessionId && !headers["x-affinity"]) {
	headers["x-affinity"] = options.sessionId;
}
```

**注意**: Mistral 使用自己的 `x-affinity` 头，而非 OpenAI 系列的 `session_id` 或其他头。不移除已有的 `x-affinity`。

---

### 6. `azure-openai-responses` (Azure OpenAI Responses API)

**源文件**: `packages/ai/src/providers/azure-openai-responses.ts`

**机制**: 仅 JSON body，无 HTTP 头

- **JSON Body**:
  - `prompt_cache_key` → `clampOpenAIPromptCacheKey(sessionId)`（无条件，始终发送）
- **HTTP Headers**: 不发送任何 session 相关的头

---

### 7. `google-generative-ai` (Google Gemini API)

**源文件**: `packages/ai/src/providers/google.ts`

**机制**: ❌ 不支持 sessionId。Google provider 完全不读取 `sessionId`。

---

### 8. `google-vertex` (Google Vertex AI API)

**源文件**: `packages/ai/src/providers/google-vertex.ts`

**机制**: ❌ 不支持 sessionId。完全不读取 `sessionId`。

---

### 9. `amazon-bedrock` (AWS Bedrock)

**源文件**: `packages/ai/src/providers/amazon-bedrock.ts`

**机制**: ❌ 不支持 sessionId。完全不读取 `sessionId`。

---

### 10. `faux` (测试用 Faux Provider)

**源文件**: `packages/ai/src/providers/faux.ts`

**机制**: 本地模拟 prompt caching

- 使用 `sessionId` 作为 key 存储/读取本地 prompt 缓存
- 模拟 `cacheRead`/`cacheWrite` 数据
- 不发送任何 HTTP 请求

---

## 二、sessionId 流向总结

```
StreamOptions.sessionId
  │
  ├─► cacheRetention === "none" ? → undefined（跳过）
  │
  ├─► openai-completions
  │   ├── headers: session_id, x-client-request-id, x-session-affinity
  │   │           (仅当 sendSessionAffinityHeaders=true)
  │   └── body: prompt_cache_key, prompt_cache_retention
  │
  ├─► openai-responses
  │   ├── headers: session_id, x-client-request-id
  │   │           (session_id 可禁用, x-client-request-id 始终发送)
  │   └── body: prompt_cache_key, prompt_cache_retention
  │
  ├─► openai-codex-responses
  │   ├── headers: session-id, x-client-request-id (连字符)
  │   └── body: prompt_cache_key
  │
  ├─► anthropic-messages
  │   └── header: x-session-affinity (仅当 sendSessionAffinityHeaders=true)
  │
  ├─► mistral-conversations
  │   └── header: x-affinity
  │
  ├─► azure-openai-responses
  │   └── body: prompt_cache_key
  │
  ├─► faux
  │   └── 本地缓存 key
  │
  └─► google/google-vertex/bedrock
      └── ❌ 忽略 sessionId
```

---

## 三、兼容性控制（Compat 字段）

### `OpenAICompletionsCompat` (types.ts 第 413-419 行)

| 字段                         | 默认值                                        | 作用                                                                  |
| ---------------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| `supportsLongCacheRetention` | `true` (auto-detected)                        | 是否支持 `prompt_cache_retention: "24h"`                              |
| `cacheControlFormat`         | `"anthropic"` for OpenRouter Anthropic models | 缓存控制标记格式                                                      |
| `sendSessionAffinityHeaders` | `false`                                       | 是否发送 `session_id`, `x-client-request-id`, `x-session-affinity` 头 |

### `OpenAIResponsesCompat` (types.ts 第 423-427 行)

| 字段                         | 默认值                     | 作用                                                                                                                                                        |
| ---------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionAffinityFormat`      | auto-detected (`"openai"`) | Session 亲和性头格式：`"openai"` 发送 `session_id` + `x-client-request-id`；`"openai-nosession"` 仅 `x-client-request-id`；`"openrouter"` 仅 `x-session-id` |
| `supportsLongCacheRetention` | `true`                     | 是否支持 `prompt_cache_retention: "24h"`                                                                                                                    |

### `AnthropicMessagesCompat` (types.ts 第 442-446 行)

| 字段                         | 默认值                          | 作用                             |
| ---------------------------- | ------------------------------- | -------------------------------- |
| `sendSessionAffinityHeaders` | `true` for Fireworks/Cloudflare | 是否发送 `x-session-affinity` 头 |

---

## 四、NewAPI 侧对 session_id 的处理

**源文件**: `service/channel_affinity.go` + `service/channel_affinity_setting.go`

NewAPI 在自定义频道场景中通过 **channel affinity** 机制处理 session_id 的缓存路由：

1. **默认规则**：`"codex cli trace"` 规则从请求 JSON body 的 `prompt_cache_key`（gjson path）提取亲和性 key
2. **pass_headers**：规则模板会透传 `Session_id`（大小写不敏感）、`Originator`、`X-Codex-Beta-Features`、`User-Agent` 等头
3. **ParamOverride 中的 sync_fields**：支持在 `header:session_id` 与 `json:prompt_cache_key` 之间双向同步
4. **缓存**：亲和性命中后缓存 channel_ID，后续同一 session 的请求路由到同一 channel

这意味着：

- 如果 pi 客户端通过 OpenAI 兼容协议（`openai-completions` 或 `openai-responses`）发送了 `session_id` 头 或 `prompt_cache_key` body 字段，NewAPI 可以使用 channel affinity 做缓存路由
- 如果 pi 客户端是使用 Codex provider（`openai-codex-responses`），它会发送 `session-id`（连字符）头，但 NewAPI 的默认规则是读取 `prompt_cache_key` body 字段，所以头的大小写不影响

---

## 五、关键风险和约束

1. **`sendSessionAffinityHeaders` 默认 false**：`openai-completions` 的 session 亲和性头默认不发送，必须在模型定义中显式开启
2. **`session_id` vs `session-id`**：Codex provider 使用连字符版本，其他 OpenAI 兼容 provider 使用下划线版本。如果 NewAPI 的 `pass_headers` 规则只配置了一个版本，可能导致另一个版本不被透传
3. **`x-client-request-id` 在 `openai-responses` 中由 `sessionAffinityFormat` 控制**：`"openai"` 和 `"openai-nosession"` 都发送此头，仅 `"openrouter"` 不发送（改发 `x-session-id`）
4. **Azure 无 header**：Azure OpenAI Responses 只在 body 中发送 `prompt_cache_key`，不发送任何 session 头
5. **Google/Bedrock 完全不支持**：sessionId 对这些 provider 没有效果

---

## 六、Files Likely Needing Changes (for NewAPI custom provider)

1. **`packages/ai/src/providers/openai-completions.ts`** — `createClient()` 函数中的 session affinity headers 逻辑（第 468-471 行）
2. **`packages/ai/src/api/openai-responses.ts`** - session 亲和性头逻辑（`sessionAffinityFormat` 控制 `session_id`/`x-client-request-id`/`x-session-id`）
3. **`packages/ai/src/types.ts`** — `OpenAICompletionsCompat` 和 `OpenAIResponsesCompat` 接口定义（第 413-427 行）
4. **`packages/ai/src/providers/openai-prompt-cache.ts`** — `clampOpenAIPromptCacheKey` 工具函数

---

## Start Here

首先看 **`packages/ai/src/providers/openai-completions.ts`** 的 `createClient()` 函数(第 451-487 行)和 `buildParams()` 函数(第 504-610 行),这是 OpenAI 兼容 provider 的核心逻辑,理解 sessionId 如何在 header 和 body 中发送,然后对比 **`packages/ai/src/api/openai-responses.ts`** 的对应逻辑,确定 NewAPI custom provider 需要复制哪些行为。

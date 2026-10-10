# Optional site-owned basic AI chat

Disabled by default. Set SERVER_AI_ENABLED=true and fill SERVER_AI_API_KEY,
SERVER_AI_BASE_URL and SERVER_AI_MODEL in the backend environment. Use an
OpenAI-compatible official HTTPS base URL, without credentials/query/fragment.
Only these domestic vendors' exact bases and own model families are accepted:
- https://dashscope.aliyuncs.com/compatible-mode/v1 with qwen… models
- https://api.deepseek.com with deepseek-… models
- https://api.xiaomimimo.com/v1 with mimo-… models

No international/US/Hong Kong/Coding-plan endpoint is accepted. A family check
is not proof that an arbitrary model ID exists: use the operator's verified
current official model ID. No version is automatically selected or upgraded.
Domestic-vendor ownership does not guarantee mainland data residency; only
Alibaba's specified endpoint has been identified here as its Beijing region.
Provider pricing and data handling require separate review before enabling.
Official sources: https://help.aliyun.com/zh/model-studio/base-url and
https://api-docs.deepseek.com/ and https://platform.xiaomimimo.com/ .
No model, endpoint or key is supplied by this repository. Partial/invalid
configuration keeps this optional feature unavailable; non-AI and BYOK features
continue unchanged. Operators configure values themselves; do not commit keys.

Model Center contains a separate, collapsed single-turn panel. It shows the
validated service origin and configured model. Each send requires explicit
consent to send only that input to that provider. Response is labeled AI-generated.
No conversation history, files, memories or tools are attached. Text and result
are not saved to user history or browser storage; the remote provider may retain
requests according to its policies. The endpoint does not enter personal catalogs,
default models, agents, tasks or TTS. BYOK remains authoritative and is never
silently replaced when unavailable. Retired vendor-key variables remain ignored.

The server requires session authentication, checks the consent destination token,
and rejects client endpoint/model/history overrides. It validates public DNS and
connection-time DNS, forbids redirects and proxy environment use, and never honors
AI_ALLOWED_LOCAL_ORIGINS for site requests. Error bodies are sanitized and direct
key echoes are redacted. The server has no startup/provider health paid calls.

Limits: 4,000 input characters, 1,024 requested output tokens, 16,000 returned
characters, 20-second provider timeout, 25-second route cancellation, 2 concurrent
site calls per backend process, and 3 attempts/minute/account. Shared admission
reserves at most 10 attempts/minute and 100 attempts/UTC day in the durable auth
store before sending; failed/uncertain calls consume an attempt. PostgreSQL CAS
conflicts fail closed rather than overwriting another process's reservation.
Use one backend instance for the concurrency guarantee. Local JSON remains
single-process only. Restoring the auth DB also restores this budget state;
provider-side hard spending caps are required and are not configured by this code.
Request/token limits are not a currency budget or a promise of free inference.

Status checks are read-only, deduplicate DNS lookups, cache results for 30 seconds,
and stop waiting after three seconds; slow DNS can leave the single validation
lookup pending. Closing the panel aborts waiting but cannot recall text already
sent or guarantee the provider stops processing it. No automatic retry occurs.
No actual provider account/API call or Render deployment was used for tests.

See render-free-deployment.md for hosting limits. Free web filesystem loss affects
uploads/audio; merely adding an external PG does not make those bytes durable.

## Cost-conscious setup

For demonstration and software registration preparation, prefer local use or an
existing self-hosted persistent volume. A paid public deployment is not required.
If choosing Render, retain the paid persistent-backend template or connect the
free static frontend to an already durable backend. Do not deploy the current
file-writing backend to a free ephemeral filesystem. No purchases are performed.

Thinking is explicitly disabled for the basic chat request. Qwen and MiMo use
max_completion_tokens=1024; DeepSeek uses max_tokens=1024. These settings are
operator-site-only and do not change user BYOK requests. Verify compatibility
for the selected current model; unsupported parameters fail without fallback.
Examples to review, not defaults: qwen3.8-flash and mimo-v2.6-flash. Pricing is
not fixed in code. Operator must review official prices and set provider budgets.
Official parameter references:
- https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions
- https://mimo.mi.com/docs/zh-CN/api/chat/openai-api
- https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/

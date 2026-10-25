# DeepSeek web search for ChopperBot

Researched **2026-10-25**. Documentation/source review only; no credentials,
billable API probes, implementation changes or runtime verification.
Read [LLM](../llm.md) and [framework](../framework.md) first. No existing
research-note convention was found; this file establishes a location only.

## Recommendation — inference, not shipped behavior

Expose a provider-neutral `web_search` function tool backed by raw
`POST https://api.deepseek.com/v1/tools/search`. Keep `deepseek-flash` and the
existing chat-completions loop. Return bounded titles, source URLs, dates and
model-facing summaries; add optional `web_fetch` only when those excerpts cannot
support the answer. Start with `count: 5`, `need_content: false`, and cite returned
URLs in answers. These are proposed defaults, not provider requirements.

This fits the documented `ToolSource` composition: the client already wraps
neutral schemas into function tools and returns handler output as tool messages.
DeepSeek documents exactly this client-executed function-call pattern with
`deepseek-flash`. The raw APIs need no auxiliary model request or model parameter.
The official Harness adapter independently implements this separation.
[Tool Calls][tool-calls], [official adapter overview][adapter],
[official Search adapter][search-source]

“Global” should mean a shared source composed into intended interactive tool
bundles. It should not silently enable searches in every `ask()` caller, including
background classification. Preserve existing capability authorization and write
gates. Exact integration points remain for the implementation review.

## Documented raw contracts

Both endpoints require JSON and `Authorization: Bearer <DeepSeek API Key>` plus
`Content-Type: application/json`. They are independent HTTP APIs, not additional
chat-completion body fields. The default origin is `https://api.deepseek.com`.
[Authentication and endpoints][guide]

### Search: `POST /v1/tools/search`

The complete documented request shape, written as types rather than executable
integration code:

```ts
{
  query: string;                  // required; 1–128 Unicode characters; not all whitespace
  count?: number;                 // integer 1–50; default 10
  ori_question?: string | null;   // 1–128 characters; null means omitted
  localization?: string;          // optional localization IP; default ""
  need_content?: boolean;         // default false
}
```

`ori_question` supplies the triggering question to improve intent understanding.
Unknown Search body fields are ignored. There is no documented pagination,
offset or separate recency parameter. [Search reference][search], [guide][guide]

HTTP 200 contains the following shape; **every result field below is required**
by the reference, including nullable fields. No matches is `{"results": []}`.
[Search reference][search]

```ts
{
   results: Array<{
      rerank_score: number; // documented range 0–3; >=1.5 described as high quality
      title: string;
      url: string;
      snippet: string; // short query-related excerpt; typically 100–200 characters
      summary: string; // model-facing excerpt; typically 600–800 characters
      content: string; // "" when need_content=false OR content unavailable
      site_name: string | null;
      site_icon: string | null;
      date: string | null; // UTC RFC 3339 publication time, not retrieval time
      authority: number; // integer -1–4; -1 unknown; >=3 described as authoritative
   }>;
}
```

Treat score labels as provider ranking signals, not independent verification.
The reference displays an upper bound of 3 for `rerank_score`; its description
supplies the lower bound. “Typically” is not a response-size guarantee.
[Search reference][search]

Supported query syntax: `site:example.com`; multiple sites joined with `OR`;
`-site:example.com`; excluded terms (`-term`) and phrases (`-"some phrase"`);
exact phrases (`"some phrase"`); `lang:es,en`; and `after:` / `before:` using a year
or `YYYY-MM-DD`. Operators can be combined and count toward the query limit.
Example: `asambleas site:example.org lang:es after:2026-01-01`.
[Query operators][guide]

### Fetch: `POST /v1/tools/fetch`

Request: `{"url": "https://example.org/article"}`. The required URL is nonempty,
at most 8,192 characters, HTTP(S), has a host, and contains no username/password.
HTTP 200 returns `{"title": string, "content": string}`: both required, title may
be empty, content is page Markdown. Availability and site access policies apply.
No requested extraction prompt, target status, final URL, or truncation metadata
is documented. [Fetch reference][fetch]

The official adapter reports the requested URL and status 200 on success; that
is the API retrieval result, not evidence of a target-server status or redirect
destination. Its implementation discards the page title. A ChopperBot adapter
can retain the title. [Official Fetch adapter][fetch-source]

## Errors, limits and billing — documented facts

Errors use `{"error":{"message":string,"type":string,"param":null,"code":string}}`.
The guide illustrates `type` and `code` as `invalid_request_error`; it does not
publish exhaustive enums. [Errors][guide]

| HTTP | Documented meaning                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| 400  | Invalid headers/body, malformed JSON or field value                                                                    |
| 401  | Missing/invalid key                                                                                                    |
| 402  | Insufficient account balance                                                                                           |
| 403  | Fetch rejected by security policy                                                                                      |
| 404  | Fetch yielded no usable content: unavailable/blocked target, target error, unsupported type or no extractable Markdown |
| 408  | Request-body read timeout                                                                                              |
| 413  | Request body too large                                                                                                 |
| 429  | Search/Fetch QPS limit exceeded                                                                                        |
| 500  | Internal error                                                                                                         |
| 504  | Downstream timeout                                                                                                     |

The guide permits delayed retries for 408, 429 and 5xx; 402 requires funding;
other 4xx require a changed request. Both operations are read-only. Recommended
implementation: finite timeouts, cancellation, bounded backoff and a per-turn
call budget; no retry loop for an empty successful search. [Errors][guide]

Account limits are independent: **Search 100 QPS**, **Fetch 25 QPS**, regardless
of API key, separate from model concurrency. Fetch also has a per-domain QPS
limit whose value is not published. [Rate limits][guide]

Published USD tariff: **$0.75 per 1,000 successful Search requests** and **$0.75
per 1,000 successful Fetch requests** ($0.00075 each). Billing requires HTTP 200
with nonempty Search results or returned Fetch content. Errors, empty searches
and timeouts are unbilled; result count does not change the request price.
[Billing][guide]

The guide specifically says server-side Search/Fetch calls made while using
DeepSeek through Harness/Claude Code/Codex are currently free and begin billing
**2026-11-01 00:00 Beijing time**. This equals **2026-10-31 16:00 UTC**, or
**2026-10-31 10:00 America/Mexico_City** (time conversion). It does not explicitly
extend that free-period wording to arbitrary raw clients; budget ChopperBot at
the published tariff. The Chinese guide independently specifies the same
transition and lists a separate **CNY 5/1,000** tariff, not an exchange-rate quote.
[English billing][guide], [Chinese billing][guide-zh]

Retrieval avoids an auxiliary LLM call, but snippets/Markdown fed back into the
conversation still consume normal model context and tokens. At the published
tariff, 1,000 searches plus 1,000 fetches cost $1.50 before those model tokens
(arithmetic). [Official adapter token accounting][adapter]

## Compatibility: function tools versus built-in search

**Documented:** `deepseek-flash` supports ordinary function tools through chat
completions, including thinking-mode tool use. ChopperBot can execute a Search
HTTP request in a handler and pass its JSON back through that existing protocol.
No change of model or Responses migration is needed for this proposed pattern.
[Tool Calls][tool-calls], [Search adapter][search-source]

**Different feature:** Responses `{"type":"web_search"}` runs search on the
server only with **`deepseek-v4-pro`**; it is explicitly **ignored with
`deepseek-flash`**. Responses function tools are supported. Do not assume a
Responses built-in tool can be added to ChopperBot's chat-completions tool list.
The current Responses service is also documented as stateless:
`previous_response_id`, `conversation` and `store` are unsupported, with
`store:false`. Migrating for conversation persistence would therefore be based
on a false assumption. [Responses compatibility][responses],
[Responses request reference][response-reference]

## Security recommendations and unresolved evidence

These are implementation recommendations/inferences, not claims that DeepSeek
provides the corresponding guarantees:

- Treat all results, titles, summaries and Markdown as untrusted external
  evidence, never instructions or authority to execute privileged tools. Keep
  source URLs, retrieval time and explicit truncation notices; bound each excerpt
  and aggregate output. Do not automatically open returned icons or links.
- Send only a minimal public query. Omit `ori_question` unless deliberately
  redacted; omit `localization` unless needed. Never forward private Discord
  context, moderation evidence, credentials or signed/private URLs in these
  fields. Their documented semantics mean they leave the bot for the provider.
- Keep the credential-bearing API destination operator-controlled and HTTPS;
  reject API redirects, redact errors/logs and validate response JSON. The
  official transport uses `redirect:'error'`, cancellation and decoding checks;
  it sends keys to its configured API base, separate from the chat base.
  [Official transport][transport-source], [redirect tests][redirect-source]
- For optional Fetch, validate public HTTP(S) targets, reject credentials and
  local/private/link-local destinations, and never substitute an unrestricted
  Pi-side downloader on failure. The documented 403 policy is not a published
  SSRF specification; final redirect destination cannot be audited from the raw
  response. [Fetch contract][fetch], [Fetch adapter][fetch-source]

Remaining unknowns: actual ChopperBot account access/billing; Spanish/Mexico
coverage, freshness, ranking and politically sensitive query behavior; response
byte/content limits, downstream timeout duration, per-domain quota, supported
Fetch document types and redirect/security rules; Search/Fetch-specific retention
and processing guarantees. None was tested or established by the reviewed docs.

The official adapter README reports its own 2026-10-16 probes: summaries of
1,000–2,300 characters, no observed effect from changing `ori_question`, and an
unresolvable Fetch URL returning 500 rather than the documented 404. Those are
upstream observations, not measurements performed for this note. Its decoder
also tolerates an absent `summary`, although the API reference requires it.
Keep the published contract and these implementation observations distinct.
[Official adapter limitations][adapter], [decoder][search-source]

## Source provenance

Only official DeepSeek documentation and `deepseek-ai/deepseek-harness` were used.
Source links below pin inspected code to master revision
`22ddee3792402c3e70ec5f86a63c3e3e895a2f60`; documentation links are mutable.
This research is not proof of a working ChopperBot integration.

[guide]: https://api-docs.deepseek.com/guides/search/
[guide-zh]: https://api-docs.deepseek.com/zh-cn/guides/search/
[search]: https://api-docs.deepseek.com/api/search/
[fetch]: https://api-docs.deepseek.com/api/fetch/
[tool-calls]: https://api-docs.deepseek.com/guides/tool_calls/
[responses]: https://api-docs.deepseek.com/guides/responses_api/
[response-reference]: https://api-docs.deepseek.com/api/create-response
[adapter]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/web/web-deepseek-api/README.md
[search-source]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/web/web-deepseek-api/src/search.ts
[fetch-source]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/web/web-deepseek-api/src/fetch.ts
[transport-source]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/web/web-deepseek-api/src/transport.ts
[redirect-source]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/web/web-deepseek-api/tests/redirect.spec.ts

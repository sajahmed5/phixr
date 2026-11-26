# Phixr Publishing API — v1 reference (stage 1)

For developers of scheduling tools (Metricool, Buffer, Zapier apps…) who want to post to
Phixr for their customers. Stage 1 covers **connecting an account** and **posting**.
Insights and webhooks come in stage 3; a public developer site in stage 4.
Plan and decisions: [scheduler-integrations.md](scheduler-integrations.md).

**Base URL:** `https://yslrmejkaivqjvbuqfdc.supabase.co/functions/v1/api`
(will move to `https://api.joinphixr.com` with the developer site)

## The rules in one paragraph

Only **business accounts** (18+) can be connected, by their owner or a team admin. Every post
goes through the same checks as posts made in the app: photo and video safety scanning,
caption checks, and posts can be **held for review**. Apps start in **test mode**. In test mode
they can only connect the developer's own account and up to 10 named tester accounts, and
posts are **simulated**: they go through the whole lifecycle but never appear on Phixr. Phixr
approves an app to go **live**.

## 1. Register an app

For now this is done by a signed-in Phixr account (18+) calling the
`register_api_client` database function. The developer site will replace this.
It returns a `client_id` and a `client_secret`, and the secret is shown once. Register your
exact redirect URLs: `https://…`, or `http://localhost…` for testing.

## 2. Connect an account (OAuth 2.0 authorization code + PKCE)

Send the user to:

```
https://joinphixr.com/oauth/authorize
  ?response_type=code
  &client_id=phx_…
  &redirect_uri=https://yourapp.com/callback      (must match exactly)
  &scope=account:read posts:read posts:write
  &state=<random>
  &code_challenge=<BASE64URL(SHA256(verifier))>    (recommended; required without a secret)
  &code_challenge_method=S256
```

They sign in, pick the business account and tap **Allow**. You get
`https://yourapp.com/callback?code=phx_ac_…&state=…`, or `?error=access_denied`.
Codes last 10 minutes and work once.

**Scopes:** `account:read` · `posts:read` · `posts:write` · `insights:read` (stage 3)

## 3. Get tokens

```
POST /oauth/token
Authorization: Basic base64(client_id:client_secret)      (or client_id/client_secret in the body)
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=…&redirect_uri=…&code_verifier=…
```

```json
{ "access_token": "phx_at_…", "token_type": "Bearer", "expires_in": 3600,
  "refresh_token": "phx_rt_…", "scope": "account:read posts:read posts:write",
  "account": { "id": "…", "handle": "hgcare", "display_name": "HG Care" } }
```

Refresh with `grant_type=refresh_token&refresh_token=…`. **Refresh tokens rotate**: each one
works once, and reusing an old one ends every session for that connection. Access tokens last
1 hour and refresh tokens 60 days. Revoke with `POST /oauth/revoke` and `token=…`.

## 4. Call the API

Send `Authorization: Bearer phx_at_…` with every call.

| Call | Scope | What it does |
|---|---|---|
| `GET /v1/me` | account:read | The connected business account (+ `test_mode`) |
| `POST /v1/media` | posts:write | Upload a photo or video: `multipart/form-data` with `file`, **or** JSON `{"url": "https://…"}` |
| `POST /v1/posts` | posts:write | Create a post (see below) |
| `GET /v1/posts?status=&limit=&before=` | posts:read | Posts your app created for this account |
| `GET /v1/posts/{id}` | posts:read | One post's status |
| `PATCH /v1/posts/{id}` | posts:write | Change `caption`, `alt_text` or `publish_at` (before it's published) |
| `DELETE /v1/posts/{id}` | posts:write | Cancel a queued post, or take down a published one |

**Media.** Media is processed straight away. You get `{"id", "type", "moderation_status",
"width", "height", "expires_at"}`. Use the `id` in a post within **24 hours**. Media that breaks
the Community Guidelines is refused with `422 rejected`. A URL must be public `https://` on
port 443. Up to 20 uploads per hour per account (shared with the app).

**Creating a post.**

```json
POST /v1/posts
Idempotency-Key: <your unique id>            (optional; safe retries)
{
  "media_ids": ["…"],          // 1–10 for a post (carousel), exactly 1 for a story
  "kind": "post",              // or "story"
  "caption": "…",              // up to 2,200 characters
  "alt_text": "…",             // up to 1,000 characters
  "visibility": "public",      // or "private" (followers only)
  "publish_at": "2026-12-01T09:00:00Z",   // omit or null = publish now
  "draft": false               // true = save to the account's drafts, don't schedule
}
```

Posts can be scheduled up to 90 days ahead, with up to 100 scheduled at once per account.
The scheduler publishes within about a minute of `publish_at`.

**Post status:** `draft` · `scheduled` · `held` (waiting for review; `reason` says why) ·
`publishing` · `published` (with `published_post_id` and `url`) · `failed` (with `reason`).
`test: true` marks a simulated test-mode post.

## Errors

JSON `{"error": "<code>", "message": "<plain English>"}`.

| HTTP | error | Meaning |
|---|---|---|
| 400 | `invalid_request` | Something in the request is wrong (the message says what) |
| 400 | `invalid_grant` | Code or refresh token invalid, expired or used |
| 401 | `invalid_token` / `invalid_client` | Bad, expired or revoked token; wrong client secret |
| 403 | `insufficient_scope` | The connection wasn't given that permission |
| 403 | `not_business` / `app_in_test_mode` / `app_suspended` | Account or app can't be used right now |
| 404 | `not_found` | No such post for your app and this account |
| 413 | `too_large` | Media too big |
| 422 | `rejected` | Media breaks the Community Guidelines |
| 429 | `rate_limited` | Over 120 requests a minute, or the upload limit. See `Retry-After` |

## For Phixr staff

- **Approve an app:** `select admin_set_api_client_status('<client_id>', 'live', 'note');`
  Use `'suspended'` to cut an app off; that also kills all its tokens. An admin-portal screen
  is still to come.
- **Every action an app takes** is in `api_activity_log`: connect, upload, schedule, edit,
  delete, rejected media, and token reuse.
- **A business can remove an app** in Settings → Connected apps. Its queued posts go back to
  drafts and its tokens stop working.
- **Deploy:** `npx supabase functions deploy api --project-ref yslrmejkaivqjvbuqfdc --no-verify-jwt`.
  It must run without JWT verification, because callers use Phixr API tokens, not app logins.

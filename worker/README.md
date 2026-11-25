# NGR Gold Alerts Worker

Cloudflare Worker for private, background XAU/USD alert experiments.

## Deployment

The GitHub Actions workflow deploys this Worker when files under `worker/` change.

Required GitHub repository settings:

- Secret `CLOUDFLARE_API_TOKEN`: scoped to the account with Workers Scripts Edit and Workers KV Storage Edit.
- Variable `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID.
- Variable `CF_KV_NAMESPACE_ID`: the existing KV namespace ID bound as `ALERTS_KV`.

Configure these Worker secrets in Cloudflare:

- `APP_TOKEN`: a long random token (at least 24 characters).
- `NTFY_TOPIC`: the private, unguessable ntfy topic subscribed to by the receiving device.

Do not commit either secret or paste it into source control.

## API

- `GET /health`: reports service status and whether required bindings/secrets are configured. It never returns secret values.
- `GET /alerts`: list alerts (Bearer token required).
- `POST /alerts`: create an alert with JSON `{ "condition": "above" | "below", "level": 3000, "expiry": "Until deleted" | "24 hours" | "7 days" }`.
- `DELETE /alerts?id=<uuid>`: delete an alert.

All alert endpoints require the configured Bearer token and the GitHub Pages origin.

## Price and notification behavior

- Cron runs once per minute; it is not a 5- or 10-second feed.
- The Worker reads XAUS `/api/v1/spot?compact=1`.
- It checks `data_state.status`, `data_state.age_seconds`, and the response `updated_at` timestamp before using a price. Stale or unavailable prices are skipped; no price is invented.
- Alerts are one-shot: after ntfy accepts a notification, the alert is deleted.
- Expiring alerts are automatically removed.
- XAUS spot is indicative and can differ from Exness/MT5 executable quotes. Verify on the broker platform before acting.

## Public app security limitation

The static GitHub Pages app must not contain the shared `APP_TOKEN`. Anything embedded in browser JavaScript or local storage can be extracted by visitors. Therefore the public app's current reminder list remains device-local and is not connected to this private Worker. Do not expose the Worker token in `index.html`. A public multi-user alert service needs per-user authentication and abuse controls before it can safely be offered to visitors.

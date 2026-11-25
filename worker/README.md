# NGR Gold Alerts Worker deployment

This repository folder deploys the Cloudflare Worker through GitHub Actions.

## Required GitHub repository settings
Add these repository secrets/variables before running the workflow:

- Secret `CLOUDFLARE_API_TOKEN`: scoped token with **Account > Workers Scripts > Edit** and **Account > Workers KV Storage > Edit**, limited to your Cloudflare account.
- Variable `CF_ACCOUNT_ID`? (not currently used by this workflow)
- Variables:
  - `CF_KV_NAMESPACE_ID`: ID of the existing KV namespace bound as ALERTS_KV
  - `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID

The Worker also needs Cloudflare secrets `APP_TOKEN` and `NTFY_TOPIC`, which are configured separately in the Worker dashboard (or via Wrangler secrets).

## Caveats
- The app must eventually be updated to call this Worker and send its APP_TOKEN.
- The price endpoint and payload schema are not yet validated; scheduled checks may not work until this source is confirmed.
- Cron frequency is one minute.
- Spot prices can differ from broker prices. Confirm on MT5 before acting.

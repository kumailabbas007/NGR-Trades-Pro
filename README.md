# NGR TRADES PRO

A mobile-first, installable XAUUSD trading companion by **NGR TRADES by _kumail_07**.

## Included
- Dark interface with restrained gold accents.
- TradingView XAUUSD chart embeds.
- Risk/position-size estimator with editable contract-value assumption.
- Beginner lessons, glossary, quiz, and trading rules.
- Position-size, move-value, P/L, risk/reward, margin, gold-unit, drawdown, and compound-growth calculators.
- Pre-trade checklist and device-local preferences/reminders.
- Installable PWA app shell with offline caching for same-origin app pages/assets.

## Important limitations
- No broker connection, order execution, or automated BUY/SELL signals.
- TradingView chart data may be delayed and may differ from broker quotes.
- The risk calculator is an estimate. Verify contract size, tick value, minimum volume, spread, commission and margin with your broker.
- Preferences, learning progress, and saved reminders are stored in this browser on this device.
- Price reminders in the public app are stored on this device only; they do not monitor prices or send background notifications.
- A separate private Cloudflare Worker prototype supports scheduled alerts, but it is intentionally not connected to the public app: embedding its shared access token in browser code would expose it to every visitor. A secure per-user authentication design is required before public background alerts can be offered.
- News and economic calendar integration is not yet connected to a live provider.

Educational tool only, not financial advice. Leveraged trading involves substantial risk.

## Publish with GitHub Pages
Open Settings, then Pages. Choose Deploy from a branch, select main and the root folder, then Save. The site URL will be https://kumailabbas007.github.io/NGR-Trades-Pro/.

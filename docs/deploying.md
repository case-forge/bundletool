# Deploying

BundleTool is a static site: `npm run build` writes it to `dist/` (Hugo, then the offline service worker), and any static host serves it if it serves the site from the root of its own host and sends the headers below.

## Headers

`static/_headers` holds the response headers in Cloudflare Pages' format; on any other host, set the same headers in its own configuration.

| Header | Why |
| --- | --- |
| `Content-Security-Policy` on `/bundletool/*` | The page loads nothing from anywhere else: scripts, workers, fonts, images and documents come from this origin or `blob:`. `style-src 'unsafe-inline'` is there because the page and its tutorial use style attributes; `script-src 'self'` is the protection that matters. |
| `Content-Security-Policy` on `/` | The root page only sends people to the tool. |
| `Cache-Control: no-cache` on `/bundletool/*`, `/js/*`, `/css/*`, `/vendor/*` | These files have fixed names, so a long cache would keep serving an old script after a deploy. Every service worker file (`sw.js`) must also be `no-cache`. |
| `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Strict-Transport-Security` | The security headers for every page. |

Do not let a CDN cache HTML or scripts with a fixed TTL, and turn off any minifier, Rocket Loader or script injection: the offline service worker verifies every file against a SHA-256 hash, so a rewritten file is refused and the tool does not install offline.

## Links to the live site

The footer links to Contact and Privacy on https://caseforge.uk/ (`contactUrl` and `privacyUrl` in `hugo.toml`). The bug report link in the error box opens the live contact form; the report is not carried across (the two sites are different origins), so the error box's Copy details button is the way to send the details.

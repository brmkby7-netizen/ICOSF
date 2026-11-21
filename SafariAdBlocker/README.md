# Bastion: a Safari ad blocker for iOS, iPadOS and macOS

Bastion blocks ads, trackers, cookie banners and anti-adblock walls in Safari using the same community filter lists as uBlock Origin and AdGuard (EasyList, EasyPrivacy, uBlock filters, AdGuard lists, regional lists, or any list by URL), compiled on your device into Safari's native content-blocking format.

It has two layers:

| Layer | What it does | How |
| --- | --- | --- |
| **4 content blockers** | Network blocking and element hiding, done by Safari itself before a page paints. Bastion never sees your browsing. | ABP/uBO/AdGuard filters compiled to WebKit content rules, spread over four extensions to get 4 × 150,000 rules. |
| **Advanced Blocking web extension** | Things content rules can't express: scriptlets (YouTube and video ads, anti-adblock defusing, cookie-dialog auto-reject), procedural filters (`:has-text`, `:upward`, `:xpath`, `:remove()` …), CSS injection, an element picker, and a toolbar button to pause Bastion on a site. | MV3 Safari Web Extension. Rules load synchronously at `document_start` so scriptlets run before the page's own scripts. |

## What makes it good

- **One compiler, tested, used everywhere.** `compiler/` is a dependency-free JavaScript compiler from ABP/uBO/AdGuard syntax to WebKit rules. The build scripts run it in Node. The app runs the same bundle in a hidden `WKWebView`, so updates compile on-device at JIT speed in a separate process, and CSS selectors are checked by Safari's own engine. Compiling ~170k filter lines takes about 1.5 s.
- **Correct rule ordering.** In WebKit, `ignore-previous-rules` only cancels rules *before* it, so order changes the result. Bastion emits rules in this order: generic hiding → `$generichide` → site-specific hiding → `$elemhide` → network blocks → exceptions → `$important` → `$document` allowlists → your allowlist. A simulator in the tests checks real requests against that order.
- **Rule distribution.** An exception in one content blocker can't cancel a block in another. Bastion copies exceptions into every extension whose rules they could affect, and moves overflow rules into extensions with spare room.
- **Broad syntax coverage:** `||host^`, `|`, `^`, `*`, regex filters (with `{n,m}`, `\d`, `(a|b)` expanded into WebKit's dialect), `$third-party`, `$domain` (including `~` exclusions and `example.*` entities), `$denyallow`, `$important`, `$badfilter`, `$match-case`, `$popup`, `$document`, `$subdocument`, type negation, `$redirect` (block), `!#if` / `!#else` / `!#endif`, AdGuard `!#safari_cb_affinity`, hosts files, and plain domain lists. Cosmetic filters: `##`, `#@#`, `#?#`, `#$#`, `#$?#`, `#%#//scriptlet()`, `##+js()`, and ABP snippets.
- **40 scriptlets** (Bastion's own implementations, matching uBO/AdGuard/ABP names and aliases): `set-constant`, `abort-on-property-read/write`, `abort-current-script`, `json-prune` (+ fetch/XHR variants), `trusted-replace-fetch/xhr-response`, `prevent-setTimeout/setInterval/fetch/xhr/addEventListener/window-open/eval-if`, `remove-attr/class`, `set-cookie`, `set-local-storage-item`, `click-element` (cookie dialogs), `href-sanitizer`, and more. `trusted-*` scriptlets only run from trusted lists, never from a URL a user adds.
- **Safe failure.** Anything Safari can't express is skipped and reported, not approximated: `$csp`, `$removeparam`, `$replace`, raw JS injection, HTML filtering. Every `url-filter` is validated against WebKit's regex rules. If Safari still rejects a rebuilt list, the app restores the last one Safari accepted.
- **Private by design.** No servers, no accounts, no analytics. Filter lists are fetched directly from their publishers, with conditional requests and mirror fallbacks.
- **Works offline from first launch.** Default rules are compiled at build time and bundled into each extension.

## Layout

```
compiler/            Filter compiler (JS, no deps) + tests incl. a WebKit rule simulator
  src/pattern.js       ABP pattern / JS regex → WebKit url-filter, WebKit regex validator
  src/network.js       network filters → rules
  src/cosmetic.js      cosmetic filters, extended selectors, scriptlet parsing/aliases
  src/compile.js       pipeline, sections, batching, $badfilter, exceptions
  src/distribute.js    packing into 4 content blockers (150k limit), exception replication
  src/web.js           hostname index + shards for the web extension
extension/           Safari Web Extension (MV3)
  scriptlets.js        scriptlet runtime (serialized into the page's main world)
  procedural.js        procedural cosmetic engine
  content.js           document_start pipeline (sync shard load → inject → hide)
  background.js        native-app sync, per-site pause, CSP fallback, picker storage
  picker.js, popup/    element picker and toolbar popup
apple/               Xcode project spec (XcodeGen) + Swift sources
  App/                 SwiftUI app (iOS + macOS): dashboard, filters, allowlist, custom rules
  ContentBlocker/      request handler shared by the 4 content-blocker extensions
  WebExtension/        native messaging handler
  Shared/              App Group layout, shared state, allowlist rule assembly
filters/catalog.json Filter lists offered in the app (defaults, categories, mirrors)
scripts/             build-compiler, build-rules, fetch-lists, inspect, render-icons
```

## Build

Requirements: macOS with Xcode 15+, [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`), Node.js 20+.

```sh
cd SafariAdBlocker
npm install
npm run build              # bundles the compiler, downloads default lists, compiles bundled rules
cd apple
xcodegen generate
open Bastion.xcodeproj
```

In Xcode, set your team on the `Bastion_iOS` / `Bastion_macOS` targets, or set `DEVELOPMENT_TEAM` in `project.yml`. Change `BASTION_APP_BUNDLE_ID` to an identifier you own. All bundle IDs and the App Group derive from it. Then run the app scheme for your platform.

Every Xcode build runs `scripts/xcode-prebuild.sh` (the `PrepareRules` target). It re-bundles the compiler and refreshes the bundled rules at most once a day.

### Turn it on

- **iOS / iPadOS:** Settings → Apps → Safari → Extensions → turn on the four *Bastion* content blockers and *Bastion Advanced Blocking* (allow on all websites).
- **macOS:** Safari → Settings → Extensions → tick the same five, and set Advanced Blocking to *Always Allow on Every Website*. In development, enable Safari → Settings → Advanced → *Show features for web developers*, then Develop → *Allow unsigned extensions*.

The app's dashboard shows what's enabled and walks through setup.

## Develop and test

```sh
npm test                     # compiler unit tests + WebKit-semantics simulator
npm run test:extension       # procedural engine, scriptlets, content pipeline in headless Chromium (needs Playwright)
npm run fetch-lists -- --default && npm test   # also validates compiled output of the real lists
npm run inspect -- https://ads.example.com/x.js --page https://site.com --type script
npm run inspect -- --page https://www.youtube.com/   # scriptlets/procedural rules that apply to a page
```

`build/report.json` lists rule counts per content blocker and why filters were skipped.

## Limitations

These come from Safari's design, not from Bastion:

- Content blockers can't report what they blocked, so Bastion shows no per-page "requests blocked" counter. The popup counts elements hidden by advanced filters.
- Safari has no request redirection or header rewriting for content blockers. `$redirect` becomes a plain block, and `$csp`, `$removeparam`, `$replace` and `$header` are skipped.
- The web extension needs *Allow on all websites* to protect every page.
- On iOS, background updates run when the system grants a `BGProcessingTask`. Opening the app always refreshes stale lists. On macOS, lists refresh while the app is open.
- The Swift sources were written without a local compile in this environment. Build once in Xcode and fix anything the SDK flags (APIs target iOS 16.4 / macOS 13.3).

## Licenses

Bastion's code is yours to license. Filter lists are downloaded from their publishers at runtime (and at build time for the bundled defaults) and keep their own licenses: EasyList and EasyPrivacy (GPLv3 / CC BY-SA 3.0), uBlock Origin filters (GPLv3), AdGuard filters (GPLv3), Peter Lowe's list, and the URLhaus/phishing lists (CC0 / MIT). If you distribute builds with bundled rules, comply with those licenses.

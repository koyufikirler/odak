# ODAK

ODAK is a browser extension that helps you focus by allowing you to easily hide distracting elements on any web page.

## Features

- **Ad & Tracker Blocking:** Blocks ad networks and tracking beacons at the browser level, on by default. No filter subscriptions, no background scanning, and almost no CPU or memory cost. Includes 38 optional regional and language lists.
- **Pick Mode:** Activate Pick Mode to visually select and hide elements by simply hovering over them and clicking.
- **Hide Distractions:** Instantly remove banners, sidebars, or any other element that takes away from your focus.
- **Undo Last:** Made a mistake? Quickly undo your last hidden element.
- **Restore All:** Bring back all hidden elements on the current page with a single click.
- **Stats Tracking:** Keep track of how many elements you have hidden on the current page.

## Installation

### Chrome / Edge (Chromium)

1. Clone or download this repository to your local machine.
2. Open your browser and navigate to the Extensions page:
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
3. Enable **Developer mode** in the top right corner.
4. Click on **Load unpacked** and select the `odak` directory.

### Firefox

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click on **Load Temporary Add-on...**
3. Select any file inside the `odak` directory (e.g., `manifest.json`).

## How to Use

1. Click on the **ODAK** icon in your browser's toolbar to open the popup.
2. Toggle **Pick Mode** on.
3. Move your mouse over the page. Elements will be highlighted as you hover over them.
4. Click on any highlighted element to hide it.
5. You can press `Esc` to exit Pick Mode at any time.
6. Use the **Undo Last** or **Restore All** buttons in the popup to revert your changes.

### Ad Blocking

Ad blocking is on out of the box. The popup shows one switch — no lists to choose,
no levels to tune. If a site misbehaves, open the popup and use **Pause on this site**;
everything returns to normal for that domain, and one click resumes blocking.

The blocklist is compiled by the browser (`declarativeNetRequest`), so blocked
requests never reach a content script and cost effectively nothing per page.

### Control Panel

Open the popup and choose **Manage filters** (or use the extension's Options page)
to open the control panel:

- **General** — the main protection switch and every site you have paused.
- **Filters** — filter lists grouped into Ads, Privacy, Security and Regional
  categories, with a switch, a rule count and a domain count for each list. The
  Regional group contains the 38 lists from uBlock Origin's regions collection;
  the lists matching your browser language are enabled and shown first, and a
  search box makes the rest easy to find.
- **About** — how blocking works, the version, and filter data attribution.

Everything is bundled with the extension. No accounts, no subscriptions, and no
filter downloads. Lists can be enabled or disabled instantly; the browser applies
the change to its native ruleset. Enable only the regions and languages you
browse: browsers cap the total number of active static rules, and the full set of
38 regional lists is larger than that cap.

### Building the filter data

The generated files in `rules/` are committed, so building the extension does not
need a network connection. To refresh the upstream lists:

```sh
node generate_regional.js --refresh   # download + convert the 38 regional lists
node generate_rules.js                # rebuild rules/*.json, lists.json, manifest.json
node generate_locales.js              # rebuild _locales/
```

### Filter data

`rules/easyprivacy.json` is a declarativeNetRequest conversion of
[EasyPrivacy](https://easylist.to/), maintained by the EasyList authors and
dual-licensed under GPLv3 / CC BY-SA 3.0. The regional rulesets are conversions of
the lists in [uBlock Origin's regions collection](https://github.com/gorhill/uBlock).
Each list keeps its upstream license; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the full source list.

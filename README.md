# ODAK

ODAK is a browser extension that helps you focus by allowing you to easily hide distracting elements on any web page.

## Features

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

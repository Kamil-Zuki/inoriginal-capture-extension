# InOriginal Capture Helper

Chrome extension for `https://inoriginal.cc/` that:

- saves a screenshot with a hotkey
- records tab audio with a hotkey
- collects subtitles from `#pjs_playerjs_subtitle > span`
- connects to Anki through AnkiConnect
- creates notes in a selected deck and note type

## Hotkeys

- `Ctrl+Shift+1`: take a screenshot of the visible tab
- `Ctrl+Shift+2`: start or stop audio + subtitle capture
- `Ctrl+Shift+3`: create an Anki note from the current subtitle and latest capture

You can change these in `chrome://extensions/shortcuts`.

## Popup Features

Clicking the extension opens a popup with:

- `Make a card`: take the screenshot immediately, keep the video playing, record the current subtitle's audio, and stop when the subtitle changes
- current subtitle preview
- previous and next subtitle lines
- deck selector
- note type selector
- editable front and back fields
- screenshot preview
- audio playback
- final `Create card` confirmation after preview

## Install

Build the extension first:

```text
npm install
npm run build
```

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:

```text
inoriginal-capture-extension/dist
```

## Media Flow

The extension keeps the latest screenshot, audio recording, and subtitle data in extension storage for preview inside the popup.

When you click `Create card`, the image and audio are sent directly to Anki with AnkiConnect and saved into Anki's media collection.

This means the extension does not automatically download screenshots or audio files to your PC.

## Anki Setup

1. Install and enable the Anki add-on **AnkiConnect**.
2. Open the extension settings page.
3. Set:
   - the AnkiConnect URL, usually `http://127.0.0.1:8765`
   - the target deck name from the dropdown
   - the target note type from the dropdown
   - the field mapping from the available note fields dropdowns
4. Use **Test AnkiConnect** to confirm the connection.

## Popup

The popup provides buttons to:

- take a screenshot
- start or stop audio and subtitle capture
- create an Anki card
- open settings

## Notes

- Subtitle capture only works on pages under `https://inoriginal.cc/`.
- The extension reads the current subtitle text directly from `#pjs_playerjs_subtitle > span`.
- Audio recording uses the current tab audio stream, so the tab must be playing sound while recording.
- Image and audio are kept in the extension for preview, then uploaded to Anki with `storeMediaFile` only when you create the card.

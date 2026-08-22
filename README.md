# 📡 Mac Screencast

Broadcast your Mac screen — with system audio — to **any browser on your Wi-Fi**: laptops, phones, or a Fire TV (type the URL into the Silk browser). Completely free, nothing to install on the viewing device.

## Features

- **Live screen + system audio** to any browser on the same network — no app, no account, no cloud.
- **Fire TV friendly**: works in the Silk browser, controllable with the TV remote.
- **Buffered playback** for smoothness (a few seconds behind live, like YouTube), with an automatic plain-HTTP fallback for browsers where MediaSource won't attach.
- **Movie mode**: serve an MP4 directly to viewers — full quality, seekable, with sound.
- **Honest status line**: `Broadcasting with sound · 1 watching · 2.5 Mb/s` means data is genuinely flowing.

## Install on Mac (no build needed)

1. Download the latest `Mac Screencast-<version>-arm64.dmg` from the [Releases page](../../releases).
2. Open the `.dmg` and drag **Mac Screencast** into **Applications**.
3. First launch only — the build is unsigned, so macOS will warn you:
   - Right-click **Mac Screencast.app** → **Open** → **Open**.
   - If it's still blocked: **System Settings → Privacy & Security → Open Anyway**, or run:
     ```bash
     xattr -cr "/Applications/Mac Screencast.app"
     ```
4. Click **▶ Start Broadcasting** and grant the **Screen Recording** permission when asked, then quit and reopen the app once.

## Requirements

- macOS (screen capture uses the macOS Screen Recording permission)
- [Node.js](https://nodejs.org) 18+ (only to run from source or build the app)

## Run from source

```bash
npm install
npm start
```

## Build the app

```bash
npm run dist
```

This produces `dist/Mac Screencast-<version>-arm64.dmg` — a double-clickable, self-contained app. The build is unsigned, so on first launch right-click the app and choose **Open**.

## Using it

1. The app shows your watch URL (e.g. `http://192.168.178.80:8080`).
2. Click **▶ Start Broadcasting**. First time only: grant the macOS **Screen Recording** permission, then quit and reopen the app.
3. Open the URL on any device on the same Wi-Fi. Playback starts a few seconds behind live (it's buffered for smoothness, like YouTube).
4. Sound: press any key / tap / press OK on a TV remote once if it starts muted. The Mac's own speakers mute while broadcasting (checkbox).

## Watching on a TV (or anything with a browser)

Any device with a web browser can be a viewer — there's nothing to install on it. Make sure it's on the **same Wi-Fi as the Mac**, open its browser, and type the watch URL the app shows (e.g. `http://192.168.178.80:8080`), including the `:8080` part.

- **Fire TV / Firestick** — open the **Silk Browser** (free from the Amazon Appstore under "Internet"), type the URL, and playback starts. Press **OK** on the remote once if it starts muted.
- **Android TV / Google TV (Chromecast)** — no browser comes preinstalled; install one from the Play Store (e.g. TV Bro), then open the URL.
- **Smart TVs (Samsung, LG, …)** — use the TV's built-in web browser with the same URL.
- **Game consoles** — Xbox has Edge built in; PS4/PS5 can reach a browser via the user guide/manual link. Same URL.
- **Phones, tablets, laptops** — any browser (Safari, Chrome, Firefox), same URL.

Tip: for films, open `http://<mac-ip>:8080/player` on the TV instead and use Movie mode — full quality and seekable (see below).

## Movies

For films, use the **Movies** section instead of broadcasting: pick an MP4, open the player link (`…/player`) on the viewing device — full quality, buffered, seekable, with sound. Convert MKV/AVI to MP4 with the free [HandBrake](https://handbrake.fr).

## How it works

Screen + system-audio capture → WebCodecs (H.264/AAC) → fragmented MP4 → a tiny local server that fans the stream out to viewers over WebSockets (MSE playback), with an automatic plain-HTTP fallback (`/live.mp4`) for browsers where MediaSource won't attach. The server caches each stream generation's init segment so viewers can join and leave freely without interrupting each other.

```
src/
├── main/       Electron main process: window, permissions, HTTP/WebSocket server
│   ├── main.js
│   ├── preload.js
│   └── server.js
├── renderer/   The Mac app UI: capture, WebCodecs encoding, muxing
│   ├── app.js
│   ├── encoder.js
│   ├── index.html
│   └── style.css
└── viewer/     What browsers on the network receive
    ├── view.html / view.js       live stream player (MSE + fallback)
    └── player.html / player.js   movie player
```

## Troubleshooting

- **Viewer stuck "Waiting for the Mac…"** — check the Mac app's status line; it names the failing stage.
- **"Screen capture is stuck"** — a macOS quirk after rapid stop/start; wait ~10 s and press Start again (the app also self-heals mid-broadcast).
- **macOS firewall prompt** — allow it; viewers must reach the Mac over the network.
- **DRM content (Netflix/Prime)** — captures black; a macOS restriction affecting every tool.

## Contributing

Issues and pull requests are welcome. Keep changes small and describe how you tested them (which browser/device watched the stream).

## License

[MIT](LICENSE)

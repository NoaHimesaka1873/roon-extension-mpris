# Roon Extension MPRIS Bridge

Expose a paired Roon zone through the [MPRIS](https://specifications.freedesktop.org/mpris-spec/latest/) interface so that your desktop environment's media keys and widgets can control Roon playback. The bridge listens for transport updates from the Roon Core with `node-roon-api` and reflects them to `mpris-service`, keeping metadata, playback state, and transport controls in sync.

## Requirements

- Linux desktop with DBus session bus (required by MPRIS).
- Roon Core on the same network with extensions enabled.


## Install

```bash
git clone https://github.com/NoaHimesaka1873/roon-extension-mpris.git
cd roon-extension-mpris
npm install
```

## Usage

1. Start the extension:

   ```bash
   npm start
   ```

2. Authorise the extension in Roon (Settings → Extensions) when prompted. When paired, the active zone appears as `Roon MPRIS Bridge` on the session bus and responds to media keys.

All configuration is controlled via environment variables; there is no settings UI inside Roon.

### Selecting a zone

By default the bridge attaches to the first available zone, preferring one that is currently playing. To target a specific zone, set `ROON_MPRIS_ZONE` before launching. You can provide a zone ID, zone name, or output name (case-insensitive):

```bash
ROON_MPRIS_ZONE="Living Room" npm start
```

### Debug logging

Set `ROON_MPRIS_DEBUG=1` for verbose console output while troubleshooting.

### Shutting down

Stop the bridge with `Ctrl+C`, or via any MPRIS client by invoking the `Quit` action.

## Development notes

- `src/index.js` wires `mpris-service` to the Roon transport service, translating playback control, metadata, shuffle, and loop state.
- The extension advertises status updates through `node-roon-api-status`, allowing you to see connectivity information in Roon.
- Run `node --check src/index.js` after editing to ensure there are no syntax errors.

## License

MIT


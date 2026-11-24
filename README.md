# SecondTimestamps

A [Vencord](https://vencord.dev) plugin that shows **seconds** in Discord message timestamps.

| Before | After |
| --- | --- |
| `Today at 3:41 PM` | `Today at 3:41:27 PM` |
| `11/24/26, 3:41 PM` | `11/24/26, 3:41:27 PM` |

- Works everywhere a timestamp appears: cozy and compact mode, hover times, and (optionally) the full-date tooltip
- Uses Discord's own formatter, so it respects your language and Discord's 12h/24h setting
- Zero runtime overhead: it only changes which time style Discord's formatter uses

## Installation

This is a third-party plugin, so you need Vencord built from source.

1. Follow the official guide to [install Vencord from source](https://docs.vencord.dev/installing/).
2. Clone this repo into your `userplugins` folder (create it if it doesn't exist):
   ```sh
   cd Vencord/src/userplugins
   git clone <this-repo-url> secondTimestamps
   ```
3. Build and inject:
   ```sh
   pnpm build
   pnpm inject
   ```
4. Restart Discord and enable **SecondTimestamps** in *Settings → Vencord → Plugins*.

**Vesktop users:** skip `pnpm inject`. Instead, set *Vesktop Settings → Vencord Location* to your `Vencord/dist` folder.

To update the plugin later, run `git pull` in the plugin folder, then `pnpm build`, then restart Discord.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Full date tooltips | On | Also show seconds in the full-date tooltip when hovering a timestamp |

## How it works

Discord compiles moment-style format tokens into `Intl.DateTimeFormat` calls. The `LT` token (time only) maps to `timeStyle: "short"` (hours and minutes). This plugin patches it to `"medium"`, which includes seconds. `LTS` already maps to `"medium"` in Discord's own code.

## Troubleshooting

If seconds stop showing after a Discord update, the patch probably no longer matches Discord's code. Open DevTools (`Ctrl+Shift+I`), look for a SecondTimestamps patch warning, and [open an issue](../../issues).

## License

[GPL-3.0-or-later](LICENSE), the same license as Vencord.

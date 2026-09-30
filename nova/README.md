# Nova Sites (this fork's own pieces)

- `platform-config.json` — Nova's platform settings (rate limits for a flat plan), stored in the
  `VibecoderStore` KV under `platform_configs`:
  `wrangler kv key put --binding VibecoderStore platform_configs "$(cat nova/platform-config.json)" --remote`
- `media-worker/` — serves the media library (R2 `nova-sites-media`) at `media.novasites.workers.dev`.
- `../scripts/nova/` — local dev on :5197, the speed-test stopwatch, publish/preview helpers, a
  sign-in assertion helper.

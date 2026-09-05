# Folo local data service

This package is an in-process data module for the desktop application. It keeps the existing
`@follow-app/client-sdk` protocol so the UI and stores do not need to be rewritten.

It does not open a port and is not deployed separately. Electron loads it in the main process and
the renderer calls it over the application's existing IPC bridge.

Data is stored in `local-api.db` inside Electron's `userData` directory. There is no registration,
login, logout, server session, or authentication cookie. A built-in `local-user` identity is only
used to retain the existing per-user database schema.

RSS and Atom feeds are fetched when a subscription is created or refreshed.

AI summaries use an OpenAI-compatible `POST /chat/completions` endpoint when configured. For the
desktop app, create `openai.json` next to `local-api.db` in Electron's `userData` directory using
`openai.json.example` as the template. `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL` can
also be used and take precedence. If configuration is missing or the request fails, the app uses a
local extractive summary so reading remains available offline. Translation, chat, title generation,
speech synthesis, and audio transcription use the same locally stored compatible API settings.

```bash
pnpm --filter Folo dev:electron
```

# Local desktop readiness

## Implemented

- Embedded data service, shared by Electron main and renderer clients.
- Main API calls use local data without session cookies.
- Article and timeline context is read from local subscriptions and entries.
- Chat Completions SSE is converted into UI message chunks.
- IPC pulls chunks incrementally; cancellation and idle cleanup release streams.
- Speech and transcription use the configured compatible provider.
- Text attachments stay local until included in a chat request.

## Verification

- Backend integration test checks selected article context, unread filtering, and
  the first streamed delta arriving before the provider finishes.
- Production builds do not establish provider compatibility or installed-app readiness.

## Remaining release work

- Real-provider tests for chat, translation, speech and transcription.
- Installed-app tests for launch, restart, persistence and backup/restore.
- Image/PDF attachment processing and explicit errors for unsupported file types.
- AI memory and the remaining chat-session synchronization paths.
- Audit update, push, telemetry, image proxy and other original hosted dependencies.
- Review provider limits, long audio handling and transcription caching.

The desktop stores application data locally. A remote compatible provider receives
the content used for requested AI operations; fully offline inference requires a
provider running on the user's machine.

# Attachments and context

- Up to six attachments per user message, each nonempty and at most 10 MiB. Files stay private on persistent server storage.
- PNG, JPEG, and WebP: a single frame, at most 4096 × 4096 pixels. Images are decoded before acceptance and sent only to models with positive vision metadata. Every fallback candidate must satisfy the same requirement.
- PDF: at most 100 pages and 200,000 extracted characters. Every page must contain readable text; a page without text rejects the document with its page number. No OCR is performed. Encryption, corruption, and unsupported PDFs produce an error rather than a claimed reading.
- DOCX: text only, at most 30 MiB expanded OOXML and 200,000 extracted characters. Embedded macros, links, and objects are not executed or fetched.
- TXT, Markdown, CSV, JSON: UTF-8 text, at most 200,000 characters. Files are treated as text, never executed.
- Typed prompts: at most 100,000 characters. Requests have a 512,000-byte JSON limit. Output defaults to 2,048 tokens; the app permits 128–32,768 subject to a selected model's known maximum.

The server uses UTF-8 byte lengths as a conservative token bound, 1,024 tokens of overhead, 32 per message, 256 per document, and 32,768 per image. It reserves the requested output budget and checks the smallest verified context window among all eligible fallback models. Missing context metadata blocks generation. This can reject content that a particular tokenizer would accept; it never silently truncates or summarizes it.

Context includes each user prompt and its latest finalized answer. Partial answers are included with a partial-status marker; older retry attempts remain in the transcript and exports. Context selection explicitly excludes complete turns only for the next request. Send confirms the selected exclusions, and the resulting generation records excluded message IDs. Excluding an image turn also removes its vision requirement. Deleting a queued file excludes it from that message; it does not erase its private upload record.

Responses checkpoint at most every 250 ms while streaming. Stop, network interruption, gateway failure, and server restart retain the latest durable checkpoint; a crash can lose output since that checkpoint. Ten-minute attempt timeouts and a two-million-character response ceiling terminate oversized or stalled attempts explicitly. Retries create new attempts, never overwrite earlier answers, and only apply to the latest user prompt.

Usage is reported per response and conversation when available. Subscription allowances are provider-managed; token counts do not establish remaining subscription allowance. API cost is an estimate, and a zero gateway value is treated as unavailable unless there is stronger pricing evidence. Conversation totals remain unavailable if any attempt lacks the relevant metric. There is no guaranteed spending cap.

# ⊹ ACE DRAFT UPGRADER ⊹

> A draft-polishing companion for [SillyTavern](https://github.com/SillyTavern/SillyTavern).
> Rewrites the text already in your composer — with persona, card, lorebook and chat history as context — **without sending it.**

![SillyTavern](https://img.shields.io/badge/SillyTavern-Extension-9333ea)
![Version](https://img.shields.io/badge/version-1.2.0-3b82f6)
![Author](https://img.shields.io/badge/author-aceenvw-1f2937)
![License](https://img.shields.io/badge/license-AGPL--3.0-10b981)

---

## Features

- **In-place rewriting** — no message sent, no swipe consumed.
- **One-click Undo** — a nine-second toast restores the original draft.
- **Target length** — ~50, 200, 500, or a custom count up to 5000 words.
- **Context toggles** — persona, card description, lorebook, chat history.
- **History depth** — read all messages or just the last 5 / 15 / 30 / *n*.
- **Separate upgrade model** — route the rewrite through any saved connection profile.
- **Per-preset prompt selection** — include or exclude individual preset prompts, remembered per preset.
- **Quick UP button** — optional one-click upgrade beside Send; click again to stop.
- **Draft word counter** — live word count above the UP button, in three sizes.
- **Completion sound** — on desktop, reuses SillyTavern's message sound when an upgrade lands. SillyTavern's **Play message sound** and **Only when unfocused** preferences remain authoritative; mobile stays silent.
- **Bilingual** — English and Russian.

---

## Installation

1. **Extensions** → **Install Extension**.
2. Paste the repository URL and install.

Or clone into `SillyTavern/data/<user>/extensions/third-party/ace-draft-upgrader`.

Requires a Chat Completion API with an active preset. The separate upgrade model
additionally needs the built-in Connection Profiles extension and one saved profile.

---

## Usage

Type a draft, then either open **Upgrade Draft** from the magic-wand menu, or
click **UP** beside Send to run with your saved defaults.

Dialog changes are saved, so the UP button always mirrors your last setup.

---

## Model

The **Model** dropdown at the top of the dialog picks where the upgrade runs.

| Option | Behaviour |
| --- | --- |
| **Use current connection** | The active API and preset. Default. |
| *A saved connection profile* | That profile's provider, credentials and samplers. |

Create profiles under **API Connections → Connection Profiles**.

> The profile supplies samplers; the prompt is still built from your active Chat
> Completion preset.

---

## History depth

| Mode | Reads |
| --- | --- |
| **All** | Every visible message. Default. |
| **Last 5 / 15 / 30** | The most recent *n* messages. |
| **Custom** | Any count from 1 to 500. |

Counts **visible** messages only — system and blank entries are excluded. The
limit also scopes the lorebook scan, so entries trigger on the same window the
model sees.

---

## Settings

Under **Extensions** → **⊹ ACE DRAFT UPGRADER ⊹**:

| Setting | Default | Description |
| --- | --- | --- |
| **Quick upgrade button** | on | Show the **UP** button beside Send |
| **Draft word counter** | on | Show the composer word count above the **UP** button |
| **Counter size** | Medium | Word count text size — Small (7px), Medium (8px), Large (10px) |
| **Default instruction** | *(built-in)* | Rewrite instruction appended after preset and context |

Model, length, context, history depth and prompt selection live in the dialog itself.

---

## How it works

`prompt.js` walks the preset's real `prompt_order`, so markers like
`worldInfoBefore`, `charDescription` and `chatHistory` land where your preset puts
them; omitted markers are appended after. Oldest history is trimmed first if the
prompt would overflow the context window.

| Concern | Native mechanism reused |
| --- | --- |
| Prompt order | `chatCompletionSettings.prompt_order` / `prompts` |
| Persona and card | `getCharacterCardFields()` |
| Lorebook | `getWorldInfoPrompt()` |
| Default generation | `generateRaw()` |
| Profile generation | `ConnectionManagerRequestService.sendRequest()` |
| Cancellation | `AbortController` · `stopGeneration()` |

---

## Security

- Dialog built from `createElement` / `textContent`; the one `innerHTML`
  call parses the extension's own bundled template, never user data.
- Word counter renders through `textContent` only — draft text is never parsed as markup.
- Numeric fields accept a plain in-range integer only — `50<script>`, `1e3`,
  `0x10` and `12.5` are rejected rather than coerced.
- Instruction capped at 10,000 chars, profile IDs at 200, control characters stripped.
- Settings rebuilt through an allowlist; `__proto__` / `constructor` / `prototype`
  rejected as preset names and prompt identifiers.
- No `eval`, no `new Function`, no external network calls.

---

## Limitations

- Prompt assembly is Chat Completion only. A Text Completion profile can run the
  upgrade, but the prompt still comes from the active CC preset.
- `auto_update: true` in the manifest — set it to `false` if you fork or vendor this.

---

## License

AGPL-3.0-or-later. See [`LICENSE`](./LICENSE).

Copyright (C) 2026 aceenvw

---

<sub>Author: **aceenvw** · Built for SillyTavern · Licensed under AGPL-3.0</sub>

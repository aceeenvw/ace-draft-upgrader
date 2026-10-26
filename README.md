# ⊹ ACE DRAFT UPGRADER ⊹

Polish your [SillyTavern](https://github.com/SillyTavern/SillyTavern) draft using persona, character, lorebook and chat context — **without sending it.**

![SillyTavern](https://img.shields.io/badge/SillyTavern-Extension-9333ea)
![Version](https://img.shields.io/badge/version-1.2.0-3b82f6)
![Author](https://img.shields.io/badge/author-aceenvw-1f2937)
![License](https://img.shields.io/badge/license-AGPL--3.0-10b981)

## Installation

In SillyTavern **1.18.0+**, open **Extensions → Install Extension** and paste:

```text
https://github.com/aceeenvw/ace-draft-upgrader
```

Use your current Chat Completion connection or a saved Chat/Text Completion
profile. Saved profiles require Connection Profiles to be enabled. Prompt
assembly always uses your active Chat Completion preset.

## Usage

1. Write a draft and open **Upgrade Draft** from the magic-wand menu.
2. Choose the model, length, context/history, preset prompts and instruction.
3. Press **Upgrade** to replace the draft and save those choices.

**UP** beside Send and the optional desktop shortcut reuse your saved choices.
During generation, **Stop** is available from UP, the dialog or Retry.

Extension settings contain the UP toggle, word counter, shortcut and default
instruction. Instructions support macros such as `{{user}}`. English and Russian
are supported.

## Length and token budget

- **Length:** approximately 50, 200, 500, or a custom 1–5000 words.
- **Default for this length:** a small output budget calculated from that target.
- **Custom:** 1–128000 output tokens, initially **8192**, independent of word count.

Reasoning models may use this budget for thinking as well as writing. A larger
custom budget gives them more room; it does not reduce reasoning effort. Your
model's limits still apply. If the prompt and budget cannot fit the context, the
extension explains why. Word targets are approximate; token caps can cut text short.

## Undo, Retry and Last result

After an upgrade, compact **Undo** and **Retry** buttons appear above the input:

- **Undo** restores your original draft; notification Undo works too.
- **Retry** generates again from that original with the saved extension settings.
  Failure or cancellation keeps the previous successful result. Native connection
  and preset settings remain live.
- **Last result**, in the wand dialog, lets you view or copy the original and upgrade.

Editing disables direct Undo/Retry replacement. If you type while generation
runs, your edits stay and the alternative is kept in Last result. One pair is
kept in memory until you send, clear the input, switch chats or reload; Undo alone
keeps it viewable. On small screens, Last result is also available when the
attached buttons have no room to display.

## License

AGPL-3.0-or-later. See [`LICENSE`](./LICENSE).

Copyright (C) 2026 aceenvw

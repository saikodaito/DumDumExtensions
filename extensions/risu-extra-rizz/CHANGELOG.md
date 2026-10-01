## 0.6.0

- Lua triggers, on wasmoon like RisuAI: onStart, onInput, onOutput, functions named after a button, onButtonClick for risu-btn buttons, listenEdit hooks (display, input, output, and the request's history), the async/await helpers and RisuAI's Lua API (variables, chat, alerts, tokens, cbs, timers).
- Low level access: a card that asks for it is asked about once per character when its chat opens (a toggle in the character editor changes the answer). With it, LLM() and the model effects of triggers use the chat's connection (new llm permission).
- Not available: image generation, similarity search, Lua's request() and changes to the character itself.
- Card CSS with position: fixed (side panels and their buttons) stays fixed to the chat area, as on RisuAI's screen.
- html, body and :root in a card's CSS match nothing, like on RisuAI (a card styling body no longer squeezes the message).
- alertSelect answers with the option's index, like RisuAI (role choices and "Start" buttons that compare it now work).
- RisuRealm cards that are packages (.charx) are imported and previewed through the package, and the update check compares the package (only its size until it changes); new scripts are one more item of the update.
- RisuAI modules (.risum) can be added to a character (Assets section): image modules shipped apart, like Cheongwon's CWHA; {{module_assetlist}} and {{moduleenabled}} work.
- Messages the card turns into panels take the chat's width, and vw in a card's CSS measures the chat.
- Faster card buttons: only the messages on screen are processed again and only the changed ones are redrawn; Lua edit hooks run only when the card listens to them.

## 0.5.0

- The card's triggers (RisuAI triggerscript, every v1 and v2 effect except Lua and low level access): start triggers before each prompt (their extra system prompt goes in), input triggers on your message, output triggers after the reply (right after the messages' {{setvar}}s run), and manual triggers from the card's buttons. Alerts, questions and choices open in a window. Triggers can change variables and edit, add or remove messages (new chatWrite permission).
- Cards with Lua or with triggers that call the model say so once; the rest of their triggers work.

## 0.4.0

- The card's scripts on the way to the model: macros in the description, personality, scenario, examples, system prompt, persona and lorebook resolved at every send, with the chat's variables and fresh draws; {{setvar}} and {{addvar}} in the messages run once each (a continued message runs only the new part; the reply being regenerated does not run); the card's input regex on what you send, output regex on the reply before it is saved and history regex on the copy that goes to the model (the saved messages do not change).
- Lorebook decorators: @@depth N (and @@role) put the entry N messages from the end of the history, @@dont_activate turns it off, @@activate keeps it always on; the others leave the text.
- .charx packages: the regex and triggers of their module.risum are read on import. Cards imported before need to be imported again.
- Needs the input permission (the card's input regex changes what you type).

## 0.3.0

- The card's scripts, as RisuAI runs them: macros (CBS, every documented function), the display regex, the background (backgroundHTML, whose CSS styles the panels the regex draws) and the music ({{bgm::name}}, with pause and stop in the chat). Regex run in a worker; one that hangs is skipped on that message only. Variables are kept per chat and start from the card's defaults. Buttons show up; clicking does nothing yet. A setting turns all of it off.
- {{bg::name}} in a message is no longer left as written (RisuAI draws it only in the background).
- License: AGPL-3.0 (the engine is a port of RisuAI's code, GPL-3.0).

## 0.2.0

- Image instruction in the prompt: the real list of the character's images and the <img="name"> format, for cards that do not bring their own (Automatic), always, or off. Shown in the prompt inspector as "Images (Risu)".

## 0.1.0

- First version: card assets kept on import (RisuRealm list with download on first use, embedded files from `.charx` and PNG), shown in the chat for `<img="name">` and `{{img::name}}`, and an "Assets (Risu)" section in the character editor.

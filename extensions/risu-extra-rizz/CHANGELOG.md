## 0.3.0

- The card's scripts, as RisuAI runs them: macros (CBS, every documented function), the display regex, the background (backgroundHTML, whose CSS styles the panels the regex draws) and the music ({{bgm::name}}, with pause and stop in the chat). Regex run in a worker; one that hangs is skipped on that message only. Variables are kept per chat and start from the card's defaults. Buttons show up; clicking does nothing yet. A setting turns all of it off.
- {{bg::name}} in a message is no longer left as written (RisuAI draws it only in the background).
- License: AGPL-3.0 (the engine is a port of RisuAI's code, GPL-3.0).

## 0.2.0

- Image instruction in the prompt: the real list of the character's images and the <img="name"> format, for cards that do not bring their own (Automatic), always, or off. Shown in the prompt inspector as "Images (Risu)".

## 0.1.0

- First version: card assets kept on import (RisuRealm list with download on first use, embedded files from `.charx` and PNG), shown in the chat for `<img="name">` and `{{img::name}}`, and an "Assets (Risu)" section in the character editor.

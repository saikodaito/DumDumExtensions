RisuAI cards in DumDum: their images, macros, display regex, background and music.

Many RisuRealm cards do "expressions" their own way: dozens of images
(`Hikari_angry_1.webp`, `Hikari_angry_2.webp`...) and a lorebook entry that
tells the model to write `<img="Hikari_angry">` in the reply. Many also bring
scripts: panels drawn by the card's regex, a first-message menu, variables.
Without this extension all of that shows up as plain text.

- **On import** (RisuRealm browser, link or file): the card's assets become
  the character's library. RisuRealm cards keep only the list, and each image
  is downloaded the first time it shows up (then it works offline). `.charx`
  and PNG cards store the embedded files right away, asking first from 10 MB.
- **In the chat**: `<img="name">` and `{{img::name}}` show the image; with
  numbered variants (`_1`, `_2`...) each message picks one and keeps it.
  `{{raw::name}}`, `{{video::name}}` and `{{audio::name}}` work too. A mark
  with no matching asset stays as written.
- **The card's scripts** (can be turned off): RisuAI macros (`{{getvar}}`,
  `{{#if}}`, `{{#when}}`, `{{? 1+2}}` and the rest), the card's display regex,
  its background (`backgroundHTML`, with the CSS the panels use) and its music
  (`{{bgm::name}}`, with a stop button in the chat). Variables are kept per
  chat, apart from the app's own. Buttons show up but do nothing yet.
- **In the prompt** (optional): cards that do not teach the model how to
  call their images get a short instruction with the real list of names.
  Automatic by default (only when the card brings none), always, or off.
- **In the character editor**: an "Assets (Risu)" section to see, filter,
  rename, delete and add files, and to download everything at once.
- **Your data**: kept apart from the app backup. The data button next to the
  extension (Settings > Extensions) exports and imports it.

Not yet: macros in the prompt, triggers and working buttons, Lua, and the
`.risum` modules inside `.charx` files (where those cards keep their regex).

License: AGPL-3.0 (see `LICENSE`). `engine.js` is a port of RisuAI's own code
(https://github.com/kwaroran/RisuAI, GPL-3.0, by Kwaroran and contributors).

Source: [DumDumExtensions](https://github.com/saikodaito/DumDumExtensions)

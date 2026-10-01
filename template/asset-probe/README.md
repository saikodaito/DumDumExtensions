An example of the API 2 hooks.

- `char.imported`: when a card is imported, the images it carries
  (Character Card V3 `assets` of type `x-risu-asset` or `emotion`) go to the
  extension's own storage, `dd.files` (up to 40 images or 20 MB per character)
- `dd.render.text`: where a message writes `<img="name">` or
  `{{img::name}}`, the image shows up in the chat bubble
- Own storage stays out of the app backup; the data button next to the
  extension exports and imports it (`.dumextdata`)

The manifest declares `"api": 2` and `"storage": "own"`; without them
`dd.files` is `null`.

Source: [DumDumExtensions](https://github.com/saikodaito/DumDumExtensions)

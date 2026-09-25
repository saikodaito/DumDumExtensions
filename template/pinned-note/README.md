An example of the prompt hooks (`dd.prompt`).

- A note you write is added to every prompt: at the end of the system prompt,
  before the history, or inside the history at a chosen depth
- It shows up in the prompt inspector with the extension's name
- Optional cleanup of blank lines in the reply, before it is saved

The manifest declares `"prompt": true`; without it the app refuses
`dd.prompt.inject` and `dd.prompt.transform`.

Source: [DumDumExtensions](https://github.com/saikodaito/DumDumExtensions)

# DumDumExtensions

Official extensions for DumDum. The app lists them in its Extension Browser
(menu, after turning on Settings > Extensions) and installs them from here.

## How the app installs an extension

1. It reads `index.json` from `main`.
2. It downloads the extension files from the **tag** `<id>-v<version>`, never
   from `main`, so what was reviewed cannot change underneath.
3. It checks the SHA-256 of every file twice: against `manifest.json` and
   against `index.json`. One mismatch and nothing is installed.

An extension can also be installed from a `.dumext` file (a zip made by
`tools/pack.mjs`). The app marks it **official** only when it is byte for byte
an entry of this index; anything else gets a strong warning.

## Trust model

Extensions run inside the app with the same access the app has. There is no
sandbox. What keeps users safe is that every extension in this repository is
read by a human before it is published, and that the hashes make sure the app
runs exactly that code. The permissions in a manifest are shown to the user,
but the app does not enforce them.

## Layout

```
index.json              generated, do not edit
extensions/<id>/
  manifest.json         hashes are written by tools/build-index.mjs
  main.js ...           scripts, in the order of manifest.scripts
  style.css             optional, app tokens only (--dd-*)
  i18n/en.json ...      optional translations
  icon.webp banner.webp optional
  README.md             shown in the install banner
  CHANGELOG.md          shown when updating
  test/                 optional, never downloaded by the app
template/hello/         a small extension that uses most of the API
tools/                  build-index, pack, check-publish
```

## Writing an extension

Start from `template/hello`. The whole contract is the `dd` object your
scripts receive (see `template/dd.d.ts`):

- Use **only** `dd`. Reading the app's internals (`DB`, `window.__TAURI__`,
  internal functions) is refused in review: the app is free to change them.
- Network only through `dd.net.fetch`, to hosts listed in
  `permissions.network`.
- CSS only with the app tokens (`--dd-*`), font sizes as
  `calc(Npx * var(--dd-fs-ui))`. Tailwind classes are not guaranteed.
- Timers with `setTimeout`, not `requestAnimationFrame` (it stops while the
  window is hidden).
- Register `dd.onDeactivate` to clean up; without it, turning the extension
  off asks the user to restart the app.

Test it with the app's developer mode: serve the folder over HTTP
(`npx http-server <folder> --cors -c-1 -p 8080`) and load
`http://127.0.0.1:8080/` in Settings > Extensions > Developer.

## Publishing (maintainer)

```
# 1. bump "version" in extensions/<id>/manifest.json
node tools/build-index.mjs          # writes the hashes and index.json
node tools/check-publish.mjs        # the same check the pre-push hook runs
git commit -am "<id> x.y.z"
git tag <id>-vx.y.z
git push origin main <id>-vx.y.z
```

Never move or delete a published tag. Local setup once:
`git config core.hooksPath .githooks`.

## License

MIT, see `LICENSE`.

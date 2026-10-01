// Risu's extra Rizz: RisuAI's macro language (CBS) and the card's display regex.
//
// This file is a port of RisuAI's own code, so cards behave as their authors
// tested them in RisuAI. Source: https://github.com/kwaroran/RisuAI (main,
// fetched 01/10/2026), GPL-3.0, Copyright (C) Kwaroran and contributors:
//   src/ts/cbs.ts                   registerCBS: every CBS function, unchanged
//                                   but for the notes below
//   src/ts/parser/parser.svelte.ts  risuChatParser, matcher, the block
//                                   matchers (#if, #when, #each, #func...),
//                                   dateTimeFormat, parseArray/parseDict/makeArray
//   src/ts/parser/chatVar.svelte.ts getChatVar/setChatVar (adapted to a context)
//   src/ts/process/infunctions.ts   calcString ({{? }} and {{calc}})
//   src/ts/process/scripts.ts       processScriptFull, the regex part
//   src/ts/util.ts                  sfc32, pickHashRand, parseKeyValue
//
// Changes made for DumDum (01/10/2026):
//   - TypeScript types stripped (sucrase), imports replaced by the context
//     below: RisuAI's database becomes a read-only view built from the
//     character, the chat and the variables the extension keeps.
//   - Math.random() → _rand(): seeded per message, so a {{random}} on screen
//     does not change every time the chat redraws.
//   - window.innerWidth/innerHeight → the context (this also runs in a worker).
//   - Buffer → a small base64/utf-8 stand-in (no Node in the app).
//   - Debug console.log calls removed from #func/call.
//   - processScriptFull: no Lua, triggers, plugins or dynamic assets (later
//     phases); @@emo is ignored and @@inject does not write to the chat.
//
// It runs inside a worker (rizzEngine.toString() is its source) or, without
// workers, on the page: so the function must not use anything from outside.
//
// This file is part of Risu's extra Rizz and is licensed under the GNU Affero
// General Public License v3.0 (see LICENSE in this folder). GPL-3.0 section 13
// allows combining RisuAI's GPL-3.0 code with an AGPL-3.0 work.

function rizzEngine(ENV) {
    'use strict';
    ENV = ENV || {};

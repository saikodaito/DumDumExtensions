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
//   src/ts/process/triggers.ts      runTrigger (every v1 and v2 effect)
//   src/ts/process/scriptings.ts    runScripted and the Lua API, the Lua
//                                   wrapper (listenEdit, async, json),
//                                   runLuaEditTrigger, runLuaButtonTrigger
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
//   - runTrigger and the Lua side: RisuAI's stores become the context
//     (frag-triggers.js); alerts and the model (dd.llm) go through the page;
//     Lua runs on wasmoon, like RisuAI (lua-vendor.js); image generation,
//     similarity search, Lua's request() and writes to the character
//     (name, description, lorebook) are not available.
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

    // ── Runtime (DumDum side) ────────────────────────────────────────────
    // CUR is the context of the job that is running. Jobs are synchronous and
    // run one at a time, so a module variable is enough.
    let CUR = null;
    let _rng = Math.random;
    const _rand = () => _rng();

    // svelte/store `get` + the store of the clicked element's risu-id (trigger_id).
    const CurrentTriggerIdStore = { get: () => (CUR && CUR.triggerId) || null, set: (v) => { if (CUR) CUR.triggerId = v; } };
    const get = (store) => (store && typeof store.get === 'function') ? store.get() : null;

    // The Buffer calls of cbs.ts (base64 and utf-8 only).
    const Buffer = {
        from(v, enc) {
            let u8;
            if (typeof v === 'string') {
                if (enc === 'base64') {
                    const b = atob(v.replace(/[^A-Za-z0-9+/=]/g, ''));
                    u8 = new Uint8Array(b.length);
                    for (let i = 0; i < b.length; i++) u8[i] = b.charCodeAt(i);
                } else u8 = new TextEncoder().encode(v);
            } else u8 = new Uint8Array(v);
            u8.toString = function (e) {
                if (e === 'base64') {
                    let s = '';
                    for (let i = 0; i < this.length; i++) s += String.fromCharCode(this[i]);
                    return btoa(s);
                }
                return new TextDecoder().decode(this);
            };
            return u8;
        },
    };
    const safeStructuredClone = o => {
        try { return structuredClone(o); } catch (e) { return JSON.parse(JSON.stringify(o)); }
    };

    // ── src/ts/util.ts ───────────────────────────────────────────────────
    function sfc32(a, b, c, d) {
        return function () {
            a |= 0; b |= 0; c |= 0; d |= 0;
            let t = (a + b | 0) + d | 0;
            d = d + 1 | 0;
            a = b ^ b >>> 9;
            b = c + (c << 3) | 0;
            c = (c << 21 | c >>> 11);
            c = c + t | 0;
            return (t >>> 0) / 4294967296;
        };
    }
    function pickHashRand(cid, word) {
        let hashAddress = 5515;
        const rand = (word) => {
            for (let counter = 0; counter < word.length; counter++) {
                hashAddress = ((hashAddress << 5) + hashAddress) + word.charCodeAt(counter);
            }
            return hashAddress;
        };
        const randF = sfc32(rand(word), rand(word), rand(word), rand(word));
        const v = cid % 1000;
        for (let i = 0; i < v; i++) {
            randF();
        }
        return randF();
    }
    function parseKeyValue(template) {
        try {
            if (!template) {
                return [];
            }
            const keyValue = [];
            for (const line of template.split('\n')) {
                const [key, value] = line.split('=');
                if (key && value) {
                    keyValue.push([key, value]);
                }
            }
            return keyValue;
        } catch (error) {
            return [];
        }
    }
    /** A per-message seed for _rand (DumDum: stable draws on screen). */
    function seeded(s) {
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return sfc32(h, h ^ 0x9e3779b9, h ^ 0x85ebca6b, h ^ 0xc2b2ae35);
    }

    // ── src/ts/parser/chatVar.svelte.ts (adapted) ────────────────────────
    // RisuAI keeps chat variables in chat.scriptstate['$' + key]; here they
    // are CUR.vars[key], kept per chat by the extension.
    function getChatVar(key) {
        const state = CUR.vars[key];
        if (state === undefined || state === null) {
            const defaultVariables = parseKeyValue(CUR.char.defaultVariables).concat(parseKeyValue(CUR.db.templateDefaultVariables));
            const findResult = defaultVariables.find((f) => {
                return f[0] === key;
            });
            if (findResult) {
                return findResult[1];
            }
            return 'null';
        }
        return state.toString();
    }
    function setChatVar(key, value) {
        if (CUR.vars[key] === value) {
            return false;
        }
        CUR.vars[key] = value;
        CUR.varsChanged = true;
        return true;
    }
    function getGlobalChatVar(key) {
        const v = CUR.globals[key];
        return (v !== undefined && v !== null && v !== 'null') ? String(v) : 'null';
    }

    // ── The context: RisuAI's database, seen from one chat ───────────────
    // c = { char, chat, user, vars, globals, db, meta } (see display.js).
    function view(c) {
        c = c || {};
        const chat = Object.assign({ id: '', fmIndex: -1, message: [], note: '', localLore: [] }, c.chat || {});
        if (!Array.isArray(chat.message)) chat.message = [];
        const char = Object.assign({
            type: 'character', name: '', nickname: '', desc: '', personality: '', scenario: '',
            exampleMessage: '', firstMessage: '', alternateGreetings: [], chaId: '', additionalAssets: [],
            emotionImages: [], defaultVariables: '', customscript: [], globalLore: [],
            prebuiltAssetCommand: false, prebuiltAssetExclude: [],
        }, c.char || {});
        char.chats = [chat];
        char.chatPage = 0;
        const db = Object.assign({
            aiModel: '', subModel: '', mainPrompt: '', jailbreak: '', globalNote: '', maxContext: 0,
            language: 'en', jailbreakToggle: false, templateDefaultVariables: '', globalChatVariables: {},
            promptTemplate: null, personas: [], selectedPersona: 0,
        }, c.db || {});
        db.characters = [char];
        return {
            char, chat, db,
            vars: Object.assign({}, c.vars || {}),
            globals: Object.assign({}, c.globals || {}),
            user: Object.assign({ name: 'User', persona: '' }, c.user || {}),
            meta: Object.assign({ w: 0, h: 0 }, c.meta || {}),
            // RisuAI's enabled modules, as {{module_assetlist}} and
            // {{moduleenabled}} see them: [{ namespace, assets: [[name, path, ext]] }]
            modules: Array.isArray(c.modules) ? c.modules : [],
            triggerId: null, varsChanged: false,
        };
    }


    // ── src/ts/process/infunctions.ts ────────────────────────────────────
    function toRPN(expression) {
        let outputQueue = '';
        let operatorStack = [];
        let operators = {
            '+': {precedence: 2, associativity: 'Left'},
            '-': {precedence: 2, associativity: 'Left'},
            '*': {precedence: 3, associativity: 'Left'},
            '/': {precedence: 3, associativity: 'Left'},
            '^': {precedence: 4, associativity: 'Left'},
            '%': {precedence: 3, associativity: 'Left'},
            '<': {precedence: 1, associativity: 'Left'},
            '>': {precedence: 1, associativity: 'Left'},
            '|': {precedence: 1, associativity: 'Left'},
            '&': {precedence: 1, associativity: 'Left'},
            '≤': {precedence: 1, associativity: 'Left'},
            '≥': {precedence: 1, associativity: 'Left'},
            '=': {precedence: 1, associativity: 'Left'},
            '≠': {precedence: 1, associativity: 'Left'},
            '!': {precedence: 5, associativity: 'Right'},
        };
        const operatorsKeys = Object.keys(operators);

        expression = expression.replace(/\s+/g, '');
        let expression2 = []

        let lastToken = ''

        for(let i = 0; i < expression.length; i++) {
            const char = expression[i]
            if (char === '-' && (i === 0 || operatorsKeys.includes(expression[i - 1]) || expression[i - 1] === '(')) {
                lastToken += char
            }
            else if (operatorsKeys.includes(char)) {
                if(lastToken !== '') {
                    expression2.push(lastToken)
                }
                else{
                    expression2.push('0')
                }
                lastToken = ''
                expression2.push(char)
            }
            else{
                lastToken += char
            }
        }

        if(lastToken !== '') {
            expression2.push(lastToken)
        }
        else{
            expression2.push('0')
        }

        expression2.forEach(token => {
            if (parseFloat(token) || token === '0') {
                outputQueue += token + ' ';
            } else if (operatorsKeys.includes(token)) {
                while (operatorStack.length > 0 &&
                ((operators[token].associativity === 'Left' &&
                operators[token].precedence <= operators[operatorStack[operatorStack.length - 1]].precedence) ||
                (operators[token].associativity === 'Right' &&
                operators[token].precedence < operators[operatorStack[operatorStack.length - 1]].precedence))) {
                    outputQueue += operatorStack.pop() + ' ';
                }

                operatorStack.push(token);
            }
        });

        while (operatorStack.length > 0) {
            outputQueue += operatorStack.pop() + ' ';
        }

        return outputQueue.trim();
    }

    function calculateRPN(expression) {
        let stack = [];

        expression.split(' ').forEach(token => {
            if (parseFloat(token) || token === '0') {
                stack.push(parseFloat(token));
            } else {
                let [b, a] = [stack.pop(), stack.pop()];
                switch (token) {
                    case '+': stack.push(a + b); break;
                    case '-': stack.push(a - b); break;
                    case '*': stack.push(a * b); break;
                    case '/': stack.push(a / b); break;
                    case '^': stack.push(a ** b); break;
                    case '%': stack.push(a % b); break;
                    case '<': stack.push(a < b ? 1 : 0); break;
                    case '>': stack.push(a > b ? 1 : 0); break;
                    case '|': stack.push(a || b); break;
                    case '&': stack.push(a && b); break;
                    case '≤': stack.push(a <= b ? 1 : 0); break;
                    case '≥': stack.push(a >= b ? 1 : 0); break;
                    case '=': stack.push(a === b ? 1 : 0); break;
                    case '≠': stack.push(a !== b ? 1 : 0); break;
                    case '!': stack.push(b ? 0 : 1); break;
                }
            }
        });

        if(stack.length === 0){
            return 0
        }

        return stack.pop()
    }

    function executeRPNCalculation(text) {
        text = text.replace(/\$([a-zA-Z0-9_]+)/g, (_, p1) => {
            const v = getChatVar(p1)
            const parsed = parseFloat(v)
            if(isNaN(parsed)){
                return "0"
            }
            return parsed.toString()
        }).replace(/\@([a-zA-Z0-9_]+)/g, (_, p1) => {
            const v = getGlobalChatVar(p1)
            const parsed = parseFloat(v)
            if(isNaN(parsed)){
                return "0"
            }
            return parsed.toString()
        })
        .replace(/&&/g, '&')
        .replace(/\|\|/g, '|')
        .replace(/<=/g, '≤')
        .replace(/>=/g, '≥')
        .replace(/==/g, '=')
        .replace(/!=/g, '≠')
        .replace(/null/gi, '0')
        const expression = toRPN(text);
        const evaluated = calculateRPN(expression);
        return evaluated
    }

    function calcString(text) {
        let depthText = ['']

        for(let i = 0; i < text.length; i++) {
            if(text[i] === '(') {
                depthText.push('')
            }
            else if(text[i] === ')' && depthText.length > 1) {
                let result = executeRPNCalculation(depthText.pop())
                depthText[depthText.length - 1] += result
            }
            else {
                depthText[depthText.length - 1] += text[i]
            }
        }

        return executeRPNCalculation(depthText.join(''))
    }

    // ── src/ts/cbs.ts: registerCBS ───────────────────────────────────────
    function registerCBS(arg) {
        const {
            registerFunction,
            getDatabase,
            getUserName,
            getPersonaPrompt,
            risuChatParser,
            makeArray,
            safeStructuredClone,
            parseArray,
            parseDict,
            getChatVar,
            setChatVar,
            getGlobalChatVar,
            calcString,
            dateTimeFormat,
            getModules,
            getModuleLorebooks,
            pickHashRand,
            getSelectedCharID,
            isTauri,
            isNodeServer,
            isMobile,
            appVer,
            getModelInfo,
            callInternalFunction
        } = arg;

        // Basic character/user variables
        registerFunction({
            name: 'char',
            callback: (str, matcherArg, args, vars) => {
                if(matcherArg.consistantChar){
                    return 'botname'
                }
                const db = getDatabase()
                let selectedChar = getSelectedCharID()
                let currentChar = db.characters[selectedChar]
                if(currentChar && currentChar.type !== 'group'){
                    return currentChar.nickname || currentChar.name
                }
                if(matcherArg.chara){
                    if(typeof(matcherArg.chara) === 'string'){
                        return matcherArg.chara
                    }
                    else{
                        return matcherArg.chara.name
                    }
                }
                return currentChar.nickname || currentChar.name
            },
            alias: ['bot'],
            description: 'Returns the name or nickname of the current character/bot. In consistent character mode, returns "botname". For group chats, returns the group name.\n\nUsage:: {{char}}',
        });

        registerFunction({
            name: 'user',
            callback: (str, matcherArg, args, vars) => {
                if(matcherArg.consistantChar){
                    return 'username'
                }
                return getUserName()
            },
            alias: [],
            description: 'Returns the current user\'s name as set in user settings. In consistent character mode, returns "username".\n\nUsage:: {{user}}',
        });

        registerFunction({
            name: 'trigger_id',
            callback: (str, matcherArg, args, vars) => {
                const currentTriggerId = get(CurrentTriggerIdStore)
                return currentTriggerId ?? 'null'
            },
            alias: ['triggerid'],
            description: 'Returns the ID value from the risu-id attribute of the clicked element that triggered the manual trigger. Returns "null" if no ID was provided.\n\nUsage:: {{trigger_id}}',
        });

        registerFunction({
            name: 'previouscharchat',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                const selchar = db.characters[getSelectedCharID()]
                const chat = selchar.chats[selchar.chatPage]
                let pointer = matcherArg.chatID !== -1 ? matcherArg.chatID - 1 : chat.message.length - 1
                while(pointer >= 0){
                    if(chat.message[pointer].role === 'char'){
                        return chat.message[pointer].data
                    }
                    pointer--
                }
                return chat.fmIndex === -1 ? selchar.firstMessage : selchar.alternateGreetings[chat.fmIndex]
            },
            alias: ['previouscharchat', 'lastcharmessage'],
            description: 'Returns the last message sent by the character in the current chat. Searches backwards from the current message position to find the most recent character message. If no character messages exist, returns the first message or selected alternate greeting.\n\nUsage:: {{previouscharchat}}',
        });

        registerFunction({
            name: 'previoususerchat',
            callback: (str, matcherArg, args, vars) => {
                const chatID = matcherArg.chatID
                if(chatID !== -1){
                    const db = getDatabase()
                    const selchar = db.characters[getSelectedCharID()]
                    const chat = selchar.chats[selchar.chatPage]
                    let pointer = chatID - 1
                    while(pointer >= 0){
                        if(chat.message[pointer].role === 'user'){
                            return chat.message[pointer].data
                        }
                        pointer--
                    }
                    return chat.fmIndex === -1 ? selchar.firstMessage : selchar.alternateGreetings[chat.fmIndex]
                }
                return ''
            },
            alias: ['previoususerchat', 'lastusermessage'],
            description: 'Returns the last message sent by the user in the current chat. Searches backwards from the current message position to find the most recent user message. Only works when chatID is available (not -1). Returns empty string if no user messages found.\n\nUsage:: {{previoususerchat}}',
        });

        // Character data functions
        registerFunction({
            name: 'personality',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                const argChara = matcherArg.chara
                const achara = (argChara && typeof(argChara) !== 'string') ? argChara : (db.characters[getSelectedCharID()])
                if(achara.type === 'group'){
                    return ""
                }
                return risuChatParser(achara.personality, matcherArg)
            },
            alias: ['charpersona'],
            description: 'Returns the personality field of the current character. The text is processed through the chat parser for variable substitution. Returns empty string for group chats.\n\nUsage:: {{personality}}',
        });

        registerFunction({
            name: 'description',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                const argChara = matcherArg.chara
                const achara = (argChara && typeof(argChara) !== 'string') ? argChara : (db.characters[getSelectedCharID()])
                if(achara.type === 'group'){
                    return ""
                }
                return risuChatParser(achara.desc, matcherArg)
            },
            alias: ['chardesc'],
            description: 'Returns the description field of the current character. The text is processed through the chat parser for variable substitution. Returns empty string for group chats.\n\nUsage:: {{description}}',
        });

        registerFunction({
            name: 'scenario',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                const argChara = matcherArg.chara
                const achara = (argChara && typeof(argChara) !== 'string') ? argChara : (db.characters[getSelectedCharID()])
                if(achara.type === 'group'){
                    return ""
                }
                return risuChatParser(achara.scenario, matcherArg)
            },
            alias: [],
            description: 'Returns the scenario field of the current character. The text is processed through the chat parser for variable substitution. Returns empty string for group chats.\n\nUsage:: {{scenario}}',
        });

        registerFunction({
            name: 'exampledialogue',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                const argChara = matcherArg.chara
                const achara = (argChara && typeof(argChara) !== 'string') ? argChara : (db.characters[getSelectedCharID()])
                if(achara.type === 'group'){
                    return ""
                }
                return risuChatParser(achara.exampleMessage, matcherArg)
            },
            alias: ['examplemessage', 'example_dialogue'],
            description: 'Returns the example dialogue/message field of the current character. The text is processed through the chat parser for variable substitution. Returns empty string for group chats.\n\nUsage:: {{exampledialogue}}',
        });

        // Prompt and system functions
        registerFunction({
            name: 'persona',
            callback: (str, matcherArg, args, vars) => {
                return risuChatParser(getPersonaPrompt(), matcherArg)
            },
            alias: ['userpersona'],
            description: 'Returns the user persona prompt text. The text is processed through the chat parser for variable substitution. This contains the user\'s character description/personality.\n\nUsage:: {{persona}}',
        });

        registerFunction({
            name: 'mainprompt',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                return risuChatParser(db.mainPrompt, matcherArg)
            },
            alias: ['systemprompt', 'main_prompt'],
            description: 'Returns the main system prompt that provides instructions to the AI model. The text is processed through the chat parser for variable substitution.\n\nUsage:: {{mainprompt}}',
        });

        registerFunction({
            name: 'lorebook',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                const argChara = matcherArg.chara
                const achara = (argChara && typeof(argChara) !== 'string') ? argChara : (db.characters[getSelectedCharID()])
                const selchar = db.characters[getSelectedCharID()]
                const chat = selchar.chats[selchar.chatPage]
                const characterLore = (achara.type === 'group') ? [] : (achara.globalLore ?? [])
                const chatLore = chat.localLore ?? []
                const fullLore = characterLore.concat(chatLore.concat(getModuleLorebooks()))
                return makeArray(fullLore.map((v) => {
                    return JSON.stringify(v)
                }))
            },
            alias: ['worldinfo'],
            description: 'Returns all active lorebook entries as a JSON array. Combines character lorebook, chat-specific lorebook, and module lorebooks. Each entry is JSON.stringify\'d.\n\nUsage:: {{lorebook}}',
        });

        registerFunction({
            name: 'userhistory',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                const selchar = db.characters[getSelectedCharID()]
                const chat = selchar.chats[selchar.chatPage]
                return makeArray(chat.message.filter((v) => {
                    return v.role === 'user'
                }).map((v) => {
                    v = safeStructuredClone(v)
                    v.data = risuChatParser(v.data, matcherArg)
                    return JSON.stringify(v)
                }))
            },
            alias: ['usermessages', 'user_history'],
            description: 'Returns all user messages in the current chat as a JSON array. Each message object contains role, data, and other metadata. Data is processed through chat parser.\n\nUsage:: {{userhistory}}',
        });

        registerFunction({
            name: 'charhistory',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                const selchar = db.characters[getSelectedCharID()]
                const chat = selchar.chats[selchar.chatPage]
                return makeArray(chat.message.filter((v) => {
                    return v.role === 'char'
                }).map((v) => {
                    v = safeStructuredClone(v)
                    v.data = risuChatParser(v.data, matcherArg)
                    return JSON.stringify(v)
                }))
            },
            alias: ['charmessages', 'char_history'],
            description: 'Returns all character messages in the current chat as a JSON array. Each message object contains role, data, and other metadata. Data is processed through chat parser.\n\nUsage:: {{charhistory}}',
        });

        registerFunction({
            name: 'jb',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                return risuChatParser(db.jailbreak, matcherArg)
            },
            alias: ['jailbreak'],
            description: 'Returns the jailbreak prompt text used to modify AI behavior. The text is processed through the chat parser for variable substitution.\n\nUsage:: {{jb}}',
        });

        registerFunction({
            name: 'globalnote',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                return risuChatParser(db.globalNote, matcherArg)
            },
            alias: ['globalnote', 'systemnote', 'ujb'],
            description: 'Returns the global note (also called system note) that is appended to prompts. The text is processed through the chat parser for variable substitution.\n\nUsage:: {{globalnote}}',
        });

        registerFunction({
            name: 'authornote',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                const selchar = db.characters?.[getSelectedCharID()]
                const chat = selchar?.chats?.[selchar.chatPage]
                if(chat?.note){
                    return risuChatParser(chat.note, matcherArg)
                }
                const template = db.promptTemplate
                if(template){
                    for(const v of template){
                        if(v.type === 'authornote' && v.defaultText){
                            return risuChatParser(v.defaultText, matcherArg)
                        }
                    }
                }
                return ''
            },
            alias: ['author_note'],
            description: "Returns the author's note for the current chat. Falls back to the default author's note text from the prompt template if the chat doesn't have a custom one. The text is processed through the chat parser for variable substitution.\n\nUsage:: {{authornote}}",
        });

        registerFunction({
            name: 'chatindex',
            callback: (str, matcherArg, args, vars) => {
                return matcherArg.chatID.toString()
            },
            alias: ['chat_index'],
            description: 'Returns the current message index in the chat as a string. -1 indicates no specific message context.\n\nUsage:: {{chatindex}}',
        });

        registerFunction({
            name: 'firstmsgindex',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                const selchar = db.characters[getSelectedCharID()]
                const chat = selchar.chats[selchar.chatPage]
                return chat.fmIndex.toString()
            },
            alias: ['firstmessageindex', 'first_msg_index'],
            description: 'Returns the index of the selected first message/alternate greeting as a string. -1 indicates the default first message is used.\n\nUsage:: {{firstmsgindex}}',
        });

        registerFunction({
            name: 'blank',
            callback: (str, matcherArg, args, vars) => {
                return ''
            },
            alias: ['none'],
            description: 'Returns an empty string. Useful for clearing variables or creating conditional empty outputs.\n\nUsage:: {{blank}}',
        });

        registerFunction({
            name: 'messagetime',
            callback: (str, matcherArg, args, vars) => {
                if(matcherArg.tokenizeAccurate){
                    return `00:00:00`
                }
                if(matcherArg.chatID === -1){
                    return "[Cannot get time]"
                }

                const db = getDatabase()
                const selchar = db.characters[getSelectedCharID()]
                const chat = selchar.chats[selchar.chatPage]
                const message = chat.message[matcherArg.chatID]
                if(!message.time){
                    return "[Cannot get time, message was sent in older version]"
                }
                const date = new Date(message.time)
                return date.toLocaleTimeString()
            },
            alias: ['message_time'],
            description: 'Returns the time when the current message was sent in local time format (HH:MM:SS). Returns "00:00:00" in tokenization mode or error messages for old/invalid messages.\n\nUsage:: {{messagetime}}',
        });

        registerFunction({
            name: 'messagedate',
            callback: (str, matcherArg, args, vars) => {
                if(matcherArg.tokenizeAccurate){
                    return `00:00:00`
                }
                if(matcherArg.chatID === -1){
                    return "[Cannot get time]"
                }
                const db = getDatabase()
                const selchar = db.characters[getSelectedCharID()]
                const chat = selchar.chats[selchar.chatPage]
                const message = chat.message[matcherArg.chatID]
                if(!message.time){
                    return "[Cannot get time, message was sent in older version]"
                }
                const date = new Date(message.time)
                return date.toLocaleDateString()
            },
            alias: ['message_date'],
            description: 'Returns the date when the current message was sent in local date format. Returns "00:00:00" in tokenization mode or error messages for old/invalid messages.\n\nUsage:: {{messagedate}}',
        });

        registerFunction({
            name: 'messageunixtimearray',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                const selchar = db.characters[getSelectedCharID()]
                const chat = selchar.chats[selchar.chatPage]
                return makeArray(chat.message.map((f) => {
                    return `${f.time ?? 0}`
                }))
            },
            alias: ['message_unixtime_array'],
            description: 'Returns all message timestamps as a JSON array of unix timestamps (in milliseconds). Messages without timestamps show as 0.\n\nUsage:: {{messageunixtimearray}}',
        });

        registerFunction({
            name: 'unixtime',
            callback: (str, matcherArg, args, vars) => {
                const now = new Date()
                return (now.getTime() / 1000).toFixed(0)
            },
            alias: [],
            description: 'Returns the current unix timestamp in seconds as a string. Useful for time-based calculations and logging.\n\nUsage:: {{unixtime}}',
        });

        registerFunction({
            name: 'time',
            callback: (str, matcherArg, args, vars) => {
                const now = new Date()
                return `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`
            },
            alias: [],
            description: 'Returns the current local time in HH:MM:SS format. Updates in real-time when the function is called.\n\nUsage:: {{time}}',
        });

        registerFunction({
            name: 'isotime',
            callback: (str, matcherArg, args, vars) => {
                const now = new Date()
                return `${now.getUTCHours()}:${now.getUTCMinutes()}:${now.getUTCSeconds()}`
            },
            alias: [],
            description: 'Returns the current UTC time in HH:MM:SS format. Useful for timezone-independent time references.\n\nUsage:: {{isotime}}',
        });

        registerFunction({
            name: 'isodate',
            callback: (str, matcherArg, args, vars) => {
                const now = new Date()
                return `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}`
            },
            alias: [],
            description: 'Returns the current UTC date in YYYY-MM-DD format (month not zero-padded). Useful for timezone-independent date references.\n\nUsage:: {{isodate}}',
        });

        // Continue with remaining utility functions
        registerFunction({
            name: 'messageidleduration',
            callback: (str, matcherArg, args, vars) => {
                if(matcherArg.tokenizeAccurate){
                    return `00:00:00`
                }
                if(matcherArg.chatID === -1){
                    return "[Cannot get time]"
                }
                const db = getDatabase()
                const selchar = db.characters[getSelectedCharID()]
                const chat = selchar.chats[selchar.chatPage]

                let pointer = matcherArg.chatID
                let pointerMode = 'findLast'
                let message
                let previous_message
                while(pointer >= 0){
                    if(chat.message[pointer].role === 'user'){
                        if(pointerMode === 'findLast'){
                            message = chat.message[pointer]
                            pointerMode = 'findSecondLast'
                        }
                        else{
                            previous_message = chat.message[pointer]
                            break
                        }
                    }
                    pointer--
                }

                if(!message){
                    return '[No user message found]'
                }

                if(!previous_message){
                    return '[No previous user message found]'
                }
                if(!message.time){
                    return "[Cannot get time, message was sent in older version]"
                }
                if(!previous_message.time){
                    return "[Cannot get time, previous message was sent in older version]"
                }

                let duration = message.time - previous_message.time
                let seconds = Math.floor(duration / 1000)
                let minutes = Math.floor(seconds / 60)
                let hours = Math.floor(minutes / 60)
                seconds = seconds % 60
                minutes = minutes % 60
                return hours.toString() + ':' + minutes.toString().padStart(2,'0') + ':' + seconds.toString().padStart(2,'0')
            },
            alias: ['message_idle_duration'],
            description: 'Returns time duration between the current and previous user messages in HH:MM:SS format. Requires valid message times. Returns error messages if no messages found or timestamps missing.\n\nUsage:: {{messageidleduration}}',
        });

        registerFunction({
            name: 'idleduration',
            callback: (str, matcherArg, args, vars) => {
                if(matcherArg.tokenizeAccurate){
                    return `00:00:00`
                }
                const db = getDatabase()
                const selchar = db.characters[getSelectedCharID()]
                const chat = selchar.chats[selchar.chatPage]
                const messages = chat.message
                if(messages.length === 0){
                    return `00:00:00`
                }

                const lastMessage = messages[messages.length - 1]

                if(!lastMessage.time){
                    return "[Cannot get time, message was sent in older version]"
                }

                const now = new Date()

                let duration = now.getTime() - lastMessage.time

                let seconds = Math.floor(duration / 1000)
                let minutes = Math.floor(seconds / 60)
                let hours = Math.floor(minutes / 60)

                seconds = seconds % 60
                minutes = minutes % 60

                return hours.toString() + ':' + minutes.toString().padStart(2,'0') + ':' + seconds.toString().padStart(2,'0')
            },
            alias: ['idle_duration'],
            description: 'Returns time duration since the last message in the chat in HH:MM:SS format. Calculates from current time to last message timestamp. Returns "00:00:00" in tokenization mode or error for missing timestamps.\n\nUsage:: {{idleduration}}',
        });

        registerFunction({
            name: 'br',
            callback: (str, matcherArg, args, vars) => {
                return '\n'
            },
            alias: ['newline'],
            description: 'Returns a literal newline character (\\n). Useful for formatting text with line breaks in templates.\n\nUsage:: {{br}}',
        });

        registerFunction({
            name: 'model',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                return db.aiModel
            },
            alias: [],
            description: 'Returns the ID/name of the currently selected AI model (e.g., "gpt-4", "claude-3-opus").\n\nUsage:: {{model}}',
        });

        registerFunction({
            name: 'axmodel',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                return db.subModel
            },
            alias: [],
            description: 'Returns the currently selected sub/auxiliary model ID. Used for specialized tasks like embedding or secondary processing.\n\nUsage:: {{axmodel}}',
        });

        registerFunction({
            name: 'role',
            callback: (str, matcherArg, args, vars) => {
                if(matcherArg.cbsConditions.chatRole){
                    return matcherArg.cbsConditions.chatRole
                }
                if(matcherArg.cbsConditions.firstmsg){
                    return 'char'
                }
                if (matcherArg.chatID !== -1) {
                    const db = getDatabase()
                    const selchar = db.characters[getSelectedCharID()]
                    return selchar.chats[selchar.chatPage].message[matcherArg.chatID].role;
                }
                return matcherArg.role ?? 'null'
            },
            alias: [],
            description: 'Returns the role of the current message ("user", "char", "system"). Uses chatRole from conditions if available, "char" for first messages, or actual message role.\n\nUsage:: {{role}}',
        });

        registerFunction({
            name: 'isfirstmsg',
            callback: (str, matcherArg, args, vars) => {
                if(matcherArg.cbsConditions.firstmsg){
                    return '1'
                }
                return '0'
            },
            alias: ['isfirstmsg', 'isfirstmessage'],
            description: 'Returns "1" if the current context is the first message/greeting, "0" otherwise. Checks the firstmsg condition flag.\n\nUsage:: {{isfirstmsg}}',
        });

        registerFunction({
            name: 'jbtoggled',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                return db.jailbreakToggle ? '1' : '0'
            },
            alias: [],
            description: 'Returns "1" if the jailbreak prompt is currently enabled/toggled on, "0" if disabled. Reflects the global jailbreak toggle state.\n\nUsage:: {{jbtoggled}}',
        });

        registerFunction({
            name: 'maxcontext',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                return db.maxContext.toString()
            },
            alias: [],
            description: 'Returns the maximum context length setting as a string (e.g., "4096", "8192"). This is the token limit for the current model configuration.\n\nUsage:: {{maxcontext}}',
        });

        registerFunction({
            name: 'lastmessage',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                const selchar = db.characters[getSelectedCharID()]
                if(!selchar){
                    return ''
                }
                const chat = selchar.chats[selchar.chatPage]
                return chat.message[chat.message.length - 1].data
            },
            alias: [],
            description: 'Returns the content/data of the last message in the current chat, regardless of role (user/char). Returns empty string if no character selected.\n\nUsage:: {{lastmessage}}',
        });

        registerFunction({
            name: 'lastmessageid',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                const selchar = db.characters[getSelectedCharID()]
                if(!selchar){
                    return ''
                }
                const chat = selchar.chats[selchar.chatPage]
                return (chat.message.length - 1).toString()
            },
            alias: ['lastmessageindex'],
            description: 'Returns the index of the last message in the chat as a string (0-based indexing). Returns empty string if no character selected.\n\nUsage:: {{lastmessageid}}',
        });

        // Variable handling functions
        registerFunction({
            name: 'tempvar',
            callback: (str, matcherArg, args, vars) => {
                return {
                    text: vars[args[0]] ?? '',
                    var: vars
                }
            },
            alias: ['gettempvar'],
            description: 'Gets the value of a temporary variable by name. Temporary variables only exist during the current script execution. Returns empty string if variable doesn\'t exist.\n\nUsage:: {{tempvar::variableName}}',
        });

        registerFunction({
            name: 'settempvar',
            callback: (str, matcherArg, args, vars) => {
                vars[args[0]] = args[1]
                return {
                    text: '',
                    var: vars
                }
            },
            alias: [],
            description: 'Sets a temporary variable to the specified value. Temporary variables only exist during current script execution. Always returns empty string.\n\nUsage:: {{settempvar::variableName::value}}',
        });

        registerFunction({
            name: 'return',
            callback: (str, matcherArg, args, vars) => {
                vars['__return__'] = args[0]
                vars['__force_return__'] = '1'
                return {
                    text: '',
                    var: vars
                }
            },
            alias: [],
            description: 'Sets the return value and immediately exits script execution. Used to return values from script functions. Sets internal __return__ and __force_return__ variables.\n\nUsage:: {{return::value}}',
        });

        registerFunction({
            name: 'getvar',
            callback: (str, matcherArg, args, vars) => {
                return getChatVar(args[0])
            },
            alias: [],
            description: 'Gets the value of a persistent chat variable by name. Chat variables are saved with the chat and persist between sessions. Returns empty string if variable doesn\'t exist.\n\nUsage:: {{getvar::variableName}}',
        });

        registerFunction({
            name: 'calc',
            callback: (str, matcherArg, args, vars) => {
                return calcString(args[0]).toString()
            },
            alias: [],
            description: 'Evaluates a mathematical expression and returns the result as a string. Supports basic arithmetic operations (+, -, *, /, parentheses).\n\nUsage:: {{calc::2+2*3}}',
        });

        registerFunction({
            name: 'addvar',
            callback: (str, matcherArg, args, vars) => {
                if(matcherArg.rmVar){
                    return ''
                }
                if(matcherArg.runVar){
                    setChatVar(args[0], (Number(getChatVar(args[0])) + Number(args[1])).toString())
                    return ''
                }
                return null
            },
            alias: [],
            description: 'Adds a numeric value to an existing chat variable. Treats the variable as a number, adds the specified amount, and saves the result. Only executes when runVar is true.\n\nUsage:: {{addvar::counter::5}}',
        });

        registerFunction({
            name: 'setvar',
            callback: (str, matcherArg, args, vars) => {
                if(matcherArg.rmVar){
                    return ''
                }
                if(matcherArg.runVar){
                    setChatVar(args[0], args[1])
                    return ''
                }
                return null
            },
            alias: [],
            description: 'Sets a persistent chat variable to the specified value. Chat variables are saved with the chat and persist between sessions. Only executes when runVar is true.\n\nUsage:: {{setvar::variableName::value}}',
        });

        registerFunction({
            name: 'setdefaultvar',
            callback: (str, matcherArg, args, vars) => {
                if(matcherArg.rmVar){
                    return ''
                }
                if(matcherArg.runVar){
                    const currentValue = getChatVar(args[0])
                    if(!currentValue || currentValue === 'null'){
                        setChatVar(args[0], args[1])
                    }
                    return ''
                }
                return null
            },
            alias: [],
            description: 'Sets a chat variable to the specified value only if the variable doesn\'t already exist or is empty. Used for setting default values. Only executes when runVar is true.\n\nUsage:: {{setdefaultvar::variableName::defaultValue}}',
        });

        registerFunction({
            name: 'getglobalvar',
            callback: (str, matcherArg, args, vars) => {
                return getGlobalChatVar(args[0])
            },
            alias: [],
            description: 'Gets the value of a global chat variable by name. Global variables are shared across all chats and characters. Returns empty string if variable doesn\'t exist.\n\nUsage:: {{getglobalvar::variableName}}',
        });

        registerFunction({
            name: 'button',
            callback: (str, matcherArg, args, vars) => {
                return `<button class="button-default" risu-trigger="${args[1]}">${args[0]}</button>`
            },
            alias: [],
            description: 'Creates an HTML button element with specified text and trigger action. When clicked, executes the trigger command. Returns HTML button markup.\n\nUsage:: {{button::Click Me::trigger_command}}',
        });

        registerFunction({
            name: 'risu',
            callback: (str, matcherArg, args, vars) => {
                const size = args[0] || '45'
                return `<img src="/logo2.png" style="height:${size}px;width:${size}px" />`
            },
            alias: [],
            description: 'Displays the Risuai logo image with specified size in pixels. Default size is 45px if no argument provided. Returns HTML img element.\n\nUsage:: {{risu}} or {{risu::60}}',
        });

        // Comparison functions
        registerFunction({
            name: 'equal',
            callback: (str, matcherArg, args, vars) => {
                return (args[0] === args[1]) ? '1' : '0'
            },
            alias: [],
            description: 'Compares two values for exact equality. Returns "1" if values are identical (string comparison), "0" otherwise. Case-sensitive.\n\nUsage:: {{equal::value1::value2}}',
        });

        registerFunction({
            name: 'notequal',
            callback: (str, matcherArg, args, vars) => {
                return (args[0] !== args[1]) ? '1' : '0'
            },
            alias: ['not_equal'],
            description: 'Compares two values for inequality. Returns "1" if values are different (string comparison), "0" if identical. Case-sensitive.\n\nUsage:: {{notequal::value1::value2}}',
        });

        registerFunction({
            name: 'greater',
            callback: (str, matcherArg, args, vars) => {
                return (Number(args[0]) > Number(args[1])) ? '1' : '0'
            },
            alias: [],
            description: 'Compares two numeric values. Returns "1" if first number is greater than second, "0" otherwise. Converts arguments to numbers before comparison.\n\nUsage:: {{greater::10::5}}',
        });

        registerFunction({
            name: 'less',
            callback: (str, matcherArg, args, vars) => {
                return (Number(args[0]) < Number(args[1])) ? '1' : '0'
            },
            alias: [],
            description: 'Compares two numeric values. Returns "1" if first number is less than second, "0" otherwise. Converts arguments to numbers before comparison.\n\nUsage:: {{less::5::10}}',
        });

        registerFunction({
            name: 'greaterequal',
            callback: (str, matcherArg, args, vars) => {
                return (Number(args[0]) >= Number(args[1])) ? '1' : '0'
            },
            alias: ['greater_equal'],
            description: 'Compares two numeric values. Returns "1" if first number is greater than or equal to second, "0" otherwise. Converts arguments to numbers before comparison.\n\nUsage:: {{greaterequal::10::10}}',
        });

        registerFunction({
            name: 'lessequal',
            callback: (str, matcherArg, args, vars) => {
                return (Number(args[0]) <= Number(args[1])) ? '1' : '0'
            },
            alias: ['less_equal'],
            description: 'Compares two numeric values. Returns "1" if first number is less than or equal to second, "0" otherwise. Converts arguments to numbers before comparison.\n\nUsage:: {{lessequal::5::5}}',
        });

        registerFunction({
            name: 'and',
            callback: (str, matcherArg, args, vars) => {
                return args[0] === '1' && args[1] === '1' ? '1' : '0'
            },
            alias: [],
            description: 'Performs logical AND on two boolean values. Returns "1" only if both arguments are "1", otherwise returns "0". Treats any value other than "1" as false.\n\nUsage:: {{and::1::1}}',
        });

        registerFunction({
            name: 'or',
            callback: (str, matcherArg, args, vars) => {
                return args[0] === '1' || args[1] === '1' ? '1' : '0'
            },
            alias: [],
            description: 'Performs logical OR on two boolean values. Returns "1" if either argument is "1", otherwise returns "0". Treats any value other than "1" as false.\n\nUsage:: {{or::1::0}}',
        });

        registerFunction({
            name: 'not',
            callback: (str, matcherArg, args, vars) => {
                return args[0] === '1' ? '0' : '1'
            },
            alias: [],
            description: 'Performs logical NOT on a boolean value. Returns "0" if argument is "1", returns "1" for any other value. Inverts the boolean state.\n\nUsage:: {{not::1}}',
        });

        registerFunction({
            name: 'file',
            callback: (str, matcherArg, args, vars) => {
                if(matcherArg.displaying){
                    return `<br><div class="risu-file">${args[0]}</div><br>`
                }
                return Buffer.from(args[1], 'base64').toString('utf-8')
            },
            alias: [],
            description: 'Handles file display or decoding. In display mode, shows filename in a formatted div. Otherwise, decodes base64 content to UTF-8 text.\n\nUsage:: {{file::filename::base64content}}',
        });

        // String manipulation functions
        registerFunction({
            name: 'startswith',
            callback: (str, matcherArg, args, vars) => {
                return args[0].startsWith(args[1]) ? '1' : '0'
            },
            alias: [],
            description: 'Checks if a string starts with a specific substring. Returns "1" if the string begins with the substring, "0" otherwise. Case-sensitive.\n\nUsage:: {{startswith::Hello World::Hello}}',
        });

        registerFunction({
            name: 'endswith',
            callback: (str, matcherArg, args, vars) => {
                return args[0].endsWith(args[1]) ? '1' : '0'
            },
            alias: [],
            description: 'Checks if a string ends with a specific substring. Returns "1" if the string ends with the substring, "0" otherwise. Case-sensitive.\n\nUsage:: {{endswith::Hello World::World}}',
        });

        registerFunction({
            name: 'contains',
            callback: (str, matcherArg, args, vars) => {
                return args[0].includes(args[1]) ? '1' : '0'
            },
            alias: [],
            description: 'Checks if a string contains a specific substring anywhere within it. Returns "1" if found, "0" otherwise. Case-sensitive.\n\nUsage:: {{contains::Hello World::lo Wo}}',
        });

        registerFunction({
            name: 'replace',
            callback: (str, matcherArg, args, vars) => {
                return args[0].replaceAll(args[1], args[2])
            },
            alias: [],
            description: 'Replaces all occurrences of a substring with a new string. Global replacement - changes every instance found. Case-sensitive.\n\nUsage:: {{replace::Hello World::o::0}} → Hell0 W0rld',
        });

        registerFunction({
            name: 'split',
            callback: (str, matcherArg, args, vars) => {
                return makeArray(args[0].split(args[1]))
            },
            alias: [],
            description: 'Splits a string into an array using the specified delimiter. Returns a JSON array of string parts.\n\nUsage:: {{split::apple,banana,cherry::,}} → ["apple","banana","cherry"]',
        });

        registerFunction({
            name: 'join',
            callback: (str, matcherArg, args, vars) => {
                return (parseArray(args[0])).join(args[1])
            },
            alias: [],
            description: 'Joins array elements into a single string using the specified separator. Takes a JSON array and delimiter.\n\nUsage:: {{join::["apple","banana"]::, }} → apple, banana',
        });

        registerFunction({
            name: 'spread',
            callback: (str, matcherArg, args, vars) => {
                return (parseArray(args[0])).join('::')
            },
            alias: [],
            description: 'Joins array elements into a single string using "::" as separator. Specialized version of join for CBS array spreading.\n\nUsage:: {{spread::["a","b","c"]}} → a::b::c',
        });

        registerFunction({
            name: 'trim',
            callback: (str, matcherArg, args, vars) => {
                return args[0].trim()
            },
            alias: [],
            description: 'Removes leading and trailing whitespace from a string. Does not affect whitespace in the middle of the string.\n\nUsage:: {{trim::  hello world  }} → hello world',
        });

        registerFunction({
            name: 'length',
            callback: (str, matcherArg, args, vars) => {
                return args[0].length.toString()
            },
            alias: [],
            description: 'Returns the character length of a string as a number. Counts all characters including spaces and special characters.\n\nUsage:: {{length::Hello}} → 5',
        });

        // Array/Object manipulation functions
        registerFunction({
            name: 'arraylength',
            callback: (str, matcherArg, args, vars) => {
                return parseArray(args[0]).length.toString()
            },
            alias: ['arraylength'],
            description: 'Returns the number of elements in a JSON array as a string. Parses the array and counts elements.\n\nUsage:: {{arraylength::["a","b","c"]}} → 3',
        });

        registerFunction({
            name: 'lower',
            callback: (str, matcherArg, args, vars) => {
                return args[0].toLocaleLowerCase()
            },
            alias: [],
            description: 'Converts all characters in a string to lowercase using locale-aware conversion. Handles international characters properly.\n\nUsage:: {{lower::Hello WORLD}} → hello world',
        });

        registerFunction({
            name: 'upper',
            callback: (str, matcherArg, args, vars) => {
                return args[0].toLocaleUpperCase()
            },
            alias: [],
            description: 'Converts all characters in a string to uppercase using locale-aware conversion. Handles international characters properly.\n\nUsage:: {{upper::Hello world}} → HELLO WORLD',
        });

        registerFunction({
            name: 'capitalize',
            callback: (str, matcherArg, args, vars) => {
                return args[0].charAt(0).toUpperCase() + args[0].slice(1)
            },
            alias: [],
            description: 'Capitalizes only the first character of a string, leaving the rest unchanged. Useful for sentence-case formatting.\n\nUsage:: {{capitalize::hello world}} → Hello world',
        });

        registerFunction({
            name: 'round',
            callback: (str, matcherArg, args, vars) => {
                return Math.round(Number(args[0])).toString()
            },
            alias: [],
            description: 'Rounds a decimal number to the nearest integer using standard rounding rules (0.5 rounds up). Returns result as string.\n\nUsage:: {{round::3.7}} → 4',
        });

        registerFunction({
            name: 'floor',
            callback: (str, matcherArg, args, vars) => {
                return Math.floor(Number(args[0])).toString()
            },
            alias: [],
            description: 'Rounds a decimal number down to the nearest integer (floor function). Always rounds towards negative infinity.\n\nUsage:: {{floor::3.9}} → 3',
        });

        registerFunction({
            name: 'ceil',
            callback: (str, matcherArg, args, vars) => {
                return Math.ceil(Number(args[0])).toString()
            },
            alias: [],
            description: 'Rounds a decimal number up to the nearest integer (ceiling function). Always rounds towards positive infinity.\n\nUsage:: {{ceil::3.1}} → 4',
        });

        registerFunction({
            name: 'abs',
            callback: (str, matcherArg, args, vars) => {
                return Math.abs(Number(args[0])).toString()
            },
            alias: [],
            description: 'Returns the absolute value of a number (removes negative sign). Converts to positive value regardless of input sign.\n\nUsage:: {{abs::-5}} → 5',
        });

        registerFunction({
            name: 'remaind',
            callback: (str, matcherArg, args, vars) => {
                return (Number(args[0]) % Number(args[1])).toString()
            },
            alias: [],
            description: 'Returns the remainder after dividing first number by second (modulo operation). Useful for cycles and ranges.\n\nUsage:: {{remaind::10::3}} → 1',
        });

        registerFunction({
            name: 'previouschatlog',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                const selchar = db.characters[getSelectedCharID()]
                const chat = selchar?.chats?.[selchar.chatPage]
                return chat?.message[Number(args[0])]?.data ?? 'Out of range'
            },
            alias: ['previous_chat_log'],
            description: 'Retrieves the message content at the specified index in the chat history. Returns "Out of range" if index is invalid.\n\nUsage:: {{previouschatlog::5}}',
        });

        registerFunction({
            name: 'tonumber',
            callback: (str, matcherArg, args, vars) => {
                return ([...args[0]].filter((v) => {
                    return !isNaN(Number(v)) || v === '.'
                })).join('')
            },
            alias: [],
            description: 'Extracts only numeric characters (0-9) and decimal points from a string, removing all other characters.\n\nUsage:: {{tonumber::abc123.45def}} → 123.45',
        });

        registerFunction({
            name: 'pow',
            callback: (str, matcherArg, args, vars) => {
                return Math.pow(Number(args[0]), Number(args[1])).toString()
            },
            alias: [],
            description: 'Calculates the power of a number (base raised to exponent). Performs mathematical exponentiation.\n\nUsage:: {{pow::2::3}} → 8 (2³)',
        });

        registerFunction({
            name: 'arrayelement',
            callback: (str, matcherArg, args, vars) => {
                const element = parseArray(args[0]).at(Number(args[1])) ?? 'null'
                return typeof element === 'object' ? JSON.stringify(element) : String(element)
            },
            alias: ['arrayelement'],
            description: 'Retrieves the element at the specified index from a JSON array. Uses 0-based indexing. Returns "null" if index is out of bounds.\n\nUsage:: {{arrayelement::["a","b","c"]::1}} → b',
        });

        registerFunction({
            name: 'dictelement',
            callback: (str, matcherArg, args, vars) => {
                const element = parseDict(args[0])[args[1]] ?? 'null'
                return typeof element === 'object' ? JSON.stringify(element) : String(element)
            },
            alias: ['dictelement', 'objectelement'],
            description: 'Retrieves the value associated with a key from a JSON object/dictionary. Returns "null" if key doesn\'t exist.\n\nUsage:: {{dictelement::{"name":"John"}::name}} → John',
        });

        registerFunction({
            name: 'objectassert',
            callback: (str, matcherArg, args, vars) => {
                const dict = parseDict(args[0])
                if(!dict[args[1]]){
                    dict[args[1]] = args[2]
                }
                return JSON.stringify(dict)
            },
            alias: ['dictassert', 'object_assert'],
            description: 'Sets a property in a JSON object only if the property doesn\'t already exist. Returns the modified object as JSON. Used for default values.\n\nUsage:: {{objectassert::{"a":1}::b::2}} → {"a":1,"b":2}',
        });

        registerFunction({
            name: 'element',
            callback: (str, matcherArg, args, vars) => {
                try {
                    const agmts = args.slice(1)
                    let current = args[0]
                    for(const arg of agmts){
                        const parsed = JSON.parse(current)
                        if(parsed === null || (typeof(parsed) !== 'object' && !Array.isArray(parsed))){
                            return 'null'
                        }
                        current = parsed[arg]
                        if(!current){
                            return 'null'
                        }
                    }
                    return current
                } catch (error) {
                    return 'null'
                }
            },
            alias: ['ele'],
            description: 'Retrieves a deeply nested element from a JSON structure using multiple keys/indices. Traverses the object path step by step. Returns "null" if any step fails.\n\nUsage:: {{element::{"user":{"name":"John"}}::user::name}} → John',
        });

        registerFunction({
            name: 'arrayshift',
            callback: (str, matcherArg, args, vars) => {
                const arr = parseArray(args[0])
                arr.shift()
                return makeArray(arr)
            },
            alias: ['arrayshift'],
            description: 'Removes and discards the first element from a JSON array. Returns the modified array without the first element.\n\nUsage:: {{arrayshift::["a","b","c"]}} → ["b","c"]',
        });

        registerFunction({
            name: 'arraypop',
            callback: (str, matcherArg, args, vars) => {
                const arr = parseArray(args[0])
                arr.pop()
                return makeArray(arr)
            },
            alias: ['arraypop'],
            description: 'Removes and discards the last element from a JSON array. Returns the modified array without the last element.\n\nUsage:: {{arraypop::["a","b","c"]}} → ["a","b"]',
        });

        registerFunction({
            name: 'arraypush',
            callback: (str, matcherArg, args, vars) => {
                const arr = parseArray(args[0])
                arr.push(args[1])
                return makeArray(arr)
            },
            alias: ['arraypush'],
            description: 'Adds a new element to the end of a JSON array. Returns the modified array with the new element appended.\n\nUsage:: {{arraypush::["a","b"]::c}} → ["a","b","c"]',
        });

        registerFunction({
            name: 'arraysplice',
            callback: (str, matcherArg, args, vars) => {
                const arr = parseArray(args[0])
                arr.splice(Number(args[1]), Number(args[2]), args[3])
                return makeArray(arr)
            },
            alias: ['arraysplice'],
            description: 'Modifies an array by removing elements and optionally inserting new ones at a specific index. Parameters: array, startIndex, deleteCount, newElement.\n\nUsage:: {{arraysplice::["a","b","c"]::1::1::x}} → ["a","x","c"]',
        });

        registerFunction({
            name: 'arrayassert',
            callback: (str, matcherArg, args, vars) => {
                const arr = parseArray(args[0])
                const index = Number(args[1])
                if(index >= arr.length){
                    arr[index] = args[2]
                }
                return makeArray(arr)
            },
            alias: ['arrayassert'],
            description: 'Sets an array element at the specified index only if the index is currently out of bounds (extends array). Fills gaps with undefined.\n\nUsage:: {{arrayassert::["a"]::5::b}} → array with element "b" at index 5',
        });

        registerFunction({
            name: 'makearray',
            callback: (str, matcherArg, args, vars) => {
                return makeArray(args)
            },
            alias: ['array', 'a', 'makearray'],
            description: 'Creates a JSON array from the provided arguments. Each argument becomes an array element. Variable number of arguments supported.\n\nUsage:: {{makearray::a::b::c}} → ["a","b","c"]',
        });

        registerFunction({
            name: 'makedict',
            callback: (str, matcherArg, args, vars) => {
                let out = {}
                for(let i=0;i<args.length;i++){
                    const current = args[i]
                    const firstEqual = current.indexOf('=')
                    if(firstEqual === -1){
                        continue
                    }
                    const key = current.substring(0, firstEqual)
                    const value = current.substring(firstEqual + 1)
                    out[key] = value ?? 'null'
                }
                return JSON.stringify(out)
            },
            alias: ['dict', 'd', 'makedict', 'makeobject', 'object', 'o'],
            description: 'Creates a JSON object from key=value pair arguments. Each argument should be in "key=value" format. Invalid pairs are ignored.\n\nUsage:: {{makedict::name=John::age=25}} → {"name":"John","age":"25"}',
        });

        // Missing basic functions (no arguments)
        registerFunction({
            name: 'emotionlist',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                const selchar = db.characters[getSelectedCharID()]
                if(!selchar){
                    return ''
                }
                return makeArray(selchar.emotionImages?.map((f) => {
                    return f[0]
                })) ?? ''
            },
            alias: [],
            description: 'Returns a JSON array of emotion image names available for the current character. Only includes the names, not the actual image data. Returns empty string if no character or no emotions.\n\nUsage:: {{emotionlist}}',
        });

        registerFunction({
            name: 'assetlist',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                const selchar = db.characters[getSelectedCharID()]
                if(!selchar || selchar.type === 'group'){
                    return ''
                }
                return makeArray(selchar.additionalAssets?.map((f) => {
                    return f[0]
                }))
            },
            alias: [],
            description: 'Returns a JSON array of additional asset names for the current character. These are extra images/files beyond the main avatar. Returns empty string for groups or characters without assets.\n\nUsage:: {{assetlist}}',
        });

        registerFunction({
            name: 'prefillsupported',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                return db.aiModel.startsWith('claude') ? '1' : '0'
            },
            alias: ['prefill_supported', 'prefill'],
            description: 'Returns "1" if the current AI model supports prefill functionality (like Claude models), "0" otherwise. Prefill allows pre-filling the assistant\'s response start.\n\nUsage:: {{prefillsupported}}',
        });

        registerFunction({
            name: 'screenwidth',
            callback: (str, matcherArg, args, vars) => {
                return String(CUR.meta.w || 0)
            },
            alias: ['screen_width'],
            description: 'Returns the current screen/viewport width in pixels as a string. Updates dynamically with window resizing. Useful for responsive layouts.\n\nUsage:: {{screenwidth}}',
        });

        registerFunction({
            name: 'screenheight',
            callback: (str, matcherArg, args, vars) => {
                return String(CUR.meta.h || 0)
            },
            alias: ['screen_height'],
            description: 'Returns the current screen/viewport height in pixels as a string. Updates dynamically with window resizing. Useful for responsive layouts.\n\nUsage:: {{screenheight}}',
        });

        registerFunction({
            name: 'cbr',
            callback: (str, matcherArg, args, vars) => {

                if(args.length > 0){
                    return str.repeat(Number(args[0]) < 1 ? 1 : Number(args[0]))
                }
                return '\\n'
            },
            alias: ['cnl', 'cnewline'],
            description: 'Returns an escaped newline character (\\\\n). With optional numeric argument, repeats the character that many times (minimum 1).\n\nUsage:: {{cbr}} or {{cbr::3}}',
        });

        registerFunction({
            name: 'decbo',
            callback: (str, matcherArg, args, vars) => {
                return '\uE9b8'
            },
            alias: ['displayescapedcurlybracketopen'],
            description: 'Returns a special Unicode character that displays as an opening curly bracket { but won\'t be parsed as CBS syntax. Used to display literal braces in output.\n\nUsage:: {{decbo}}',
        });

        registerFunction({
            name: 'decbc',
            callback: (str, matcherArg, args, vars) => {
                return '\uE9b9'
            },
            alias: ['displayescapedcurlybracketclose'],
            description: 'Returns a special Unicode character that displays as a closing curly bracket } but won\'t be parsed as CBS syntax. Used to display literal braces in output.\n\nUsage:: {{decbc}}',
        });

        registerFunction({
            name: 'bo',
            callback: (str, matcherArg, args, vars) => {
                return '\uE9b8\uE9b8'
            },
            alias: ['ddecbo', 'doubledisplayescapedcurlybracketopen'],
            description: 'Returns two special Unicode characters that display as opening double curly brackets {{ but won\'t be parsed as CBS syntax. Used to display literal CBS syntax.\n\nUsage:: {{bo}}',
        });

        registerFunction({
            name: 'bc',
            callback: (str, matcherArg, args, vars) => {
                return '\uE9b9\uE9b9'
            },
            alias: ['ddecbc', 'doubledisplayescapedcurlybracketclose'],
            description: 'Returns two special Unicode characters that display as closing double curly brackets }} but won\'t be parsed as CBS syntax. Used to display literal CBS syntax.\n\nUsage:: {{bc}}',
        });

        registerFunction({
            name: 'displayescapedbracketopen',
            callback: (str, matcherArg, args, vars) => {
                return '\uE9BA'
            },
            alias: ['debo', '('],
            description: 'Returns a special Unicode character that displays as an opening parenthesis ( but won\'t interfere with parsing. Used for literal parentheses in output.\n\nUsage:: {{displayescapedbracketopen}}',
        });

        registerFunction({
            name: 'displayescapedbracketclose',
            callback: (str, matcherArg, args, vars) => {
                return '\uE9BB'
            },
            alias: ['debc', ')'],
            description: 'Returns a special Unicode character that displays as a closing parenthesis ) but won\'t interfere with parsing. Used for literal parentheses in output.\n\nUsage:: {{displayescapedbracketclose}}',
        });

        registerFunction({
            name: 'displayescapedanglebracketopen',
            callback: (str, matcherArg, args, vars) => {
                return '\uE9BC'
            },
            alias: ['deabo', '<'],
            description: 'Returns a special Unicode character that displays as an opening angle bracket < but won\'t interfere with HTML parsing. Used for literal angle brackets.\n\nUsage:: {{displayescapedanglebracketopen}}',
        });

        registerFunction({
            name: 'displayescapedanglebracketclose',
            callback: (str, matcherArg, args, vars) => {
                return '\uE9BD'
            },
            alias: ['deabc', '>'],
            description: 'Returns a special Unicode character that displays as a closing angle bracket > but won\'t interfere with HTML parsing. Used for literal angle brackets.\n\nUsage:: {{displayescapedanglebracketclose}}',
        });

        registerFunction({
            name: 'displayescapedcolon',
            callback: (str, matcherArg, args, vars) => {
                return '\uE9BE'
            },
            alias: ['dec', ':'],
            description: 'Returns a special Unicode character that displays as a colon : but won\'t be parsed as CBS argument separator. Used for literal colons in output.\n\nUsage:: {{displayescapedcolon}}',
        });

        registerFunction({
            name: 'displayescapedsemicolon',
            callback: (str, matcherArg, args, vars) => {
                return '\uE9BF'
            },
            alias: [';'],
            description: 'Returns a special Unicode character that displays as a semicolon ; but won\'t interfere with parsing. Used for literal semicolons in output.\n\nUsage:: {{displayescapedsemicolon}}',
        });

        registerFunction({
            name: 'chardisplayasset',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                const selchar = db.characters[getSelectedCharID()]

                if(!selchar.prebuiltAssetCommand){
                    return makeArray([])
                }

                const excludes = selchar.prebuiltAssetExclude ?? []
                const arr = (selchar?.additionalAssets ?? []).filter((f) => {
                    return !excludes.includes(f[1])
                })

                return makeArray(arr.map((f) => {
                    return f[0]
                }))
            },
            alias: [],
            description: 'Returns a JSON array of character display asset names, filtered by prebuilt asset exclusion settings. Only includes assets not in the exclude list.\n\nUsage:: {{chardisplayasset}}',
        });

        // Missing functions with :: arguments
        registerFunction({
            name: 'history',
            callback: (str, matcherArg, args, vars) => {

                if(args.length === 0){
                    const db = getDatabase()
                    const selchar = db.characters[getSelectedCharID()]
                    const chat = selchar.chats[selchar.chatPage]
                    return makeArray([{
                        role: 'char',
                        data: chat.fmIndex === -1 ? selchar.firstMessage : selchar.alternateGreetings[chat.fmIndex]
                    }].concat(chat.message).map((v) => {
                        v = safeStructuredClone(v)
                        v.data = risuChatParser(v.data, matcherArg)
                        return JSON.stringify(v)
                    }))
                }
                const db = getDatabase()
                const selchar = db.characters[getSelectedCharID()]
                const chat = selchar.chats[selchar.chatPage]
                return makeArray(chat.message.map((f) => {
                    let data = ''
                    if(args.includes('role')){
                        data += f.role + ': '
                    }
                    data += f.data
                    return data
                }))
            },
            alias: ['messages'],
            description: 'Returns chat history as a JSON array. With no arguments, returns full message objects. With "role" argument, prefixes each message with "role: ". Includes first message/greeting.\n\nUsage:: {{history}} or {{history::role}}',
        });

        registerFunction({
            name: 'range',
            callback: (str, matcherArg, args, vars) => {
                const arr = parseArray(args[0])
                const start = arr.length > 1 ? Number(arr[0]) : 0
                const end = arr.length > 1 ? Number(arr[1]) : Number(arr[0])
                const step = arr.length > 2 ? Number(arr[2]) : 1
                let out = []

                for(let i=start;i<end;i+=step){
                    out.push(i.toString())
                }

                return makeArray(out)
            },
            alias: [],
            description: 'Creates a JSON array of sequential numbers. Single argument: 0 to N-1. Two arguments: start to end-1. Three arguments: start to end-1 with step.\n\nUsage:: {{range::[5]}} → [0,1,2,3,4] or {{range::[2,8,2]}} → [2,4,6]',
        });

        registerFunction({
            name: 'date',
            callback: (str, matcherArg, args, vars) => {

                if(args.length === 0){
                    const now = new Date()
                    return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
                }
                const secondParam = args[1]
                let t = 0
                if(secondParam){
                    t = (Number(secondParam) / 1000)
                    if(isNaN(t)){
                        t = 0
                    }
                }
                return dateTimeFormat(args[0], t)
            },
            alias: ['datetimeformat'],
            description: 'Formats date/time using custom format string. No arguments returns YYYY-M-D. First argument is format string, optional second argument is unix timestamp.\n\nUsage:: {{date::YYYY-MM-DD}} or {{date::HH:mm:ss::1640995200000}}',
        });

        registerFunction({
            name: 'time',
            callback: (str, matcherArg, args, vars) => {

                if(args.length === 0){
                    const now = new Date()
                    return `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`
                }
                const secondParam = args[1]
                let t = 0
                if(secondParam){
                    t = (Number(secondParam) / 1000)
                    if(isNaN(t)){
                        t = 0
                    }
                }
                return dateTimeFormat(args[0], t)
            },
            alias: [],
            description: 'Formats date/time using custom format string. No arguments returns h:m:s. First argument is format string, optional second argument is unix timestamp.\n\nUsage:: {{date::YYYY-MM-DD}} or {{date::HH:mm:ss::1640995200000}}',
        });

        registerFunction({
            name: 'moduleenabled',
            callback: (str, matcherArg, args, vars) => {
                const modules = getModules()
                for(const module of modules){
                    if(module.namespace === args[0]){
                        return '1'
                    }
                }
                return '0'
            },
            alias: ['module_enabled'],
            description: 'Checks if a module with the specified namespace is currently enabled/loaded. Returns "1" if found, "0" otherwise.\n\nUsage:: {{moduleenabled::mymodule}}',
        });

        registerFunction({
            name: 'moduleassetlist',
            callback: (str, matcherArg, args, vars) => {
                const module = getModules()?.find((f) => {
                    return f.namespace === args[0]
                })
                if(!module){
                    return ''
                }
                return makeArray(module.assets?.map((f) => {
                    return f[0]
                }))
            },
            alias: ['module_assetlist'],
            description: 'Returns a JSON array of asset names for the specified module namespace. Returns empty string if module not found.\n\nUsage:: {{moduleassetlist::mymodule}}',
        });

        registerFunction({
            name: 'filter',
            callback: (str, matcherArg, args, vars) => {
                const array = parseArray(args[0])
                const filterTypes = [
                    'all',
                    'nonempty',
                    'unique',
                ]
                let filterType = filterTypes.indexOf(args[1])
                if(filterType === -1){
                    filterType = 0
                }
                return makeArray(array.filter((f, i) => {
                    switch(filterType){
                        case 0:
                            return f !== '' && i === array.indexOf(f)
                        case 1:
                            return f !== ''
                        case 2:
                            return i === array.indexOf(f)
                    }
                }))
            },
            alias: [],
            description: 'Filters a JSON array based on the specified filter type. "all": removes empty and duplicates, "nonempty": removes empty only, "unique": removes duplicates only.\n\nUsage:: {{filter::["a","","a"]::unique}} → ["a",""]',
        });

        registerFunction({
            name: 'all',
            callback: (str, matcherArg, args, vars) => {
                const array = args.length > 1 ? args : parseArray(args[0])
                const all = array.every((f) => {
                    return f === '1'
                })
                return all ? '1' : '0'
            },
            alias: [],
            description: 'Returns "1" only if all provided values are "1", otherwise returns "0". Can take array as first argument or multiple arguments. Logical AND of all values.\n\nUsage:: {{all::1::1::1}} → 1',
        });

        registerFunction({
            name: 'any',
            callback: (str, matcherArg, args, vars) => {
                const array = args.length > 1 ? args : parseArray(args[0])
                const any = array.some((f) => {
                    return f === '1'
                })
                return any ? '1' : '0'
            },
            alias: [],
            description: 'Returns "1" if any provided value is "1", otherwise returns "0". Can take array as first argument or multiple arguments. Logical OR of all values.\n\nUsage:: {{any::0::1::0}} → 1',
        });

        registerFunction({
            name: 'min',
            callback: (str, matcherArg, args, vars) => {
                const val = args.length > 1 ? args : parseArray(args[0])
                return Math.min(...val.map((f) => {
                    const num = Number(f)
                    if(isNaN(num)){
                        return 0
                    }
                    return num
                })).toString()
            },
            alias: [],
            description: 'Returns the smallest numeric value from the provided values. Can take array as first argument or multiple arguments. Non-numeric values treated as 0.\n\nUsage:: {{min::5::2::8}} → 2',
        });

        registerFunction({
            name: 'max',
            callback: (str, matcherArg, args, vars) => {
                const val = args.length > 1 ? args : parseArray(args[0])
                return Math.max(...val.map((f) => {
                    const num = Number(f)
                    if(isNaN(num)){
                        return 0
                    }
                    return num
                })).toString()
            },
            alias: [],
            description: 'Returns the largest numeric value from the provided values. Can take array as first argument or multiple arguments. Non-numeric values treated as 0.\n\nUsage:: {{max::5::2::8}} → 8',
        });

        registerFunction({
            name: 'sum',
            callback: (str, matcherArg, args, vars) => {
                const val = args.length > 1 ? args : parseArray(args[0])
                return val.map((f) => {
                    const num = Number(f)
                    if(isNaN(num)){
                        return 0
                    }
                    return num
                }).reduce((a, b) => a + b, 0).toString()
            },
            alias: [],
            description: 'Returns the sum of all numeric values provided. Can take array as first argument or multiple arguments. Non-numeric values treated as 0.\n\nUsage:: {{sum::1::2::3}} → 6',
        });

        registerFunction({
            name: 'average',
            callback: (str, matcherArg, args, vars) => {
                const val = args.length > 1 ? args : parseArray(args[0])
                const sum = val.map((f) => {
                    const num = Number(f)
                    if(isNaN(num)){
                        return 0
                    }
                    return num
                }).reduce((a, b) => a + b, 0)
                return (sum / val.length).toString()
            },
            alias: [],
            description: 'Returns the arithmetic mean of all numeric values provided. Can take array as first argument or multiple arguments. Non-numeric values treated as 0.\n\nUsage:: {{average::2::4::6}} → 4',
        });

        registerFunction({
            name: 'fixnum',
            callback: (str, matcherArg, args, vars) => {
                return Number(args[0]).toFixed(Number(args[1]))
            },
            alias: ['fixnum', 'fixnumber'],
            description: 'Rounds a number to the specified number of decimal places. Uses toFixed() method for consistent formatting.\n\nUsage:: {{fixnum::3.14159::2}} → 3.14',
        });

        registerFunction({
            name: 'unicodeencode',
            callback: (str, matcherArg, args, vars) => {
                return args[0].charCodeAt(args[1] ? Number(args[1]) : 0).toString()
            },
            alias: ['unicode_encode'],
            description: 'Returns the Unicode code point of a character at the specified index (default 0) in the string. Returns numeric code as string.\n\nUsage:: {{unicodeencode::A}} → 65',
        });

        registerFunction({
            name: 'unicodedecode',
            callback: (str, matcherArg, args, vars) => {
                return String.fromCharCode(Number(args[0]))
            },
            alias: ['unicode_decode'],
            description: 'Converts a Unicode code point number back to its corresponding character. Inverse of unicodeencode.\n\nUsage:: {{unicodedecode::65}} → A',
        });

        registerFunction({
            name: 'u',
            callback: (str, matcherArg, args, vars) => {
                return String.fromCharCode(parseInt(args[0], 16))
            },
            alias: ['unicodedecodefromhex'],
            description: 'Converts a hexadecimal Unicode code to its corresponding character. Useful for special characters and symbols.\n\nUsage:: {{u::41}} → A',
        });

        registerFunction({
            name: 'ue',
            callback: (str, matcherArg, args, vars) => {
                return String.fromCharCode(parseInt(args[0], 16))
            },
            alias: ['unicodeencodefromhex'],
            description: 'Converts a hexadecimal Unicode code to its corresponding character. Alias for {{u}}.\n\nUsage:: {{ue::41}} → A',
        });

        registerFunction({
            name: 'hash',
            callback: (str, matcherArg, args, vars) => {
                return ((pickHashRand(0, args[0]) * 10000000) + 1).toFixed(0).padStart(7, '0')
            },
            alias: [],
            description: 'Generates a deterministic 7-digit number based on the input string hash. Same input always produces the same output. Useful for consistent randomization.\n\nUsage:: {{hash::hello}} → 1234567',
        });

        registerFunction({
            name: 'randint',
            callback: (str, matcherArg, args, vars) => {
                const min = Number(args[0])
                const max = Number(args[1])
                if(isNaN(min) || isNaN(max)){
                    return 'NaN'
                }
                return (Math.floor(_rand() * (max - min + 1)) + min).toString()
            },
            alias: [],
            description: 'Generates a random integer between min and max values (inclusive). Returns "NaN" if arguments are not valid numbers.\n\nUsage:: {{randint::1::10}} → random number 1-10',
        });

        registerFunction({
            name: 'dice',
            callback: (str, matcherArg, args, vars) => {
                const notation = args[0].split('d')
                const num = Number(notation[0])
                const sides = Number(notation[1])
                if(isNaN(num) || isNaN(sides)){
                    return 'NaN'
                }
                let total = 0
                for(let i = 0; i < num; i++){
                    total += Math.floor(_rand() * sides) + 1
                }
                return total.toString()
            },
            alias: [],
            description: 'Simulates dice rolling using standard RPG notation (XdY = X dice with Y sides each). Returns sum of all dice rolls.\n\nUsage:: {{dice::2d6}} → random number 2-12',
        });

        registerFunction({
            name: 'fromhex',
            callback: (str, matcherArg, args, vars) => {
                return Number.parseInt(args[0], 16).toString()
            },
            alias: [],
            description: 'Converts a hexadecimal string to its decimal number equivalent. Parses base-16 input to base-10 output.\n\nUsage:: {{fromhex::FF}} → 255',
        });

        registerFunction({
            name: 'tohex',
            callback: (str, matcherArg, args, vars) => {
                return Number.parseInt(args[0]).toString(16)
            },
            alias: [],
            description: 'Converts a decimal number to its hexadecimal string representation. Parses base-10 input to base-16 output.\n\nUsage:: {{tohex::255}} → ff',
        });

        registerFunction({
            name: 'metadata',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                switch(args[0].toLocaleLowerCase()){
                    case 'mobile':{
                        return isMobile ? '1' : '0'
                    }
                    case 'local':{
                        return isTauri ? '1' : '0'
                    }
                    case 'node':{
                        return isNodeServer ? '1' : '0'
                    }
                    case 'version':{
                        return appVer
                    }
                    case 'majorversion':
                    case 'majorver':
                    case 'major':{
                        return appVer.split('.')[0]
                    }
                    case 'language':
                    case 'locale':
                    case 'lang':{
                        return db.language
                    }
                    case 'browserlanguage':
                    case 'browserlocale':
                    case 'browserlang':{
                        return navigator.language
                    }
                    case 'modelshortname':{
                        const modelInfo = getModelInfo(db.aiModel)
                        return modelInfo.shortName ?? modelInfo.name ?? modelInfo.id
                    }
                    case 'modelname':{
                        const modelInfo = getModelInfo(db.aiModel)
                        return modelInfo.name ?? modelInfo.id
                    }
                    case 'modelinternalid':{
                        const modelInfo = getModelInfo(db.aiModel)
                        return modelInfo.internalID ?? modelInfo.id
                    }
                    case 'modelformat':{
                        const modelInfo = getModelInfo(db.aiModel)
                        return modelInfo.format.toString()
                    }
                    case 'modelprovider':{
                        const modelInfo = getModelInfo(db.aiModel)
                        return modelInfo.provider.toString()
                    }
                    case 'modeltokenizer':{
                        const modelInfo = getModelInfo(db.aiModel)
                        return modelInfo.tokenizer.toString()
                    }
                    case 'imateapot':{
                        return '🫖'
                    }
                    case 'risutype':{
                        return isTauri ? 'local' : isNodeServer ? 'node' : 'web'
                    }
                    case 'maxcontext':{
                        return db.maxContext.toString()
                    }
                    default:{
                        return `Error: ${args[0]} is not a valid metadata key.`
                    }
                }
            },
            alias: [],
            description: 'Returns various system and application metadata. Supported keys: mobile, local, node, version, language, modelname, etc. Returns error message for invalid keys.\n\nUsage:: {{metadata::version}}',
        });

        registerFunction({
            name: 'iserror',
            callback: (str, matcherArg, args, vars) => {
                return args[0].toLocaleLowerCase().startsWith('error:') ? '1' : '0'
            },
            alias: [],
            description: 'Checks if a string starts with "error:" (case-insensitive). Returns "1" if it\'s an error message, "0" otherwise. Useful for error handling.\n\nUsage:: {{iserror::Error: failed}} → 1',
        });

        // Encryption/decryption functions
        registerFunction({
            name: 'xor',
            callback: (str, matcherArg, args, vars) => {
                const buf = new TextEncoder().encode(args[0])
                for(let i = 0; i < buf.length; i++){
                    buf[i] ^= 0xFF
                }
                return Buffer.from(buf).toString('base64')
            },
            alias: ['xorencrypt', 'xorencode', 'xore'],
            description: 'Encrypts a string using XOR cipher with 0xFF key and encodes result as base64. Simple obfuscation method. Reversible with xordecrypt.\n\nUsage:: {{xor::hello}}',
        });

        registerFunction({
            name: 'xordecrypt',
            callback: (str, matcherArg, args, vars) => {
                const buf = Buffer.from(args[0], 'base64')
                for(let i = 0; i < buf.length; i++){
                    buf[i] ^= 0xFF
                }
                return new TextDecoder().decode(buf)
            },
            alias: ['xordecode', 'xord'],
            description: 'Decrypts a base64-encoded XOR-encrypted string back to original text. Reverses the xor function using same 0xFF key.\n\nUsage:: {{xordecrypt::base64string}}',
        });

        registerFunction({
            name: 'crypt',
            callback: (str, matcherArg, args, vars) => {
                let shift = args[1] ? Number(args[1]) : 32768
                if(isNaN(shift)){
                    shift = 32768
                }

                let result = ''
                for(let i = 0; i < args[0].length; i++){
                    const charCode = args[0].charCodeAt(i)
                    if(charCode > 65535){
                        result += args[0][i]
                        continue
                    }
                    let shiftedCode = charCode + shift
                    if(shiftedCode > 65535){
                        shiftedCode -= 65536
                    }
                    result += String.fromCharCode(shiftedCode)
                }
                return result
            },
            alias: ['crypto', 'caesar', 'encrypt', 'decrypt'],
            description: 'Applies Caesar cipher encryption/decryption with custom shift value (default 32768). Shifts Unicode character codes within 16-bit range. By using default shift, it can be used for both encryption and decryption.\n\nUsage:: {{crypt::hello}} or {{crypt::hello::1000}}',
        });

        /**
         * @param rand 0-1 random value from PRNG
         */
        const randomPickImpl = (str, matcherArg, args, rand) => {
            if (args.length === 0) {
                return rand.toString()
            }

            let arr
            if (args.length === 1) {
                if (args[0].startsWith('[') && args[0].endsWith(']')) {
                    arr = parseArray(args[0])
                } else {
                    arr = args[0].replace(/\\,/g, '§X').split(/\:|\,/g)
                }
            } else {
                arr = args
            }

            const index = matcherArg.tokenizeAccurate ? 0 : Math.floor(rand * arr.length)
            const element = arr[index]
            return typeof element === 'string' ? element.replace(/§X/g, ',') : JSON.stringify(element) ?? ''
        }

        registerFunction({
            name: 'random',
            callback: (str, matcherArg, args, vars) => {
                return randomPickImpl(str, matcherArg, args, _rand())
            },
            alias: [],
            description: 'Returns a random number between 0 and 1 if no arguments. With one argument, returns a random element from the provided array or string split by commas/colons. With multiple arguments, returns a random argument.\n\nUsage:: {{random}} or {{random::a,b,c}} → "b"',
        })

        registerFunction({
            name: 'pick',
            callback: (str, matcherArg, args, vars) => {
                const db = getDatabase()
                const selchar = db.characters[getSelectedCharID()]
                const selChat = selchar.chats[selchar.chatPage]
                const cid = selChat.message.length
                const hashRand = pickHashRand(cid, selchar.chaId + (selChat.id ?? ''))
                return randomPickImpl(str, matcherArg, args, hashRand)
            },
            alias: [],
            description: 'Returns a random number between 0 and 1 if no arguments. With one argument, returns a random element from the provided array or string split by commas/colons. With multiple arguments, returns a random argument. unlike {{random}}, uses a hash-based randomization based on chat ID and character ID for consistent results across messages.\n\nUsage:: {{pick}} or {{pick::a,b,c}} → "b"',
        })

        registerFunction({
            name: 'roll',
            callback: (str, matcherArg, args, vars) => {
                if(args.length === 0){
                    return '1'
                }
                const notation = args[0].split('d')
                let num = 1
                let sides = 6
                if(notation.length === 2){
                    num = Number(notation[0] || 1)
                    sides = Number(notation[1] || 6)
                }
                else if(notation.length === 1){
                    sides = Number(notation[0])
                }
                if(isNaN(num) || isNaN(sides) || num < 1 || sides < 1){
                    return 'NaN'
                }
                let total = 0
                for(let i = 0; i < num; i++){
                    total += Math.floor(_rand() * sides) + 1
                }
                return total.toString()
            },
            alias: [],
            description: 'Simulates rolling dice using standard RPG notation (XdY = X dice with Y sides each). Returns sum of all dice rolls. If no arguments, defaults to 1d6.\n\nUsage:: {{roll::2d6}} → random number 2-12, {{roll::20}} → random number 1-20',
        })

        registerFunction({
            name: 'rollp',
            callback: (str, matcherArg, args, vars) => {
                if(args.length === 0){
                    return '1'
                }
                const notation = args[0].split('d')
                let num = 1
                let sides = 6
                if(notation.length === 2){
                    num = Number(notation[0] || 1)
                    sides = Number(notation[1] || 6)
                }
                else if(notation.length === 1){
                    sides = Number(notation[0])
                }
                if(isNaN(num) || isNaN(sides) || num < 1 || sides < 1){
                    return 'NaN'
                }
                let total = 0
                for(let i = 0; i < num; i++){
                    const db = getDatabase()
                    const selchar = db.characters[getSelectedCharID()]
                    const selChat = selchar.chats[selchar.chatPage]
                    const cid = selChat.message.length + (i * 15)
                    const hashRand = pickHashRand(cid, selchar.chaId + (selChat.id ?? ''))
                    total += Math.floor(hashRand * sides) + 1
                }

                return total.toString()
            },
            alias: ['rollpick'],
            description: 'Simulates rolling dice using standard RPG notation (XdY = X dice with Y sides each). Returns sum of all dice rolls. If no arguments, defaults to 1d6. Unlike {{roll}}, uses a hash-based randomization based on chat ID and character ID for consistent results across messages.\n\nUsage:: {{rollp::2d6}} → random number 2-12, {{rollp::20}} → random number 1-20',
        })

        registerFunction({
            name: 'hiddenkey',
            callback: (str, matcherArg, args, vars) => {
                return ''
            },
            alias: [],
            description: 'Works as a key for activation of lores, while not being included in the model request.\n\nUsage:: {{hidden_key::some_value}}',
        })

        registerFunction({
            name: 'reverse',
            callback: (str, matcherArg, args, vars) => {
                return [...(args[0] ?? '')].reverse().join('')
            },
            alias: [],
            description: 'Reverses the input string.\n\nUsage:: {{reverse::some_value}}',
        })

        registerFunction({
            name: 'comment',
            callback: (str, matcherArg, args, vars) => {
                if(!matcherArg.displaying){
                    return ''
                }
                return `<div class="risu-comment">${args[0]}</div>`
            },
            alias: [],
            description: 'A comment CBS for commenting out code. unlike {{//}}, this one is displayed in the chat.\n\nUsage:: {{comment::this is a comment}}',
        })

        registerFunction({
            name: 'tex',
            callback: (str, matcherArg, args, vars) => {
                return `$$${args[0]}$$`
            },
            alias: ['latex', 'katex'],
            description: 'Renders LaTeX math expressions. Wraps the input in double dollar signs for display.\n\nUsage:: {{tex::E=mc^2}}',
        })

        registerFunction({
            name: 'ruby',
            callback: (str, matcherArg, args, vars) => {
                return `<ruby>${args[0]}<rp> (</rp><rt>${args[1]}</rt><rp>) </rp></ruby>`
            },
            alias: ['furigana'],
            description: 'Renders ruby text (furigana) for East Asian typography. Wraps base text and ruby text in appropriate HTML tags.\n\nUsage:: {{ruby::漢字::かんじ}}',
        })

        registerFunction({
            name: 'codeblock',
            callback: (str, matcherArg, args, vars) => {
                let code = args[args.length - 1]
                    .replace(/\"/g, '&quot;')
                    .replace(/\'/g, '&#39;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')

                if(args.length > 1){
                    return `<pre-hljs-placeholder lang="${args[0]}">`+ code +'</pre-hljs-placeholder>'
                }

                return `<pre><code>${code}</code></pre>`
            },
            alias: [],
            description: 'Formats text as a code block using HTML pre and code tags.\n\nUsage:: {{codeblock::some code here}}, or {{codeblock::language::some code here}} for syntax highlighting.',
        })


        registerFunction({
            name: 'bkspc',
            callback: (str, matcherArg, args, vars) => {
                let root = matcherArg?.getNested?.()?.[0]
                if(!root){
                    return ''
                }
                root = root.trimEnd()

                let trimPointer = root.length - 1

                for(;trimPointer >= 0;trimPointer--){
                    const char = root[trimPointer]
                    if(trimPointer === 0){
                        break
                    }
                    if(char === ' ' || char === '\n' || char === '\t'){
                        break
                    }
                }

                if(trimPointer === -1){
                    trimPointer = 0
                }

                matcherArg?.setNestedRoot(root.substring(0, trimPointer).trimEnd())
                return ''
            },
            alias: [],
            description: "Performs a backspace operation, removing the last word from the current output. Useful for correcting or modifying generated text dynamically.\n\nUsage:: hello world {{bkspc}} user → hello user",
        })

        registerFunction({
            name: 'erase',
            callback: (str, matcherArg, args, vars) => {
                let root = matcherArg?.getNested?.()?.[0]
                if(!root){
                    return ''
                }
                root = root.trimEnd()

                let trimPointer = root.length - 1
                let sentenceEndFound = false

                for(;trimPointer >= 0;trimPointer--){
                    const char = root[trimPointer]
                    if(char === '.' || char === '!' || char === '?' || char === '\n'){
                        sentenceEndFound = true
                        break
                    }
                    if(trimPointer === 0){
                        break
                    }
                }

                if(trimPointer === -1){
                    trimPointer = 0
                }
                else if(sentenceEndFound){
                    trimPointer += 1
                }
                matcherArg?.setNestedRoot(root.substring(0, trimPointer).trimEnd())
                return ''
            },
            alias: [],
            description: "performs a backspace operation, removing the last sentence from the current output. Useful for correcting or modifying generated text dynamically.\n\nUsage:: hello world. what's in {{erase}} what's up → hello world. what's up",
        })

        registerFunction({
            name: 'declare',
            callback: (str, matcherArg, args, vars) => {
                matcherArg.var[`__declared_${args[0]}__`] = '1'
                return ''
            },
            alias: [],
            description: 'Declares a data which can be used to change parser\'s behavior. Usage:: {{declare::declaration_name}}',
        })

        registerFunction({
            name: '//',
            callback: 'doc_only',
            alias: [],
            description: 'A comment CBS for commenting out code.\n\nUsage:: {{// this is a comment}}',
        })

        registerFunction({
            name: '?',
            callback: 'doc_only',
            alias: [],
            description: 'Runs math operations on numbers. Supports +, -, *, /, %, ^ (exponentiation), % (modulo), < (less than), > (greater than), <= (less than or equal), >= (greater than or equal), == (equal), != (not equal), and brackets for grouping.\n\nUsage:: {{? 1+2}} → 3, {{? (2*3)+4}} → 10',
        })

        registerFunction({
            name: '__',
            callback: (str, matcherArg, args, vars) => {
                return callInternalFunction(args)
            },
            alias: [],
            description: '**INTERNAL FUNCTION - DO NOT USE**',
            internalOnly: true,
        });

        // Asset display functions (doc_only)
        registerFunction({
            name: 'asset',
            callback: 'doc_only',
            alias: [],
            description: 'Displays additional asset A as appropriate element type.\n\nUsage:: {{asset::assetName}}',
        });

        registerFunction({
            name: 'emotion',
            callback: 'doc_only',
            alias: [],
            description: 'Displays emotion image A as image element.\n\nUsage:: {{emotion::emotionName}}',
        });

        registerFunction({
            name: 'audio',
            callback: 'doc_only',
            alias: [],
            description: 'Displays audio asset A as audio element.\n\nUsage:: {{audio::audioName}}',
        });

        registerFunction({
            name: 'bg',
            callback: 'doc_only',
            alias: [],
            description: 'Displays background image A as background image element.\n\nUsage:: {{bg::backgroundName}}',
        });

        registerFunction({
            name: 'bgm',
            callback: 'doc_only',
            alias: [],
            description: 'Inserts background music control element.\n\nUsage:: {{bgm::musicName}}',
        });

        registerFunction({
            name: 'video',
            callback: 'doc_only',
            alias: [],
            description: 'Displays video asset A as video element.\n\nUsage:: {{video::videoName}}',
        });

        registerFunction({
            name: 'video-img',
            callback: 'doc_only',
            alias: [],
            description: 'Displays video asset A as image-like element.\n\nUsage:: {{video-img::videoName}}',
        });

        registerFunction({
            name: 'image',
            callback: 'doc_only',
            alias: [],
            description: 'Displays image asset A as image element.\n\nUsage:: {{image::imageName}}',
        });

        registerFunction({
            name: 'img',
            callback: 'doc_only',
            alias: [],
            description: 'Displays A as unstyled image element.\n\nUsage:: {{img::imageName}}',
        });

        registerFunction({
            name: 'path',
            callback: 'doc_only',
            alias: ['raw'],
            description: 'Returns additional asset A\'s path data.\n\nUsage:: {{path::assetName}}',
        });

        registerFunction({
            name: 'inlay',
            callback: 'doc_only',
            alias: [],
            description: 'Displays unstyled inlay asset A, which doesn\'t inserts at model request.\n\nUsage:: {{inlay::inlayName}}',
        });

        registerFunction({
            name: 'inlayed',
            callback: 'doc_only',
            alias: [],
            description: 'Displays styled inlay asset A, which doesn\'t inserts at model request.\n\nUsage:: {{inlayed::inlayName}}',
        });

        registerFunction({
            name: 'inlayeddata',
            callback: 'doc_only',
            alias: [],
            description: 'Displays styled inlay asset A, which inserts at model request.\n\nUsage:: {{inlayeddata::inlayName}}',
        });

        registerFunction({
            name: 'source',
            callback: 'doc_only',
            alias: [],
            description: 'Returns the source URL of user or character\'s profile. argument must be "user" or "char".\n\nUsage:: {{source::user}} or {{source::char}}',
        });

        registerFunction({
            name:"#if",
            callback: 'doc_only',
            alias: [],
            description: 'Conditional statement for CBS. 1 and "true" are truty, and otherwise false.\n\nUsage:: {{#if condition}}...{{/if}}.',
            deprecated: {
                message: 'Due to limitations of adding operators, #if is deprecated and replaced with #when. Use #when instead.',
                replacement: '#when',
            }
        })

        registerFunction({
            name:'#if_pure',
            callback: 'doc_only',
            alias: [],
            description: 'Conditional statement for CBS, which has keep whitespace handling. 1 and "true" are truty, and otherwise false.\n\nUsage:: {{#if_pure condition}}...{{/if_pure}}',
            deprecated: {
                message: 'Due to limitations of adding operators, #if_pure is deprecated and replaced with #when with keep operator. Use #when::keep::condition instead.',
                replacement: '#when',
            }
        })

        registerFunction({
            name:'#when',
            callback: 'doc_only',
            alias: [],
            description: `Conditional statement for CBS. 1 and "true" are truty, and otherwise false.

    It can add operators to condition:

    Basic operators:
    {{#when::A::and::B}}...{{/when}} - checks if both conditions are true.
    {{#when::A::or::B}}...{{/when}} - checks if at least one condition is true.
    {{#when::A::is::B}}...{{/when}} - checks if A is equal to B.
    {{#when::A::isnot::B}}...{{/when}} - checks if A is not equal to B.
    {{#when::A::>::B}}...{{/when}} - checks if A is greater than B.
    {{#when::A::<::B}}...{{/when}} - checks if A is less than B.
    {{#when::A::>=::B}}...{{/when}} - checks if A is greater than or equal to B.
    {{#when::A::<=::B}}...{{/when}} - checks if A is less than or equal to B.
    {{#when::not::A}}...{{/when}} - negates condition, so it will be true if A is false.

    Advanced operators:
    {{#when::keep::A}}...{{/when}} - keeps whitespace inside the block without trimming.
    {{#when::legacy::A}}...{{/when}} - legacy whitespace handling, so it will handle like deprecated #if.
    {{#when::var::A}}...{{/when}} - checks if variable A is truthy.
    {{#when::A::vis::B}}...{{/when}} - checks if variable A is equal to literal B.
    {{#when::A::visnot::B}}...{{/when}} - checks if variable A is not equal to literal B.
    {{#when::toggle::togglename}}...{{/when}} - checks if toggle is enabled.
    {{#when::A::tis::B}}...{{/when}} - checks if toggle A is equal to literal B.
    {{#when::A::tisnot::B}}...{{/when}} - checks if toggle A is not equal to literal B.

    operators can be combined like:
    {{#when::keep::not::condition}}...{{/when}}
    {{#when::keep::condition1::and::condition2}}...{{/when}}

    You can use whitespace instead of "::" if there is no operators, like:
    {{#when condition}}...{{/when}}

    Usage:: {{#when condition}}...{{/when}} or {{#when::not::condition}}...{{/when}}
    `,
        })

        registerFunction({
            name:':else',
            callback: 'doc_only',
            alias: [],
            description: 'Else statement for CBS. Must be used inside {{#when}}. if {{#when}} is multiline, :else must be on line without additional string. if {{#when}} is used with operator \'legacy\', it will not work.\n\nUsage:: {{#when condition}}...{{:else}}...{{/when}} or {{#when::not::condition}}...{{:else}}...{{/when}}',
        })

        registerFunction({
            name:'#pure',
            callback: 'doc_only',
            alias: [],
            description: 'displays content without any CBS processing. Useful for displaying raw HTML or other content without parsing.\n\nUsage:: {{#puredisplay}}...{{/puredisplay}}',
            deprecated: {
                message: 'Due to reparsing issue, #pure is deprecated and replaced with #puredisplay. Use #puredisplay instead.',
                replacement: '#puredisplay',
            }
        })
        registerFunction({
            name:'#puredisplay',
            callback: 'doc_only',
            alias: [],
            description: 'displays content without any CBS processing. Useful for displaying raw HTML or other content without parsing.\n\nUsage:: {{#puredisplay}}...{{/puredisplay}}',
        })

        registerFunction({
            name: '#escape',
            callback: 'doc_only',
            alias: [],
            description: `Escapes curly braces and parentheses, treating content as literal text. Useful for displaying CBS syntax without evaluation.

    Operators:
    {{#escape::keep}} - keeps whitespace inside the block without trimming.

    Usage:: {{#escape}}...{{/escape}}`,
        })

        registerFunction({
            name:'#each',
            callback: 'doc_only',
            alias: [':each'],
            description: `Iterates over an array.

    Operators:
    {{#each::keep A as V}} - keeps whitespace inside the block without trimming.

    Usage:: {{#each A as V}} ... {{slot::V}} ... {{/each}}`,
        })

        registerFunction({
            name: 'slot',
            callback: 'doc_only',
            alias: [],
            description: 'Used in various CBS functions to access specific slots or properties.\n\nUsage:: {{slot::propertyName}} or {{slot}}, depending on context.',
        })

        registerFunction({
            name: 'position',
            callback: 'doc_only',
            alias: [],
            description: 'Defines the position which can be used in various features such as @@position <positionName> decorator.\n\nUsage:: {{position::positionName}}',
        })
    }

    // ── src/ts/parser/parser.svelte.ts ───────────────────────────────────
    const replacements = [
        '{', //0xE9B8
        '}', //0xE9B9
        '(', //0xE9BA
        ')', //0xE9BB
        '&lt;', //0xE9BC
        '&gt;', //0xE9BD
        ':', //0xE9BE
        ';', //0xE9BF
    ]

    function risuUnescape(text){
        return text.replace(/[\uE9b8-\uE9bf]/g, (f) => {
            const index = f.charCodeAt(0) - 0xE9B8
            return replacements[index]
        })
    }

    function risuEscape(text){
        return text.replace(/[{}()]/g, (f) => {
            switch(f){
                case '{': return '\uE9B8'
                case '}': return '\uE9B9'
                case '(': return '\uE9BA'
                case ')': return '\uE9BB'
                default: return f
            }
        })
    }

    function matcher (p1,matcherArg,vars = null )

     {

        initMatcher()

        try {
            if(p1.startsWith('? ')){
                const substring = p1.substring(2)
                return calcString(substring).toString()
            }
            const colonIndex = p1.indexOf(':')
            let splited
            if(colonIndex !== -1 && p1[colonIndex + 1] === ':'){
                splited = p1.split('::')
            }
            else{
                splited = p1.split(':')
            }
            const name = splited[0].toLocaleLowerCase().replace(/[\s_-]/g, '')
            const args = splited.slice(1)
            const callback = matcherMap.get(name)
            if(callback){
                return callback(p1, matcherArg, args,vars)
            }
        } catch (error) {}

        return null
    }

    const dateTimeFormat = (main, time = 0) => {
        const date = time === 0 ? (new Date()) : (new Date(time))
        if(!main){
            return ''
        }
        if(main.startsWith(':')){
            main = main.substring(1)
        }
        if(main.length > 300){
            return ''
        }
        return main
            .replace(/YYYY/g, date.getFullYear().toString())
            .replace(/YY/g, date.getFullYear().toString().substring(2))
            .replace(/MMMM/g, Intl.DateTimeFormat('en', { month: 'long' }).format(date))
            .replace(/MMM/g, Intl.DateTimeFormat('en', { month: 'short' }).format(date))
            .replace(/MM/g, (date.getMonth() + 1).toString().padStart(2, '0'))
            .replace(/DDDD/g, Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24)).toString())
            .replace(/DD/g, date.getDate().toString().padStart(2, '0'))
            .replace(/dddd/g, Intl.DateTimeFormat('en', { weekday: 'long' }).format(date))
            .replace(/ddd/g, Intl.DateTimeFormat('en', { weekday: 'short' }).format(date))
            .replace(/HH/g, date.getHours().toString().padStart(2, '0'))
            .replace(/hh/g, (date.getHours() % 12 || 12).toString().padStart(2, '0'))
            .replace(/mm/g, date.getMinutes().toString().padStart(2, '0'))
            .replace(/ss/g, date.getSeconds().toString().padStart(2, '0'))
            .replace(/X/g, Math.floor(date.getTime() / 1000).toString())
            .replace(/x/g, date.getTime().toString())
            .replace(/A/g, date.getHours() >= 12 ? 'PM' : 'AM')

    }

    const legacyBlockMatcher = (p1,matcherArg) => {
        const bn = p1.indexOf('\n')

        if(bn === -1){
            return null
        }

        const logic = p1.substring(0, bn)
        const content = p1.substring(bn + 1)
        const statement = logic.split(" ", 2)

        switch(statement[0]){
            case 'if':{
                if(["","0","-1"].includes(statement[1])){
                    return ''
                }

                return content.trim()
            }
        }

        return null
    }

    function parseArray(p1){
        try {
            const arr = JSON.parse(p1)
            if(Array.isArray(arr)){
                return arr
            }
            return p1.split('§')
        } catch (error) {
            return p1.split('§')
        }
    }

    function parseDict(p1 ){
        try {
            return JSON.parse(p1)
        } catch (error) {
            return {}
        }
    }

    function makeArray(p1){
        return JSON.stringify(p1.map((f) => {
            if(typeof(f) === 'string'){
                return f.replace(/::/g, '\\u003A\\u003A')
            }
            return f
        }))
    }

    function blockStartMatcher(p1,matcherArg){
        if(p1.startsWith('#if') || p1.startsWith('#if_pure ')){
            const statement = p1.split(' ', 2)
            const state = statement[1]
            if(state === 'true' || state === '1'){
                return {
                    type:   p1.startsWith('#if_pure') ? 'ifpure' :
                            'parse'
                }
            }
            return {type:'ignore'}
        }

        if(p1.startsWith('#when')){
            if(p1.startsWith('#when ')){
                const statement = p1.split(' ', 2)
                const state = statement[1]
                return {type: (state === 'true' || state === '1') ? 'newif' : 'newif-falsy'}
            }
            else if(p1.startsWith('#when::')){
                const statement = p1.split('::').slice(1)
                if(statement.length === 1){
                    const state = statement[0]
                    return {type: (state === 'true' || state === '1') ? 'newif' : 'newif-falsy'}
                }
                let mode = 'normal'

                const isTruthy = (s) => {
                    return s === 'true' || s === '1'
                }
                while(statement.length > 1){
                    const condition = statement.pop()
                    const operator = statement.pop()
                    switch(operator){
                        case 'not':{
                            if(isTruthy(condition)){
                                statement.push('0')
                            }
                            else{
                                statement.push('1')
                            }
                            break
                        }
                        case 'keep':{
                            mode = 'keep'
                            statement.push(condition)
                            break
                        }
                        case 'legacy':{
                            mode = 'legacy'
                            statement.push(condition)
                            break
                        }
                        case 'and':{
                            const condition2 = statement.pop()
                            if(isTruthy(condition) && isTruthy(condition2)){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case 'or':{
                            const condition2 = statement.pop()
                            if(isTruthy(condition) || isTruthy(condition2)){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case 'is':{
                            const condition2 = statement.pop()
                            if(condition === condition2){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case 'isnot':{
                            const condition2 = statement.pop()
                            if(condition !== condition2){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case 'var':{
                            const variable = getChatVar(condition)
                            if(isTruthy(variable)){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case 'toggle':{
                            const variable = getGlobalChatVar('toggle_' + condition)
                            if(isTruthy(variable)){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case 'vis':{ //vis = variable is
                            const variable = getChatVar(statement.pop())
                            if(variable === condition){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case 'visnot':{ //visnot = variable is not
                            const variable = getChatVar(statement.pop())
                            if(variable !== condition){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case 'tis':{ //tis = toggle is
                            const variable = getGlobalChatVar('toggle_' + statement.pop())
                            if(variable === condition){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case 'tisnot':{ //tisnot = toggle is not
                            const variable = getGlobalChatVar('toggle_' + statement.pop())
                            if(variable !== condition){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case '>':{
                            const condition2 = statement.pop()
                            if(parseFloat(condition2) > parseFloat(condition)){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case '<':{
                            const condition2 = statement.pop()
                            if(parseFloat(condition2) < parseFloat(condition)){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case '>=':{
                            const condition2 = statement.pop()
                            if(parseFloat(condition2) >= parseFloat(condition)){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case '<=':{
                            const condition2 = statement.pop()
                            if(parseFloat(condition2) <= parseFloat(condition)){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        default:{
                            if(isTruthy(condition)){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                    }
                }

                const finalCondition = statement[0]
                if(isTruthy(finalCondition)){
                    switch(mode){
                        case 'keep':{
                            return {type: 'newif', type2: 'keep'}
                        }
                        case 'legacy':{
                            return {type: 'parse'}
                        }
                        default:{
                            return {type: 'newif'}
                        }
                    }
                }
                else{
                    switch(mode){
                        case 'keep':{
                            return {type: 'newif-falsy', type2: 'keep'}
                        }
                        case 'legacy':{
                            return {type: 'ignore'}
                        }
                        default:{
                            return {type: 'newif-falsy'}
                        }
                    }
                }
            }
            else{
                return {type: 'newif-falsy'}
            }
        }
        if(p1 === '#pure'){
            return {type:'pure'}
        }
        if(p1 === '#pure_display' || p1 === '#puredisplay'){
            return {type:'pure-display'}
        }
        if(p1 === '#code'){
            return {type:'normalize'}
        }
        if(p1.startsWith('#escape')){
            const t2 = p1.substring(7).trim()
            const mode = t2 === '::keep' ? 'keep' : undefined
            return {type:'escape', mode}
        }
        if(p1.startsWith('#each')){
            let t2 = p1.substring(5).trim()
            let mode
            if(t2.startsWith('::keep ')){
                mode = 'keep'
                t2 = t2.substring(7).trim()
            }
            if(t2.startsWith('as ')){
                t2 = t2.substring(3).trim()
            }
            return {type:'each', type2:t2, mode}
        }
        if(p1.startsWith('#func')){
            const statement = p1.split(' ')
            if(statement.length > 1){
                return {type:'function',funcArg:statement.slice(1)}
            }

        }

        return {type:'nothing'}
    }

    function trimLines(p1){
        return p1.split('\n').map((v) => {
            return v.trimStart()
        }).join('\n').trim()
    }

    function blockEndMatcher(p1,type,matcherArg){
        const p1Trimmed = p1.trim()
        switch(type.type){
            case 'pure':
            case 'pure-display':
            case 'function':{
                return p1Trimmed
            }
            case 'parse':{
                return trimLines(p1Trimmed)
            }
            case 'each':{
                if(type.mode === 'keep'){
                    return p1
                }
                return trimLines(p1Trimmed)
            }
            case 'ifpure':{
                return p1
            }
            case 'newif':
            case 'newif-falsy':{
                const lines =  p1.split("\n")

                if(lines.length === 1){
                    const elseIndex = p1.indexOf('{{:else}}')
                    if(elseIndex !== -1){
                        if(type.type === 'newif'){
                            return p1.substring(0, elseIndex)
                        }
                        if(type.type === 'newif-falsy'){
                            return p1.substring(elseIndex + 9)
                        }
                    }
                    else{
                        if(type.type === 'newif'){
                            return p1
                        }
                        if(type.type === 'newif-falsy'){
                            return ''
                        }
                    }
                }

                const elseLine = lines.findIndex((v) => {
                    return v.trim() === '{{:else}}'
                })

                if(elseLine !== -1 && type.type === 'newif'){
                    lines.splice(elseLine) //else line and everything after it is removed
                }
                if(elseLine !== -1 && type.type === 'newif-falsy'){
                    lines.splice(0, elseLine + 1) //everything before else line is removed
                }
                if(elseLine === -1 && type.type === 'newif-falsy'){
                    return ''
                }

                if(type.type2 !== 'keep'){
                    while(lines.length > 0 && lines[0].trim() === ''){
                        lines.shift()
                    }
                    while(lines.length > 0 && lines[lines.length - 1].trim() === ''){
                        lines.pop()
                    }
                }
                return lines.join('\n')
            }

            case 'normalize':{
                return p1Trimmed.trim().replaceAll('\n','').replaceAll('\t','')
                .replaceAll(/\\u([0-9A-Fa-f]{4})/g, (match, p1) => {
                    return String.fromCharCode(parseInt(p1, 16))
                })
                .replaceAll(/\\(.)/g, (match, p1) => {
                    switch(p1){
                        case 'n':
                            return '\n'
                        case 'r':
                            return '\r'
                        case 't':
                            return '\t'
                        case 'b':
                            return '\b'
                        case 'f':
                            return '\f'
                        case 'v':
                            return '\v'
                        case 'a':
                            return '\a'
                        case 'x':
                            return '\x00'
                        default:
                            return p1
                    }
                })
            }
            case 'escape':{
                return risuEscape(type.mode === 'keep' ? p1 : p1Trimmed)
            }
            default:{
                return ''
            }
        }
    }

    function risuChatParser(da, arg = {}){
        const chatID = arg.chatID ?? -1
        const db = arg.db ?? CUR.db
        const aChara = arg.chara
        let chara = null

        if(aChara){
            chara = aChara
        }
        if(arg.tokenizeAccurate){
            const selchar = chara ?? db.characters[0]
            if(!selchar){
                chara = 'bot'
            }
        }

        let pointer = 0;
        let nested = [""]
        let stackType = new Uint8Array(512)
        let pureModeNest = new Map()
        let pureModeNestType = new Map()
        let blockNestType = new Map()
        let commentMode = false
        let commentLatest = [""]
        let commentV = new Uint8Array(512)
        let thinkingMode = false
        let tempVar = {}
        let functions = arg.functions ?? (new Map())

        arg.callStack = (arg.callStack ?? 0) + 1

        if(arg.callStack > 20){
            return 'ERROR: Call stack limit reached'
        }

        const matcherObj = {
            chatID: chatID,
            chara: chara,
            rmVar: arg.rmVar ?? false,
            db: db,
            var: arg.var ?? null,
            tokenizeAccurate: arg.tokenizeAccurate ?? false,
            displaying: arg.visualize ?? false,
            role: arg.role,
            runVar: arg.runVar ?? false,
            consistantChar: arg.consistantChar ?? false,
            cbsConditions: arg.cbsConditions ?? {},
            callStack: arg.callStack,
            getNested: () => {
                return nested
            },
            setNestedRoot: (val) => {
                nested[0] = val
            }
        }

        da = da.replace(/\<(user|char|bot)\>/gi, '{{$1}}')

        const isPureMode = () => {
            return pureModeNest.size > 0
        }

        while(pointer < da.length){
            switch(da[pointer]){
                case '{':{
                    if(da[pointer + 1] !== '{' && da[pointer + 1] !== '#'){
                        nested[0] += da[pointer]
                        break
                    }
                    pointer++
                    nested.unshift('')
                    stackType[nested.length] = 1
                    break
                }
                case '#':{
                    //legacy if statement, deprecated
                    if(da[pointer + 1] !== '}' || nested.length === 1 || stackType[nested.length] !== 1){
                        nested[0] += da[pointer]
                        break
                    }
                    pointer++
                    const dat = nested.shift()
                    const mc = legacyBlockMatcher(dat, matcherObj)
                    nested[0] += mc ?? `{#${dat}#}`
                    break
                }
                case '}':{
                    if(da[pointer + 1] !== '}' || nested.length === 1 || stackType[nested.length] !== 1){
                        nested[0] += da[pointer]
                        break
                    }
                    pointer++
                    const dat = nested.shift()
                    if(dat.startsWith('#') || dat.startsWith(':')){
                        if(isPureMode()){
                            nested[0] += `{{${dat}}}`
                            if (dat !== ':else') {
                                nested.unshift('')
                                stackType[nested.length] = 6
                            }
                            break
                        }
                        const matchResult = blockStartMatcher(dat, matcherObj)
                        if(matchResult.type === 'nothing'){
                            nested[0] += `{{${dat}}}`
                            break
                        }
                        else{
                            nested.unshift('')
                            stackType[nested.length] = 5
                            blockNestType.set(nested.length, matchResult)
                            if( matchResult.type === 'ignore' || matchResult.type === 'pure' ||
                                matchResult.type === 'each' || matchResult.type === 'function' ||
                                matchResult.type === 'pure-display' || matchResult.type === 'escape'
                            ){
                                pureModeNest.set(nested.length, true)
                                pureModeNestType.set(nested.length, "block")
                            }
                            break
                        }
                    }
                    if(dat.startsWith('/') && !dat.startsWith('//')){
                        if(stackType[nested.length] === 5){
                            const blockType = blockNestType.get(nested.length)
                            if( blockType.type === 'ignore' || blockType.type === 'pure' ||
                                blockType.type === 'each' || blockType.type === 'function' ||
                                blockType.type === 'pure-display' || blockType.type === 'escape'
                            ){
                                pureModeNest.delete(nested.length)
                                pureModeNestType.delete(nested.length)
                            }
                            blockNestType.delete(nested.length)
                            const dat2 = nested.shift()
                            const matchResult = blockEndMatcher(dat2, blockType, matcherObj)
                            if(blockType.type === 'each'){
                                const asIndex = blockType.type2.lastIndexOf(' as ')
                                let sub = blockType.type2.substring(asIndex + 4).trim()
                                let array = parseArray(blockType.type2.substring(0, asIndex))
                                if(asIndex === -1){
                                    //compability mode
                                    const subind = blockType.type2.lastIndexOf(' ')
                                    if(subind === -1){
                                        break
                                    }
                                    sub = blockType.type2.substring(subind + 1)
                                    array = parseArray(blockType.type2.substring(0, subind))
                                }
                                let added = ''
                                for(let i = 0; i < array.length; i++) {
                                    added += matchResult.replaceAll(`{{slot::${sub}}}`, typeof(array[i]) === 'string' ? array[i]  : JSON.stringify(array[i]))
                                }
                                da = da.substring(0, pointer + 1) + (blockType.mode === 'keep' ? added : added.trim()) + da.substring(pointer + 1)
                                break
                            }
                            if(blockType.type === 'function'){
                                functions.set(blockType.funcArg[0], {
                                    data: matchResult,
                                    arg: blockType.funcArg.slice(1)
                                })
                                break
                            }
                            if(blockType.type === 'pure-display'){
                                nested[0] += matchResult.replaceAll('{{', '\\{\\{').replaceAll('}}', '\\}\\}')
                                break
                            }
                            if(matchResult === ''){
                                break
                            }
                            nested[0] += matchResult
                            break
                        }
                        if(stackType[nested.length] === 6){
                            const sft = nested.shift()
                            nested[0] += sft + `{{${dat}}}`
                            break
                        }
                    }
                    if(dat.startsWith('call::')){
                        if(arg.callStack && arg.callStack > 20){
                            nested[0] += `ERROR: Call stack limit reached`
                            break
                        }
                        const argData = dat.split('::').slice(1)
                        const funcName = argData[0]
                        const func = functions.get(funcName)
                        if(func){
                            let data = func.data
                            for(let i = 0;i < argData.length;i++){
                                data = data.replaceAll(`{{arg::${i}}}`, argData[i])
                            }
                            arg.functions = functions
                            nested[0] += risuChatParser(data, arg)
                            break
                        }
                    }
                    const mc = isPureMode() ? null :matcher(dat, matcherObj, tempVar)
                    if(!mc && mc !== ''){
                        nested[0] += `{{${dat}}}`
                    }
                    else if(typeof(mc) === 'string'){
                        nested[0] += mc
                    }
                    else{
                        nested[0] += mc.text
                        tempVar = mc.var
                        if(tempVar['__force_return__']){
                            return tempVar['__return__'] ?? 'null'
                        }
                    }
                    break
                }
                default:{
                    nested[0] += da[pointer]
                    break
                }
            }
            pointer++
        }
        if(commentMode){
            nested = commentLatest
            stackType = commentV
            if(thinkingMode){
                nested[0] += `<div>Thinking...</div>`
            }
            commentMode = false
        }
        if(nested.length === 1){
            return nested[0]
        }
        let result = ''
        while(nested.length > 1){
            let dat = (stackType[nested.length] === 1) ? '{{' : "<"
            dat += nested.shift()
            result = dat + result
        }
        return nested[0] + result
    }

    // ── src/ts/parser/parser.svelte.ts: initMatcher (adapted) ────────────
    let matcherInitialized = false;
    const matcherMap = new Map();
    function initMatcher() {
        if (matcherInitialized) return;
        registerCBS({
            registerFunction: function (arg) {
                const callback = arg.callback;
                if (callback === 'doc_only') {
                    return;
                }
                const names = [arg.name, ...arg.alias];
                for (const name of names) {
                    matcherMap.set(name, callback);
                }
            },
            getDatabase: () => CUR.db,
            getUserName: () => CUR.user.name,
            getPersonaPrompt: () => CUR.user.persona,
            risuChatParser: risuChatParser,
            makeArray: makeArray,
            safeStructuredClone: safeStructuredClone,
            parseArray: parseArray,
            parseDict: parseDict,
            getChatVar: getChatVar,
            setChatVar: setChatVar,
            getGlobalChatVar: getGlobalChatVar,
            calcString: calcString,
            dateTimeFormat: dateTimeFormat,
            getModules: () => (CUR && CUR.modules) || [],
            getModuleLorebooks: () => [],
            pickHashRand: pickHashRand,
            getSelectedCharID: () => 0,
            getModelInfo: (m) => ({ id: m, name: m, shortName: m, internalID: m, format: 0, provider: 0, tokenizer: 0 }),
            callInternalFunction: function (args) {
                return '';
            },
            isTauri: !!ENV.local,
            isNodeServer: false,
            isMobile: !!ENV.mobile,
            appVer: ENV.appVer || '2026.8.250',
        });
        matcherInitialized = true;
    }


    // ── src/ts/process/scripts.ts: processScriptFull, the regex part ─────
    // hooks.skip: indexes of scripts left out of this run (one that hung);
    // hooks.onScript(i): called before each script of this mode runs.
    const dreg = /{{data}}/g
    function processScriptFull(data, mode, chatID = -1, cbsConditions = {}, hooks = {}){
        const db = CUR.db
        const char = CUR.char
        let emoChanged = false
        data = risuChatParser(data, { chatID: chatID, cbsConditions })
        const scripts = (char.customscript || []).concat(CUR.moduleScripts || [])
        if(scripts.length === 0){
            return {data, emoChanged}
        }
    function executeScript(pscript){
        const script = pscript.script

        if(script.in === ''){
            return
        }

        if(script.type === mode){

            let outScript2 = script.out.replaceAll("$n", "\n")
            let outScript = outScript2.replace(dreg, "$&")
            let flag = 'g'
            if(script.ableFlag){
                flag = script.flag || 'g'
            }
            if(outScript.startsWith('@@move_top') || outScript.startsWith('@@move_bottom') || pscript.actions.includes('move_top') || pscript.actions.includes('move_bottom')){
                flag = flag.replace('g', '') //temperary fix
            }
            if(outScript.endsWith('>') && !pscript.actions.includes('no_end_nl')){
                outScript += '\n'
            }
            //remove unsupported flag
            flag = flag.trim().replace(/[^dgimsuvy]/g, '')

            //remove repeated flags
            flag = flag.split('').filter((v, i, a) => a.indexOf(v) === i).join('')

            if(flag.length === 0){
                flag = 'u'
            }

            let input = script.in
            if(pscript.actions.includes('cbs')){
                input = risuChatParser(input, { chatID: chatID, cbsConditions })
            }

            const reg = new RegExp(input, flag)
            if(outScript.startsWith('@@') || pscript.actions.length > 0){
                if(reg.test(data)){
                    if(outScript.startsWith('@@emo ')){
                        const emoName = script.out.substring(6).trim()
                        let charemotions = {}
                        let tempEmotion = charemotions[char.chaId]
                        if(!tempEmotion){
                            tempEmotion = []
                        }
                        if(tempEmotion.length > 4){
                            tempEmotion.splice(0, 1)
                        }
                        if(char.type !== 'simple'){
                            for(const emo of char.emotionImages){
                                if(emo[0] === emoName){
                                    const emos = [emo[0], emo[1], Date.now()]
                                    tempEmotion.push(emos)
                                    charemotions[char.chaId] = tempEmotion
                                    void 0
                                    emoChanged = true
                                    break
                                }
                            }
                        }
                    }
                    else if((outScript.startsWith('@@inject') || pscript.actions.includes('inject')) && chatID !== -1){
                        // DumDum: the screen never writes to the chat (later phases).
                        data = data.replace(reg, "")
                    }
                    else if(
                        outScript.startsWith('@@move_top') || outScript.startsWith('@@move_bottom') ||
                        pscript.actions.includes('move_top') || pscript.actions.includes('move_bottom')
                    ){
                        const isGlobal = flag.includes('g')
                        const matchAll = isGlobal ? data.matchAll(reg) : [data.match(reg)]
                        data = data.replace(reg, "")
                        for(const matched of matchAll){
                            if(matched){
                                const inData = matched[0]
                                let out = outScript.replace('@@move_top ', '').replace('@@move_bottom ', '')
                                    .replace(/(?<!\$)\$[0-9]+/g, (v)=>{
                                        const index = parseInt(v.substring(1))
                                        if(index < matched.length){
                                            return matched[index]
                                        }
                                        return v
                                    })
                                    .replace(/\$\&/g, inData)
                                    .replace(/(?<!\$)\$<([^>]+)>/g, (v) => {
                                        const groupName = parseInt(v.substring(2, v.length - 1))
                                        if(matched.groups && matched.groups[groupName]){
                                            return matched.groups[groupName]
                                        }
                                        return v
                                    })
                                if(outScript.startsWith('@@move_top') || pscript.actions.includes('move_top')){
                                    data = out + '\n' +data
                                }
                                else{
                                    data = data + '\n' + out
                                }
                            }
                        }
                    }
                    else{
                        data = risuChatParser(data.replace(reg, outScript), { chatID: chatID, cbsConditions })
                    }
                }
                else{
                    if((outScript.startsWith('@@repeat_back') || pscript.actions.includes('repeat_back'))  && chatID !== -1){
                        const v = outScript.split(' ', 2)[1]
                        const selchar = db.characters[0]
                        const chat = selchar.chats[selchar.chatPage]
                        let lastChat = chat.fmIndex === -1 ? selchar.firstMessage : selchar.alternateGreetings[chat.fmIndex]
                        let pointer = chatID - 1
                        while(pointer >= 0){
                            if(chat.message[pointer].role === chat.message[chatID].role){
                                lastChat = chat.message[pointer].data
                                break
                            }
                            pointer--
                        }

                        const r = lastChat.match(reg)
                        if(!v){
                            data = data + r[0]
                        }
                        else if(r[0]){
                            switch(v){
                                case 'end':
                                    data = data + r[0]
                                    break
                                case 'start':
                                    data = r[0] + data
                                    break
                                case 'end_nl':
                                    data = data + "\n" + r[0]
                                    break
                                case 'start_nl':
                                    data = r[0] + "\n" + data
                                    break
                            }

                        }
                    }
                }
            }
            else{
                data = risuChatParser(data.replace(reg, outScript), { chatID: chatID, cbsConditions })
            }
        }
    }

    let parsedScripts = []
    let orderChanged = false
    for (const script of scripts){
        if(script.ableFlag && script.flag?.includes('<')){
            const rregex = /<(.+?)>/g
            const scriptData = safeStructuredClone(script)
            let order = 0
            const actions = []
            scriptData.flag = scriptData.flag?.replace(rregex, (v, p1) => {
                const meta = p1.split(',').map((v) => v.trim())
                for(const m of meta){
                    if(m.startsWith('order ')){
                        order = parseInt(m.substring(6))
                        orderChanged = true
                    }
                    else{
                        actions.push(m)
                    }
                }

                return ''
            })
            parsedScripts.push({
                script: scriptData,
                order,
                actions
            })
            continue
        }
        parsedScripts.push({
            script,
            order: 0,
            actions: []
        })
    }

    if(orderChanged){
        parsedScripts.sort((a, b) => b.order - a.order) //sort by order
    }
        for (let i = 0; i < parsedScripts.length; i++){
            const script = parsedScripts[i]
            if(script.script.type !== mode || !script.script.in) continue
            if(hooks.skip && hooks.skip.has(i)) continue
            if(hooks.onScript) hooks.onScript(i)
            try {
                executeScript(script)
            } catch (error) {}
        }
        return {data, emoChanged}
    }


    // ── src/ts/process/triggers.ts: what runTrigger reaches (DumDum side) ──
    // Triggers run on the page (alerts wait for the user), in an engine of
    // their own, one at a time. HOST is set by the page (triggers.js): alerts,
    // the "not supported here" note, the redraw request.
    let HOST = {};
    let CURCHAT = null;                 // RisuAI's "current chat" while a trigger runs
    const unsupported = (what) => { if (HOST.warn) HOST.warn(what); };
    const selectedCharID = { get: () => 0 };
    const ReloadGUIPointer = { n: 0, get() { return this.n; }, set(v) { this.n = v; if (HOST.reload) HOST.reload(); } };
    const ReloadChatPointer = { v: {}, update(f) { this.v = f(this.v) || {}; if (HOST.reload) HOST.reload(); } };
    const DBState = { get db() { return CUR.db; } };
    const getDatabase = () => CUR.db;
    const setDatabase = () => unsupported('database');
    const getCurrentCharacter = () => CUR.char;
    // Writes to the character (lorebook, description, notes) are not kept yet.
    const setCurrentCharacter = () => unsupported('character');
    // Inside a trigger run, the chat the trigger works on; outside (a Lua edit
    // hook, a Lua button), the context's own chat.
    const getCurrentChat = () => CURCHAT || (CUR && CUR.chat);
    const getModuleTriggers = () => [];          // the module's are already in triggerscript (store.js)
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const tokenize = async (s) => Math.ceil(String(s || '').length / 4);
    const parseChatML = () => null;
    const alertNormal = (t) => { if (HOST.alert) HOST.alert(String(t), 'info'); };
    const alertError = (t) => { if (HOST.alert) HOST.alert(String(t), 'error'); };
    const alertInput = async (t) => HOST.input ? String((await HOST.input(String(t))) ?? '') : '';
    const alertSelect = async (opts, display) => HOST.select ? String((await HOST.select(opts, display)) ?? '') : '';
    const processMultiCommand = async () => unsupported('command');
    // Low level access: the model goes through the page (dd.llm); image
    // generation and similarity search are not available here.
    const requestChatData = async (arg) => {
        if (!HOST.llm) { unsupported('llm'); return { type: 'fail', result: 'not available' }; }
        try { return { type: 'success', result: String(await HOST.llm((arg && arg.formated) || [])) }; }
        catch (e) { return { type: 'fail', result: String((e && e.message) || e) }; }
    };
    const generateAIImage = async () => { unsupported('image'); return null; };
    const writeInlayImage = async () => '';
    const getInlayAsset = async () => null;
    class HypaProcesser { async addText() {} async similaritySearch() { unsupported('similarity'); return []; } }

    // ── src/ts/process/scriptings.ts: what the Lua side reaches ──────────
    // Lua runs on wasmoon (RisuAI's engine): HOST.luaFactory() gives a
    // LuaFactory with RisuAI's json.lua mounted.
    const confirmShim = async (t) => HOST.confirm ? !!(await HOST.confirm(String(t))) : false;
    const alertConfirm = confirmShim;
    // Lua's request() reaches any https host in RisuAI; here the network is
    // limited to the extension's hosts, so it answers as refused.
    const fetchNative = async () => ({ status: 403, text: async () => 'request() is not available in DumDum' });
    const readImage = async () => null;
    const asBuffer = (x) => x;
    const getUserIcon = () => '';
    const getUserName = () => (CUR && CUR.user.name) || 'User';
    const getPersonaPrompt = () => (CUR && CUR.user.persona) || '';
    const getModuleLorebooks = () => [];
    const loadLoreBookV3Prompt = async () => ({ actives: [] });
    const v4 = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
    async function hasher(data) {
        const d = await crypto.subtle.digest('SHA-256', data);
        return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    class Mutex {
        constructor() { this.p = Promise.resolve(); }
        runExclusive(fn) { const r = this.p.then(() => fn()); this.p = r.catch(() => {}); return r; }
    }
    class PyodideContext { constructor() { throw new Error('Python triggers are not supported'); } }


    // ── src/ts/process/triggers.ts: runTrigger ───────────────────────────
    const safeSubset = [
        'v2SetVar',
        'v2If',
        'v2IfAdvanced',
        'v2Else',
        'v2EndIndent',
        'v2LoopNTimes',
        'v2BreakLoop',
        'v2ConsoleLog',
        'v2StopTrigger',
        'v2Random',
        'v2ExtractRegex',
        'v2RegexTest',
        'v2GetCharAt',
        'v2GetCharCount',
        'v2ToLowerCase',
        'v2ToUpperCase',
        'v2SetCharAt',
        'v2SplitString',
        'v2JoinArrayVar',
        'v2ConcatString',
        'v2MakeArrayVar',
        'v2GetArrayVarLength',
        'v2GetArrayVar',
        'v2SetArrayVar',
        'v2PushArrayVar',
        'v2PopArrayVar',
        'v2ShiftArrayVar',
        'v2UnshiftArrayVar',
        'v2SpliceArrayVar',
        'v2SliceArrayVar',
        'v2GetIndexOfValueInArrayVar',
        'v2RemoveIndexFromArrayVar',
        'v2Calculate',
        'v2Comment',
        'v2DeclareLocalVar'
    ]

    const displayAllowList = [
        'v2GetDisplayState',
        'v2SetDisplayState',
        ...safeSubset
    ]

    const requestAllowList = [
        'v2GetRequestState',
        'v2SetRequestState',
        'v2GetRequestStateRole',
        'v2SetRequestStateRole',
        'v2GetRequestStateLength',
        ...safeSubset
    ]

    async function collectStreamingText(stream) {
        const reader = stream.getReader()
        let lastChunk = ''

        while (true) {
            const { done, value } = await reader.read()
            if (value) {
                const firstKey = Object.keys(value)[0]
                if (firstKey) {
                    lastChunk = value[firstKey] ?? lastChunk
                }
            }
            if (done) {
                break
            }
        }

        return lastChunk
    }

    async function runTrigger(char,mode, arg

    ){
        arg.recursiveCount ??= 0
        char = arg.displayMode ? char : safeStructuredClone(char)
        let varChanged = false
        let stopSending = arg.stopSending ?? false
        const CharacterlowLevelAccess = char.lowLevelAccess ?? false
        let sendAIprompt = false
        const currentChat = getCurrentChat()
        let additonalSysPrompt = arg.additonalSysPrompt ?? {
            start:'',
            historyend: '',
            promptend: ''
        }
        const triggers = char.triggerscript.map((v) => {
            v.lowLevelAccess = CharacterlowLevelAccess
            return v
        }).concat(getModuleTriggers())
        const db = getDatabase()
        const defaultVariables = parseKeyValue(char.defaultVariables).concat(parseKeyValue(db.templateDefaultVariables))
        let chat = arg.displayMode ? arg.chat : safeStructuredClone(arg.chat ?? char.chats[char.chatPage])

        const previousTriggerId = get(CurrentTriggerIdStore)
        const shouldSetTriggerId = !arg.displayMode && mode !== 'display'
        if (shouldSetTriggerId) {
            CurrentTriggerIdStore.set(arg.triggerId || null)
        }

        if((!triggers) || (triggers.length === 0)){
            if (shouldSetTriggerId) {
                CurrentTriggerIdStore.set(previousTriggerId)
            }
            return null
        }

        let tempVars = arg.tempVars ?? {}

        let localVarScopes = [{}]
        let currentIndent = 0


        function getLocalVar(key) {
            if (!localVarScopes || localVarScopes.length === 0) {
                return null
            }
            const currentScope = localVarScopes[localVarScopes.length - 1]
            if (!currentScope) {
                return null
            }
            for (let indent = currentIndent; indent >= 0; indent--) {
                if (currentScope[indent] && currentScope[indent][key] !== undefined) {
                    const value = currentScope[indent][key]
                    return value
                }
            }
            return null
        }

        function setLocalVar(key, value, indent) {
            if (!localVarScopes || localVarScopes.length === 0) {
                localVarScopes = [{}]
            }
            const currentScope = localVarScopes[localVarScopes.length - 1]
            if (!currentScope) {
                return false
            }

            const finalValue = (value === null || value === undefined) ? 'null' : value

            let foundIndent = -1
            for (let i = indent; i >= 0; i--) {
                if (currentScope[i] && currentScope[i][key] !== undefined) {
                    foundIndent = i
                    break
                }
            }

            const targetIndent = foundIndent !== -1 ? foundIndent : indent

            if (!currentScope[targetIndent]) {
                currentScope[targetIndent] = {}
            }

            if(currentScope[targetIndent][key] === finalValue){
                return false
            }

            currentScope[targetIndent][key] = finalValue
            return true
        }

        function declareLocalVar(key, value, indent) {
            setLocalVar(key, value, indent)
        }

        function clearLocalVarsAtIndent(indent) {
            if (!localVarScopes || localVarScopes.length === 0) {
                return
            }
            const currentScope = localVarScopes[localVarScopes.length - 1]
            if (!currentScope) {
                return
            }
            const indentsToDelete = []
            for (const scopeIndent in currentScope) {
                if (Number(scopeIndent) >= indent) {
                    indentsToDelete.push(scopeIndent)
                }
            }
            indentsToDelete.forEach(indentKey => {
                delete currentScope[indentKey]
            })
        }

        function getVar(key){
            const localVar = getLocalVar(key)
            if(localVar !== null){
                return localVar
            }

            const state = chat.scriptstate?.['$' + key]
            if(state === undefined || state === null){
                const findResult = defaultVariables.find((f) => {
                    return f[0] === key
                })
                if(findResult){
                    return findResult[1]
                }
                if(arg.displayMode){
                    return tempVars[key] ?? 'null'
                }
                return 'null'
            }
            return state.toString()
        }

        function setVar(key, value) {
            if(arg.displayMode){
                if(tempVars[key] === value){
                    return false
                }
                tempVars[key] = value
                return true
            }

            const localVar = getLocalVar(key)
            if(localVar !== null){
                return setLocalVar(key, value, currentIndent)
            }

            const selectedCharId = get(selectedCharID)
            const currentCharacter = getCurrentCharacter()
            const db = getDatabase()
            chat.scriptstate ??= {}
            const stateKey = '$' + key
            if(chat.scriptstate[stateKey] === value){
                return false
            }

            varChanged = true
            chat.scriptstate[stateKey] = value
            currentChat.scriptstate = chat.scriptstate
            currentCharacter.chats[currentCharacter.chatPage].scriptstate = chat.scriptstate
            db.characters[selectedCharId].chats[currentCharacter.chatPage].scriptstate = chat.scriptstate
            return true
        }


        for(const trigger of triggers){
            let tempVars = {}

            if(trigger.effect[0]?.type === 'triggercode' || trigger.effect[0]?.type === 'triggerlua'){
                //
            }
            else if(arg.manualName){
                if(trigger.comment !== arg.manualName){
                    continue
                }
            }
            else if(mode !== trigger.type){
                continue
            }

            let pass = true
            for(const condition of trigger.conditions){
                if(condition.type === 'var' || condition.type === 'chatindex' || condition.type === 'value'){
                    let varValue =  (condition.type === 'var') ? (getVar(condition.var) ?? 'null') :
                                    (condition.type === 'chatindex') ? (chat.message.length.toString()) :
                                    (condition.type === 'value') ? condition.var : null

                    if(varValue === undefined || varValue === null){
                        pass = false
                        break
                    }
                    else{
                        const conditionValue = risuChatParser(condition.value,{chara:char})
                        varValue = risuChatParser(varValue,{chara:char})
                        switch(condition.operator){
                            case 'true': {
                                if(varValue !== 'true' && varValue !== '1'){
                                    pass = false
                                }
                                break
                            }
                            case '=':
                                if(varValue !== conditionValue){
                                    pass = false
                                }
                                break
                            case '!=':
                                if(varValue === conditionValue){
                                    pass = false
                                }
                                break
                            case '>':
                                if(Number(varValue) <= Number(conditionValue)){
                                    pass = false
                                }
                                break
                            case '<':
                                if(Number(varValue) >= Number(conditionValue)){
                                    pass = false
                                }
                                break
                            case '>=':
                                if(Number(varValue) < Number(conditionValue)){
                                    pass = false
                                }
                                break
                            case '<=':
                                if(Number(varValue) > Number(conditionValue)){
                                    pass = false
                                }
                                break
                            case 'null':
                                if(varValue !== 'null'){
                                    pass = false
                                }
                                break
                        }
                    }
                }
                else if(condition.type === 'exists'){
                    const conditionValue = risuChatParser(condition.value,{chara:char})
                    const val = risuChatParser(conditionValue,{chara:char})
                    let da =  chat.message.slice(0-condition.depth).map((v)=>v.data).join(' ')
                    if(condition.type2 === 'strict'){
                        pass = da.split(' ').includes(val)
                    }
                    else if(condition.type2 === 'loose'){
                        pass = da.toLowerCase().includes(val.toLowerCase())
                    }
                    else if(condition.type2 === 'regex'){
                        pass = new RegExp(val).test(da)
                    }
                }
                if(!pass){
                    break
                }
            }
            if(!pass){
                continue
            }

            for(let index = 0; index < trigger.effect.length; index++){
                const effect = trigger.effect[index]
                if(mode === 'display' && !displayAllowList.includes(effect.type)){
                    continue
                }
                if(mode === 'request' && !requestAllowList.includes(effect.type)){
                    continue
                }

                if(effect && 'indent' in effect && typeof effect.indent === 'number' && effect.indent >= 0){
                    currentIndent = effect.indent
                } else if(!effect || !('indent' in effect)) {
                    currentIndent = 0
                }

                switch(effect.type){
                    case'setvar': {
                        const effectValue = risuChatParser(effect.value,{chara:char})
                        const varKey  = risuChatParser(effect.var,{chara:char})
                        let originalVar = Number(getVar(varKey))
                        if(Number.isNaN(originalVar)){
                            originalVar = 0
                        }
                        let resultValue = ''
                        switch(effect.operator){
                            case '=':{
                                resultValue = effectValue
                                break
                            }
                            case '+=':{
                                resultValue = (originalVar + Number(effectValue)).toString()
                                break
                            }
                            case '-=':{
                                resultValue = (originalVar - Number(effectValue)).toString()
                                break
                            }
                            case '*=':{
                                resultValue = (originalVar * Number(effectValue)).toString()
                                break
                            }
                            case '/=':{
                                resultValue = (originalVar / Number(effectValue)).toString()
                                break
                            }
                        }
                        setVar(varKey, resultValue)
                        break
                    }
                    case 'systemprompt':{
                        const effectValue = risuChatParser(effect.value,{chara:char})
                        additonalSysPrompt[effect.location] += effectValue + "\n\n"
                        break
                    }
                    case 'impersonate':{
                        const effectValue = risuChatParser(effect.value,{chara:char})
                        if(effect.role === 'user'){
                            chat.message.push({role: 'user', data: effectValue})
                        }
                        else if(effect.role === 'char'){
                            chat.message.push({role: 'char', data: effectValue})
                        }
                        break
                    }
                    case 'command':{
                        const effectValue = risuChatParser(effect.value,{chara:char})
                        await processMultiCommand(effectValue)
                        break
                    }
                    case 'stop':
                    case 'v2StopPromptSending':{
                        stopSending = true
                        break
                    }
                    case 'runtrigger':{
                        if(arg.recursiveCount < 10 || trigger.lowLevelAccess){
                            arg.recursiveCount++
                            const r = await runTrigger(char,'manual',{
                                chat,
                                recursiveCount: arg.recursiveCount,
                                additonalSysPrompt,
                                stopSending,
                                manualName: effect.value
                            })
                            if(r){
                                additonalSysPrompt = r.additonalSysPrompt
                                chat = r.chat
                                stopSending = r.stopSending
                            }
                        }
                        break
                    }
                    case 'cutchat':{
                        const start = Number(risuChatParser(effect.start,{chara:char}))
                        const end = Number(risuChatParser(effect.end,{chara:char}))
                        chat.message = chat.message.slice(start,end)
                        break
                    }
                    case 'modifychat':{
                        const index = Number(risuChatParser(effect.index,{chara:char}))
                        const value = risuChatParser(effect.value,{chara:char})
                        if(chat.message[index]){
                            chat.message[index].data = value
                        }
                        break
                    }

                    // low level access only
                    case 'showAlert':{
                        if(!trigger.lowLevelAccess){
                            break
                        }

                        if(arg.displayMode){
                            return
                        }

                        const effectValue = risuChatParser(effect.value,{chara:char})
                        const inputVar = risuChatParser(effect.inputVar,{chara:char})

                        switch(effect.alertType){
                            case 'normal':{
                                alertNormal(effectValue)
                                break
                            }
                            case 'error':{
                                alertError(effectValue)
                                break
                            }
                            case 'input':{
                                const val = await alertInput(effectValue)
                                setVar(inputVar, val)
                                break;
                            }
                            case 'select':{
                                const val = await alertSelect(effectValue.split('§'))
                                setVar(inputVar, val)
                            }
                        }
                        break
                    }

                    case 'sendAIprompt':{
                        if(!trigger.lowLevelAccess){
                            break
                        }
                        sendAIprompt = true
                        break
                    }

                    case 'runLLM':{
                        if(!trigger.lowLevelAccess){
                            break
                        }
                        const effectValue = risuChatParser(effect.value,{chara:char})
                        const varName = effect.inputVar
                        let promptbody = parseChatML(effectValue)
                        if(!promptbody){
                            promptbody = [{role:'user', content:effectValue}]
                        }
                        const result = await requestChatData({
                            formated: promptbody,
                            bias: {},
                            useStreaming: false,
                            noMultiGen: true,
                        }, 'model')

                        if(result.type === 'fail' || result.type === 'streaming' || result.type === 'multiline'){
                            setVar(varName, 'Error: ' + result.result)
                        }
                        else{
                            setVar(varName, result.result)
                        }

                        break
                    }

                    case 'checkSimilarity':{
                        if(!trigger.lowLevelAccess){
                            break
                        }

                        const processer = new HypaProcesser()
                        const effectValue = risuChatParser(effect.value,{chara:char})
                        const source = risuChatParser(effect.source,{chara:char})
                        await processer.addText(effectValue.split('§'))
                        const val = await processer.similaritySearch(source)
                        setVar(effect.inputVar, val.join('§'))
                        break
                    }

                    case 'extractRegex':{
                        if(!trigger.lowLevelAccess){
                            break
                        }

                        const effectValue = risuChatParser(effect.value,{chara:char})
                        const regex = new RegExp(effect.regex, effect.flags)
                        const regexResult = regex.exec(effectValue)
                        const result = effect.result.replace(/\$[0-9]+/g, (match) => {
                            const index = Number(match.slice(1))
                            return regexResult[index]
                        }).replace(/\$&/g, regexResult[0]).replace(/\$\$/g, '$')

                        setVar(effect.inputVar, result)
                        break
                    }

                    case 'runImgGen':{
                        if(!trigger.lowLevelAccess){
                            break
                        }

                        const effectValue = risuChatParser(effect.value,{chara:char})
                        const negValue = risuChatParser(effect.negValue,{chara:char})
                        const gen = await generateAIImage(effectValue, char, negValue, 'inlay')
                        if(!gen){
                            setVar(effect.inputVar, 'Error: Image generation failed')
                            break
                        }
                        const imgHTML = new Image()
                        imgHTML.src = gen
                        const inlay = await writeInlayImage(imgHTML)
                        const res = `{{inlay::${inlay}}}`
                        setVar(effect.inputVar, res)
                        break
                    }

                    case 'triggerlua':{
                        const triggerCodeResult = await runScripted(effect.code,{
                            lowLevelAccess: trigger.lowLevelAccess,
                            mode: mode === 'manual' ? arg.manualName : mode,
                            setVar: setVar,
                            getVar: getVar,
                            char: char,
                            chat: chat,
                        })

                        if(triggerCodeResult.stopSending){
                            stopSending = true
                        }
                        chat = triggerCodeResult.chat
                        break
                    }

                    //V2 triggers
                    case 'v2Header':{
                        //Header for V2 triggers to identify the start of a new trigger
                        break
                    }
                    case 'v2SetVar':{
                        const effectValue = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        const varKey  = risuChatParser(effect.var,{chara:char})
                        let originalVar = Number(getVar(varKey))
                        if(Number.isNaN(originalVar)){
                            originalVar = 0
                        }
                        let resultValue = ''
                        switch(effect.operator){
                            case '=':{
                                resultValue = effectValue
                                break
                            }
                            case '+=':{
                                resultValue = (originalVar + Number(effectValue)).toString()
                                break
                            }
                            case '-=':{
                                resultValue = (originalVar - Number(effectValue)).toString()
                                break
                            }
                            case '*=':{
                                resultValue = (originalVar * Number(effectValue)).toString()
                                break
                            }
                            case '/=':{
                                resultValue = (originalVar / Number(effectValue)).toString()
                                break
                            }
                            case '%=':{
                                resultValue = (originalVar % Number(effectValue)).toString()
                                break
                            }
                        }
                        setVar(varKey, resultValue)
                        break
                    }
                    case 'v2DeclareLocalVar':{
                        const effectValue = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        const varKey = risuChatParser(effect.var,{chara:char})
                        const finalValue = (effectValue === null || effectValue === undefined) ? 'null' : effectValue
                        declareLocalVar(varKey, finalValue, effect.indent)
                        break
                    }
                    case 'v2If':
                    case 'v2IfAdvanced':{
                        const sourceValue = (effect.type === 'v2If' || effect.sourceType === 'var') ? getVar(risuChatParser(effect.source,{chara:char})) : risuChatParser(effect.source,{chara:char})
                        const targetValue = effect.targetType === 'value' ? risuChatParser(effect.target,{chara:char}) : getVar(risuChatParser(effect.target,{chara:char}))
                        let pass = false
                        switch(effect.condition){
                            case '=':{
                                if(!isNaN(Number(sourceValue)) && !isNaN(Number(targetValue))){ //to check like 1.0 = 1
                                    pass = Number(sourceValue) === Number(targetValue)
                                }
                                else{
                                    pass = sourceValue === targetValue
                                }
                                break
                            }
                            case '!=':{
                                if(!isNaN(Number(sourceValue)) && !isNaN(Number(targetValue))){ //to check like 1.0 = 1
                                    pass = Number(sourceValue) !== Number(targetValue)
                                }
                                else{
                                    pass = sourceValue !== targetValue
                                }
                                break
                            }
                            case '>':{
                                pass = Number(sourceValue) > Number(targetValue)
                                break
                            }
                            case '<':{
                                pass = Number(sourceValue) < Number(targetValue)
                                break
                            }
                            case '>=':{
                                pass = Number(sourceValue) >= Number(targetValue)
                                break
                            }
                            case '<=':{
                                pass = Number(sourceValue) <= Number(targetValue)
                                break
                            }
                            case '∈':{
                                try {
                                    pass = JSON.parse(targetValue).includes(sourceValue)
                                } catch (error) {
                                    pass = false
                                }
                                break
                            }
                            case '∋':{
                                try {
                                    pass = JSON.parse(sourceValue).includes(targetValue)
                                } catch (error) {
                                    pass = false
                                }
                                break
                            }
                            case '∉':{
                                try {
                                    pass = !JSON.parse(targetValue).includes(sourceValue)
                                } catch (error) {
                                    pass = true
                                }
                                break
                            }
                            case '∌':{
                                try {
                                    pass = !JSON.parse(sourceValue).includes(targetValue)
                                } catch (error) {
                                    pass = true
                                }
                                break
                            }
                            case '≒':{
                                const num1 = Number(sourceValue)
                                const num2 = Number(targetValue)
                                if(Number.isNaN(num1) || Number.isNaN(num2)){
                                    pass = sourceValue.toLocaleLowerCase().replace(/ /g,'') === targetValue.toLocaleLowerCase().replace(/ /g,'')
                                }
                                else{
                                    pass = Math.abs(num1 - num2) < 0.0001
                                }
                                break
                            }
                            case '≡':{
                                if(targetValue === 'true'){
                                    pass = sourceValue === 'true' || sourceValue === '1'
                                }
                                else if(targetValue === 'false'){
                                    pass = !(sourceValue === 'true' || sourceValue === '1')
                                }
                                else{
                                    pass = sourceValue === targetValue
                                }
                            }
                        }

                        if(!pass){
                            let indent = effect.indent + 1
                            for(; index < trigger.effect.length; index++){
                                const ef = trigger.effect[index]
                                if(ef.type === 'v2EndIndent' && indent === ef.indent){
                                    const nextEf = trigger.effect[index + 1]
                                    indent--
                                    if(nextEf?.type === 'v2Else' && nextEf?.indent === indent){
                                        index++
                                    }

                                    break
                                }
                            }
                        }
                        break
                    }
                    case 'v2Else':{
                        //since if handles the else if the if is false, we can skip the else
                        const indent = effect.indent + 1
                        for(; index < trigger.effect.length; index++){
                            const ef = trigger.effect[index]
                            if(ef.type === 'v2EndIndent' && indent === ef.indent){
                                break
                            }
                        }
                        break
                    }
                    case 'v2EndIndent':{
                        if(effect.endOfLoop){
                            const indent = effect.indent - 1
                            const originalIndex = index
                            for(; index >= 0; index--){
                                const ef = trigger.effect[index]
                                if((ef.type === 'v2Loop' || ef.type === 'v2LoopNTimes') && indent === ef.indent){

                                    if(ef.type === 'v2LoopNTimes'){
                                        let value = ef.valueType === 'value' ? risuChatParser(ef.value,{chara:char}) : getVar(risuChatParser(ef.value,{chara:char}))
                                        let valueNum = Number(value)
                                        if(Number.isNaN(valueNum)){
                                            valueNum = 0
                                        }
                                        tempVars[index + 'LoopNTimes'] = (tempVars[index + 'LoopNTimes'] ?? 0) + 1
                                        if(tempVars[index + 'LoopNTimes'] >= valueNum){
                                            index = originalIndex
                                        }
                                        else{
                                            break
                                        }
                                    }

                                    break
                                }
                            }

                            //this is for preventing lagging
                            tempVars['loopTimes'] = (tempVars['loopTimes'] ?? 0) + 1
                            if(tempVars['loopTimes'] > 100){
                                await sleep(1)
                                tempVars['loopTimes'] = 0
                            }
                        }

                        clearLocalVarsAtIndent(effect.indent)

                        break
                    }
                    case 'v2Loop':
                    case 'v2LoopNTimes':{
                        //Looping is handled by the v2EndIndent
                        break
                    }
                    case 'v2BreakLoop':{
                        for(; index < trigger.effect.length; index++){
                            const ef = trigger.effect[index]
                            if(ef.type === 'v2EndIndent' && ef.endOfLoop){
                                break
                            }
                        }
                        break
                    }
                    case 'v2RunTrigger':{
                        if(arg.recursiveCount < 10 || trigger.lowLevelAccess){
                            arg.recursiveCount++
                            const r = await runTrigger(char,'manual',{
                                chat,
                                recursiveCount: arg.recursiveCount,
                                additonalSysPrompt,
                                stopSending,
                                manualName: effect.target
                            })
                            if(r){
                                additonalSysPrompt = r.additonalSysPrompt
                                chat = r.chat
                                stopSending = r.stopSending
                            }
                        }
                        break
                    }
                    case 'v2ConsoleLog':{
                        const sourceValue = effect.sourceType === 'value' ? risuChatParser(effect.source,{chara:char}) : getVar(risuChatParser(effect.source,{chara:char}))
                        console.log(sourceValue)
                        break
                    }
                    case 'v2StopTrigger':{
                        index = trigger.effect.length
                        break
                    }
                    case 'v2CutChat':{
                        let start = effect.startType === 'value' ? Number(risuChatParser(effect.start,{chara:char})) : Number(getVar(risuChatParser(effect.start,{chara:char})))
                        let end = effect.endType === 'value' ? Number(risuChatParser(effect.end,{chara:char})) : Number(getVar(risuChatParser(effect.end,{chara:char})))
                        if(isNaN(start)){
                            start = 0
                        }
                        if(isNaN(end)){
                            end = chat.message.length
                        }

                        chat.message = chat.message.slice(start,end)
                        break
                    }
                    case 'v2ModifyChat':{
                        let index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))
                        let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        if(chat.message[index]){
                            chat.message[index].data = value
                        }
                        break
                    }
                    case 'v2SystemPrompt':{
                        let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        additonalSysPrompt[effect.location] += value + "\n\n"
                        break
                    }
                    case 'v2Impersonate':{
                        let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        if(effect.role === 'user'){
                            chat.message.push({role: 'user', data: value})
                        }
                        else if(effect.role === 'char'){
                            chat.message.push({role: 'char', data: value})
                        }
                        break
                    }
                    case 'v2Command':{
                        let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        await processMultiCommand(value)
                        break
                    }
                    case 'v2SendAIprompt':{
                        if(!trigger.lowLevelAccess){
                            break
                        }
                        sendAIprompt = true
                        break
                    }
                    case 'v2ImgGen':{
                        if(!trigger.lowLevelAccess){
                            break
                        }
                        let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        let negValue = effect.negValueType === 'value' ? risuChatParser(effect.negValue,{chara:char}) : getVar(risuChatParser(effect.negValue,{chara:char}))
                        let gen = await generateAIImage(value, char, negValue, 'inlay')
                        if(!gen){
                            setVar(risuChatParser(effect.outputVar, {chara:char}), 'null')
                            break
                        }
                        let imgHTML = new Image()
                        imgHTML.src = gen
                        let inlay = await writeInlayImage(imgHTML)
                        let res = `{{inlay::${inlay}}}`
                        setVar(risuChatParser(effect.outputVar, {chara:char}), res)
                        break

                    }
                    case 'v2CheckSimilarity':{
                        if(!trigger.lowLevelAccess){
                            break
                        }
                        let source = effect.sourceType === 'value' ? risuChatParser(effect.source,{chara:char}) : getVar(risuChatParser(effect.source,{chara:char}))
                        let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        let processer = new HypaProcesser()
                        await processer.addText(value.split('§'))
                        let val = await processer.similaritySearch(source)
                        setVar(risuChatParser(effect.outputVar, {chara:char}), val.join('§'))
                        break
                    }
                    case 'v2RunLLM':{
                        if(!trigger.lowLevelAccess){
                            break
                        }
                        let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        let promptbody = parseChatML(value)
                        if(!promptbody){
                            promptbody = [{role:'user', content:value}]
                        }
                        let result = await requestChatData({
                            formated: promptbody,
                            bias: {},
                            useStreaming: effect.streaming ?? false,
                            noMultiGen: true,
                        }, effect.model)

                        if(result.type === 'fail' || result.type === 'multiline'){
                            setVar(risuChatParser(effect.outputVar, {chara:char}), 'null')
                        }
                        else if(result.type === 'streaming'){
                            const text = await collectStreamingText(result.result)
                            setVar(risuChatParser(effect.outputVar, {chara:char}), text)
                        }
                        else{
                            setVar(risuChatParser(effect.outputVar, {chara:char}), result.result)
                        }
                        break
                    }
                    case 'v2ShowAlert':{
                        if(arg.displayMode){
                            return
                        }
                        let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        alertNormal(value)
                        break
                    }
                    case 'v2ExtractRegex':{
                        let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        let regexValue = effect.regexType === 'value' ? risuChatParser(effect.regex,{chara:char}) : getVar(risuChatParser(effect.regex,{chara:char}))
                        let flagsValue = effect.flagsType === 'value' ? risuChatParser(effect.flags,{chara:char}) : getVar(risuChatParser(effect.flags,{chara:char}))
                        let regex = new RegExp(regexValue, flagsValue)
                        let regexResult = regex.exec(value)
                        let resultValue = effect.resultType === 'value' ? risuChatParser(effect.result,{chara:char}) : getVar(risuChatParser(effect.result,{chara:char}))

                        let result = ''
                        if (regexResult !== null) {
                            result = resultValue.replace(/\$[0-9]+/g, (match) => {
                                let index = Number(match.slice(1))
                                return regexResult[index] || ''
                            }).replace(/\$&/g, regexResult[0] || '').replace(/\$\$/g, '$')
                        } else {
                            result = resultValue.replace(/\$[0-9]+/g, '').replace(/\$&/g, '').replace(/\$\$/g, '$')
                        }

                        setVar(risuChatParser(effect.outputVar, {chara:char}), result)
                        break
                    }
                    case 'v2GetLastMessage':{
                        setVar(risuChatParser(effect.outputVar, {chara:char}), chat.message[chat.message.length - 1]?.data ?? 'null')
                        break
                    }
                    case 'v2GetMessageAtIndex':{
                        let index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))
                        setVar(risuChatParser(effect.outputVar, {chara:char}), chat.message[index]?.data ?? 'null')
                        break
                    }
                    case 'v2GetMessageCount':{
                        setVar(risuChatParser(effect.outputVar, {chara:char}), chat.message.length.toString())
                        break
                    }
                    case 'v2ModifyLorebook':{
                        char.globalLore = char.globalLore ?? []
                        const target = effect.targetType === 'value' ? risuChatParser(effect.target,{chara:char}) : getVar(risuChatParser(effect.target,{chara:char}))
                        const value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))

                        const index = char.globalLore.findIndex((v) => v[0] === target)
                        if(index !== -1){
                            char.globalLore[index][1] = value
                        }

                        const db = getDatabase()
                        const selectedCharId = get(selectedCharID)
                        db.characters[selectedCharId].globalLore = char.globalLore
                        setCurrentCharacter(db.characters[selectedCharId])
                        break
                    }
                    case 'v2GetLorebook':{
                        char.globalLore = char.globalLore ?? []
                        const target = effect.targetType === 'value' ? risuChatParser(effect.target,{chara:char}) : getVar(risuChatParser(effect.target,{chara:char}))
                        const index = char.globalLore.findIndex((v) => v[0] === target)
                        setVar(risuChatParser(effect.outputVar, {chara:char}), index === -1 ? 'null' : char.globalLore[index][1])
                        break
                    }
                    case 'v2GetLorebookCount':{
                        char.globalLore = char.globalLore ?? []
                        setVar(risuChatParser(effect.outputVar, {chara:char}), char.globalLore.length.toString())
                        break
                    }
                    case 'v2GetLorebookEntry':{
                        char.globalLore = char.globalLore ?? []
                        let index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))
                        if(Number.isNaN(index)){
                            index = 0
                        }
                        setVar(risuChatParser(effect.outputVar, {chara:char}), char.globalLore[index]?.[1] ?? 'null')
                        break
                    }
                    case 'v2SetLorebookActivation':{
                        char.globalLore = char.globalLore ?? []
                        let index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))
                        let value = effect.value
                        char.globalLore[index][2] = value

                        const selectedCharId = get(selectedCharID)
                        const db = getDatabase()
                        db.characters[selectedCharId].globalLore = char.globalLore
                        setCurrentCharacter(char)

                        break
                    }
                    case 'v2GetLorebookIndexViaName':{
                        char.globalLore = char.globalLore ?? []
                        let name = effect.nameType === 'value' ? risuChatParser(effect.name,{chara:char}) : getVar(risuChatParser(effect.name,{chara:char}))
                        let index = char.globalLore.findIndex((v) => v[0] === name)
                        setVar(risuChatParser(effect.outputVar, {chara:char}), index.toString())
                        break
                    }
                    case 'v2Random':{
                        let min = effect.minType === 'value' ? Number(risuChatParser(effect.min,{chara:char})) : Number(getVar(risuChatParser(effect.min,{chara:char})))
                        let max = effect.maxType === 'value' ? Number(risuChatParser(effect.max,{chara:char})) : Number(getVar(risuChatParser(effect.max,{chara:char})))

                        let output = Math.floor(Math.random() * (max - min + 1) + min)
                        setVar(risuChatParser(effect.outputVar, {chara:char}), output.toString())
                        break
                    }
                    case 'v2GetCharAt':{
                        let source = effect.sourceType === 'value' ? risuChatParser(effect.source,{chara:char}) : getVar(risuChatParser(effect.source,{chara:char}))
                        let index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))
                        setVar(risuChatParser(effect.outputVar, {chara:char}), source[index] ?? 'null')
                        break
                    }
                    case 'v2GetCharCount':{
                        let source = effect.sourceType === 'value' ? risuChatParser(effect.source,{chara:char}) : getVar(risuChatParser(effect.source,{chara:char}))
                        setVar(risuChatParser(effect.outputVar, {chara:char}), source.length.toString())
                        break
                    }
                    case 'v2ToLowerCase':{
                        let source = effect.sourceType === 'value' ? risuChatParser(effect.source,{chara:char}) : getVar(risuChatParser(effect.source,{chara:char}))
                        setVar(risuChatParser(effect.outputVar, {chara:char}), source.toLowerCase())
                        break
                    }
                    case 'v2ToUpperCase':{
                        let source = effect.sourceType === 'value' ? risuChatParser(effect.source,{chara:char}) : getVar(risuChatParser(effect.source,{chara:char}))
                        setVar(risuChatParser(effect.outputVar, {chara:char}), source.toUpperCase())
                        break
                    }
                    case 'v2SetCharAt':{
                        let source = effect.sourceType === 'value' ? risuChatParser(effect.source,{chara:char}) : getVar(risuChatParser(effect.source,{chara:char}))
                        let index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))
                        let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        const source2 = [...source]
                        source2[index] = value
                        setVar(risuChatParser(effect.outputVar, {chara:char}), source2.join(''))
                        break
                    }
                    case 'v2SplitString':{
                        let source = effect.sourceType === 'value' ? risuChatParser(effect.source,{chara:char}) : getVar(risuChatParser(effect.source,{chara:char}))
                        let delimiter

                        if (effect.delimiterType === 'value') {
                            delimiter = risuChatParser(effect.delimiter,{chara:char})
                        } else if (effect.delimiterType === 'var') {
                            delimiter = getVar(risuChatParser(effect.delimiter,{chara:char}))
                        } else {
                            delimiter = risuChatParser(effect.delimiter,{chara:char})
                        }

                        let result
                        if (effect.delimiterType === 'regex') {
                            try {
                                const regexMatch = delimiter.match(/^\/(.+)\/([gimuy]*)$/)
                                if (regexMatch) {
                                    const [, pattern, flags] = regexMatch
                                    const regex = new RegExp(pattern, flags)
                                    result = source.split(regex)
                                } else {
                                    const regex = new RegExp(delimiter)
                                    result = source.split(regex)
                                }
                            } catch (error) {
                                result = [source]
                            }
                        } else {
                            result = source.split(delimiter)
                        }

                        setVar(risuChatParser(effect.outputVar, {chara:char}), JSON.stringify(result))
                        break
                    }
                    case 'v2JoinArrayVar':{
                        try {
                            let varValue = effect.varType === 'value' ? risuChatParser(effect.var,{chara:char}) : getVar(risuChatParser(effect.var,{chara:char}))
                            let arr = JSON.parse(varValue)
                            let delimiter = effect.delimiterType === 'value' ? risuChatParser(effect.delimiter,{chara:char}) : getVar(risuChatParser(effect.delimiter,{chara:char}))
                            setVar(risuChatParser(effect.outputVar, {chara:char}), arr.join(delimiter))
                        } catch (error) {
                            setVar(risuChatParser(effect.outputVar, {chara:char}), '')
                        }
                        break
                    }
                    case 'v2GetCharacterDesc':{
                        setVar(risuChatParser(effect.outputVar, {chara:char}), char.desc)
                        break
                    }
                    case 'v2SetCharacterDesc':{
                        let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        char.desc = value
                        const selectedCharId = get(selectedCharID)
                        const db = getDatabase();
                        (db.characters[selectedCharId] ).desc = value
                        setCurrentCharacter(char)
                        break
                    }
                    case 'v2GetPersonaDesc':{
                        const db = getDatabase()
                        const currentPersonaPrompt = db.personaPrompt ?? ''
                        const savedPersonaPrompt = db.personas[db.selectedPersona]?.personaPrompt ?? ''
                        setVar(risuChatParser(effect.outputVar, {chara:char}), currentPersonaPrompt || savedPersonaPrompt)
                        break
                    }
                    case 'v2SetPersonaDesc':{
                        const value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        if(DBState.db.personas[DBState.db.selectedPersona]){
                            DBState.db.personas[DBState.db.selectedPersona].personaPrompt = value
                            DBState.db.personaPrompt = value
                        }
                        break
                    }
                    case 'v2GetReplaceGlobalNote':{
                        setVar(risuChatParser(effect.outputVar, {chara:char}), char.replaceGlobalNote ?? '')
                        break
                    }
                    case 'v2SetReplaceGlobalNote':{
                        const value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        char.replaceGlobalNote = value
                        const selectedCharId = get(selectedCharID)
                        const db = getDatabase();
                        (db.characters[selectedCharId] ).replaceGlobalNote = value
                        setCurrentCharacter(char)
                        break
                    }
                    case 'v2MakeArrayVar':{
                        const varName = risuChatParser(effect.var, {chara:char})
                        if(varName.startsWith('[') && varName.endsWith(']')){
                            return
                        }

                        setVar(varName, '[]')
                        break
                    }
                    case 'v2GetArrayVarLength':{
                        try {
                            const varName = risuChatParser(effect.var, {chara:char})
                            let varValue = getVar(varName)
                            let arr = JSON.parse(varValue)
                            setVar(risuChatParser(effect.outputVar, {chara:char}), arr.length.toString())
                        } catch (error) {
                            setVar(risuChatParser(effect.outputVar, {chara:char}), '0')
                        }
                        break
                    }
                    case 'v2GetArrayVar':{
                        try {
                            const varName = risuChatParser(effect.var, {chara:char})
                            let varValue = getVar(varName)
                            let arr = JSON.parse(varValue)
                            let index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))
                            setVar(risuChatParser(effect.outputVar, {chara:char}), arr[index] ?? 'null')
                        } catch (error) {
                            setVar(risuChatParser(effect.outputVar, {chara:char}), 'null')
                        }
                        break
                    }
                    case 'v2PushArrayVar':{
                        try {
                            const varName = risuChatParser(effect.var, {chara:char})
                            let varValue = getVar(varName)
                            let arr = JSON.parse(varValue)
                            let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                            arr.push(value)
                            setVar(varName, JSON.stringify(arr))
                        } catch (error) {
                            const varName = risuChatParser(effect.var, {chara:char})
                            setVar(varName, '[]')
                        }
                        break
                    }
                    case 'v2PopArrayVar':{
                        try {
                            const varName = risuChatParser(effect.var, {chara:char})
                            let varValue = getVar(varName)
                            let arr = JSON.parse(varValue)
                            setVar(risuChatParser(effect.outputVar, {chara:char}), arr.pop() ?? 'null')
                            setVar(varName, JSON.stringify(arr))
                        } catch (error) {
                            const varName = risuChatParser(effect.var, {chara:char})
                            setVar(varName, '[]')
                            setVar(risuChatParser(effect.outputVar, {chara:char}), 'null')
                        }
                        break
                    }
                    case 'v2ShiftArrayVar':{
                        try {
                            const varName = risuChatParser(effect.var, {chara:char})
                            let varValue = getVar(varName)
                            let arr = JSON.parse(varValue)
                            setVar(risuChatParser(effect.outputVar, {chara:char}), arr.shift() ?? 'null')
                            setVar(varName, JSON.stringify(arr))
                        } catch (error) {
                            const varName = risuChatParser(effect.var, {chara:char})
                            setVar(varName, '[]')
                            setVar(risuChatParser(effect.outputVar, {chara:char}), 'null')
                        }
                        break
                    }
                    case 'v2UnshiftArrayVar':{
                        try {
                            const varName = risuChatParser(effect.var, {chara:char})
                            let varValue = getVar(varName)
                            let arr = JSON.parse(varValue)
                            let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                            arr.unshift(value)
                            setVar(varName, JSON.stringify(arr))
                        } catch (error) {
                            const varName = risuChatParser(effect.var, {chara:char})
                            setVar(varName, '[]')
                        }
                        break
                    }
                    case 'v2SpliceArrayVar':{
                        try {
                            const varName = risuChatParser(effect.var, {chara:char})
                            let varValue = getVar(varName)
                            let arr = JSON.parse(varValue)
                            let start = effect.startType === 'value' ? Number(risuChatParser(effect.start,{chara:char})) : Number(getVar(risuChatParser(effect.start,{chara:char})))
                            let value = effect.itemType === 'value' ? risuChatParser(effect.item,{chara:char}) : getVar(risuChatParser(effect.item,{chara:char}))
                            arr.splice(start, 0, value)
                            setVar(varName, JSON.stringify(arr))
                        } catch (error) {
                            const varName = risuChatParser(effect.var, {chara:char})
                            setVar(varName, '[]')
                        }
                        break
                    }
                    case 'v2SliceArrayVar':{
                        try {
                            const varName = risuChatParser(effect.var, {chara:char})
                            let varValue = getVar(varName)
                            let arr = JSON.parse(varValue)
                            let start = effect.startType === 'value' ? Number(risuChatParser(effect.start,{chara:char})) : Number(getVar(risuChatParser(effect.start,{chara:char})))
                            let end = effect.endType === 'value' ? Number(risuChatParser(effect.end,{chara:char})) : Number(getVar(risuChatParser(effect.end,{chara:char})))

                            setVar(risuChatParser(effect.outputVar, {chara:char}), JSON.stringify(arr.slice(start,end)))
                        } catch (error) {
                            setVar(risuChatParser(effect.outputVar, {chara:char}), '[]')
                        }
                        break
                    }
                    case 'v2GetIndexOfValueInArrayVar':{
                        try {
                            const varName = risuChatParser(effect.var, {chara:char})
                            let varValue = getVar(varName)
                            let arr = JSON.parse(varValue)
                            let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                            setVar(risuChatParser(effect.outputVar, {chara:char}), arr.indexOf(value).toString())
                        } catch (error) {
                            setVar(risuChatParser(effect.outputVar, {chara:char}), '-1')
                        }
                        break
                    }
                    case 'v2RemoveIndexFromArrayVar':{
                        try {
                            const varName = risuChatParser(effect.var, {chara:char})
                            let varValue = getVar(varName)
                            let arr = JSON.parse(varValue)
                            let index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))
                            arr.splice(index, 1)
                            setVar(varName, JSON.stringify(arr))
                        } catch (error) {
                            const varName = risuChatParser(effect.var, {chara:char})
                            setVar(varName, '[]')
                        }
                        break
                    }
                    case 'v2ConcatString':{
                        let source1 = effect.source1Type === 'value' ? risuChatParser(effect.source1,{chara:char}) : getVar(risuChatParser(effect.source1,{chara:char}))
                        let source2 = effect.source2Type === 'value' ? risuChatParser(effect.source2,{chara:char}) : getVar(risuChatParser(effect.source2,{chara:char}))
                        setVar(risuChatParser(effect.outputVar, {chara:char}), source1 + source2)
                        break
                    }
                    case 'v2GetLastUserMessage':{
                        let lastUserMessage = chat.message.slice().reverse().find((v) => v.role === 'user')
                        setVar(risuChatParser(effect.outputVar, {chara:char}), lastUserMessage?.data ?? 'null')
                        break
                    }
                    case 'v2GetLastCharMessage':{
                        let lastCharMessage = chat.message.slice().reverse().find((v) => v.role === 'char')
                        setVar(risuChatParser(effect.outputVar, {chara:char}), lastCharMessage?.data ?? 'null')
                        break
                    }
                    case 'v2GetFirstMessage':{
                        setVar(risuChatParser(effect.outputVar, {chara:char}), chat.fmIndex === -1 ? char.firstMessage : char.alternateGreetings[chat.fmIndex])
                        break
                    }
                    case 'v2GetAlertInput':{
                        if(arg.displayMode){
                            return
                        }
                        let value = await alertInput(
                            effect.displayType === 'value' ? risuChatParser(effect.display,{chara:char}) : getVar(risuChatParser(effect.display,{chara:char}))
                        )
                        setVar(risuChatParser(effect.outputVar, {chara:char}), value)
                        break
                    }
                    case 'v2GetAlertSelect':{
                        if(arg.displayMode){
                            return
                        }
                        const display = effect.displayType === 'value' ? risuChatParser(effect.display,{chara:char}) : getVar(risuChatParser(effect.display,{chara:char}))
                        const value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        const options = value.split('|')
                        let result = await alertSelect(options, display)
                        setVar(risuChatParser(effect.outputVar, {chara:char}), result)
                        break
                    }
                    case 'v2SetArrayVar':{
                        const value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        const index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))
                        if(Number.isNaN(index)){
                            break
                        }
                        try {
                            const varName = risuChatParser(effect.var, {chara:char})
                            let varValue = getVar(varName)
                            let arr = JSON.parse(varValue)
                            arr[index] = value
                            setVar(varName, JSON.stringify(arr))
                        } catch (error) {

                        }
                        break
                    }
                    case 'v2GetDisplayState':{
                        if(!arg.displayMode){
                            return
                        }

                        setVar(risuChatParser(effect.outputVar, {chara:char}), arg.displayData ?? 'null')
                        break
                    }
                    case 'v2SetDisplayState':{
                        if(!arg.displayMode){
                            return
                        }
                        arg.displayData = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        break
                    }
                    case 'v2UpdateGUI':{
                        ReloadGUIPointer.set(get(ReloadGUIPointer) + 1)
                        break
                    }
                    case 'v2UpdateChatAt':{
                        ReloadChatPointer.update((v) => {
                            v[effect.index] = (v[effect.index] ?? 0) + 1
                            return v
                        })
                        break
                    }
                    case 'v2Wait':{
                        let value = effect.valueType === 'value' ? Number(risuChatParser(effect.value,{chara:char})) : Number(getVar(risuChatParser(effect.value,{chara:char})))
                        await sleep(value * 1000)
                        break
                    }
                    case 'v2GetRequestState':{
                        if(!arg.displayMode){
                            return
                        }
                        const json = JSON.parse(arg.displayData)
                        const index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))
                        const content = json?.[index]?.content ?? 'null'
                        setVar(risuChatParser(effect.outputVar, {chara:char}), content)
                        break
                    }
                    case 'v2SetRequestState':{
                        if(!arg.displayMode){
                            return
                        }
                        const json = JSON.parse(arg.displayData)
                        const index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))
                        const value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        json[index].content = value
                        arg.displayData = JSON.stringify(json)
                        break
                    }
                    case 'v2GetRequestStateRole':{
                        if(!arg.displayMode){
                            return
                        }
                        const json = JSON.parse(arg.displayData)
                        const index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))
                        const content = json?.[index]?.role ?? 'null'
                        setVar(risuChatParser(effect.outputVar, {chara:char}), content)
                        break
                    }
                    case 'v2SetRequestStateRole':{
                        if(!arg.displayMode){
                            return
                        }
                        const json = JSON.parse(arg.displayData)
                        const index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))
                        const value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        if(value === 'user' || value === 'assistant' || value === 'system'){
                            json[index].role = value
                        }
                        arg.displayData = JSON.stringify(json)
                        break
                    }

                    case 'v2GetRequestStateLength':{
                        if(!arg.displayMode){
                            return
                        }
                        const json = JSON.parse(arg.displayData)
                        setVar(risuChatParser(effect.outputVar, {chara:char}), json.length.toString())
                        break
                    }
                    case 'v2QuickSearchChat':{
                        const value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        const depth = effect.depthType === 'value' ? Number(risuChatParser(effect.depth,{chara:char})) : Number(getVar(risuChatParser(effect.depth,{chara:char})))
                        const condition = effect.condition

                        if(isNaN(depth)){
                            setVar(risuChatParser(effect.outputVar, {chara:char}), '0')
                            break
                        }
                        let pass = false
                        let da =  chat.message.slice(0-depth).map((v)=>v.data).join(' ')
                        if(condition === 'strict'){
                            pass = da.split(' ').includes(value)
                        }
                        else if(condition === 'loose'){
                            pass = da.toLowerCase().includes(value.toLowerCase())
                        }
                        else if(condition === 'regex'){
                            pass = new RegExp(value).test(da)
                        }
                        setVar(risuChatParser(effect.outputVar, {chara:char}), pass ? '1' : '0')
                        break
                    }
                    case 'v2Tokenize':{
                        const value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        setVar(risuChatParser(effect.outputVar, {chara:char}), (await tokenize(value)).toString())
                        break
                    }
                    case 'v2GetAllLorebooks':{
                        char.globalLore = char.globalLore ?? []
                        const allPrompts = []
                        for (const lore of char.globalLore) {
                            if (lore && lore.content !== undefined) {
                                allPrompts.push(lore.content)
                            }
                        }
                        setVar(risuChatParser(effect.outputVar, {chara:char}), JSON.stringify(allPrompts))
                        break
                    }
                    case 'v2GetLorebookByName':{
                        char.globalLore = char.globalLore ?? []
                        const name = effect.nameType === 'value' ? risuChatParser(effect.name,{chara:char}) : getVar(risuChatParser(effect.name,{chara:char}))
                        const regex = new RegExp(name, 'i')
                        const matchingIndices = []
                        for (let i = 0; i < char.globalLore.length; i++) {
                            const lore = char.globalLore[i]
                            if (lore && lore.comment !== undefined && regex.test(lore.comment)) {
                                matchingIndices.push(i)
                            }
                        }
                        setVar(risuChatParser(effect.outputVar, {chara:char}), JSON.stringify(matchingIndices))
                        break
                    }
                    case 'v2GetLorebookByIndex':{
                        char.globalLore = char.globalLore ?? []
                        let index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))
                        if(Number.isNaN(index) || index < 0 || index >= char.globalLore.length){
                            setVar(risuChatParser(effect.outputVar, {chara:char}), 'null')
                        } else {
                            const loreEntry = char.globalLore[index]
                            if(loreEntry && loreEntry.content !== undefined){
                                setVar(risuChatParser(effect.outputVar, {chara:char}), loreEntry.content)
                            } else {
                                setVar(risuChatParser(effect.outputVar, {chara:char}), 'null')
                            }
                        }
                        break
                    }
                    case 'v2CreateLorebook':{
                        char.globalLore = char.globalLore ?? []
                        const name = effect.nameType === 'value' ? risuChatParser(effect.name,{chara:char}) : getVar(risuChatParser(effect.name,{chara:char}))
                        const key = effect.keyType === 'value' ? risuChatParser(effect.key,{chara:char}) : getVar(risuChatParser(effect.key,{chara:char}))
                        const content = effect.contentType === 'value' ? risuChatParser(effect.content,{chara:char}) : getVar(risuChatParser(effect.content,{chara:char}))
                        const insertOrder = effect.insertOrderType === 'value' ? Number(risuChatParser(effect.insertOrder,{chara:char})) : Number(getVar(risuChatParser(effect.insertOrder,{chara:char})))

                        char.globalLore.push({
                            key: key,
                            comment: name,
                            content: content,
                            mode: 'normal',
                            insertorder: Number.isNaN(insertOrder) ? 100 : insertOrder,
                            alwaysActive: false,
                            secondkey: "",
                            selective: false
                        })

                        const selectedCharId = get(selectedCharID)
                        const db = getDatabase()
                        db.characters[selectedCharId].globalLore = char.globalLore
                        setCurrentCharacter(char)
                        break
                    }
                    case 'v2ModifyLorebookByIndex':{
                        char.globalLore = char.globalLore ?? []
                        let index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))

                        if(Number.isNaN(index) || index < 0 || index >= char.globalLore.length || !char.globalLore[index]){
                            break
                        }

                        const currentLore = char.globalLore[index]

                        let name = effect.nameType === 'value' ? risuChatParser(effect.name,{chara:char}) : getVar(risuChatParser(effect.name,{chara:char}))
                        name = name.replace(/{{slot}}/g, currentLore.comment || '')
                        char.globalLore[index].comment = name

                        let key = effect.keyType === 'value' ? risuChatParser(effect.key,{chara:char}) : getVar(risuChatParser(effect.key,{chara:char}))
                        key = key.replace(/{{slot}}/g, currentLore.key || '')
                        char.globalLore[index].key = key

                        let content = effect.contentType === 'value' ? risuChatParser(effect.content,{chara:char}) : getVar(risuChatParser(effect.content,{chara:char}))
                        content = content.replace(/{{slot}}/g, currentLore.content || '')
                        char.globalLore[index].content = content

                        let insertOrder = effect.insertOrderType === 'value' ? risuChatParser(effect.insertOrder,{chara:char}) : getVar(risuChatParser(effect.insertOrder,{chara:char}))
                        insertOrder = insertOrder.replace(/{{slot}}/g, (currentLore.insertorder || 100).toString())
                        const insertOrderNum = Number(insertOrder)
                        if(!Number.isNaN(insertOrderNum)){
                            char.globalLore[index].insertorder = insertOrderNum
                        }

                        const selectedCharId = get(selectedCharID)
                        const db = getDatabase()
                        db.characters[selectedCharId].globalLore = char.globalLore
                        setCurrentCharacter(char)
                        break
                    }
                    case 'v2DeleteLorebookByIndex':{
                        char.globalLore = char.globalLore ?? []
                        let index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))

                        if(Number.isNaN(index) || index < 0 || index >= char.globalLore.length || !char.globalLore[index]){
                            break
                        }

                        char.globalLore.splice(index, 1)

                        const selectedCharId = get(selectedCharID)
                        const db = getDatabase()
                        db.characters[selectedCharId].globalLore = char.globalLore
                        setCurrentCharacter(char)
                        break
                    }
                    case 'v2GetLorebookCountNew':{
                        char.globalLore = char.globalLore ?? []
                        setVar(risuChatParser(effect.outputVar, {chara:char}), char.globalLore.length.toString())
                        break
                    }
                    case 'v2SetLorebookAlwaysActive':{
                        char.globalLore = char.globalLore ?? []
                        let index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))

                        if(Number.isNaN(index) || index < 0 || index >= char.globalLore.length || !char.globalLore[index]){
                            break
                        }

                        char.globalLore[index].alwaysActive = effect.value

                        const selectedCharId = get(selectedCharID)
                        const db = getDatabase()
                        db.characters[selectedCharId].globalLore = char.globalLore
                        setCurrentCharacter(char)
                        break
                    }
                    case 'v2RegexTest':{
                        try {
                            const value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                            const regexPattern = effect.regexType === 'value' ? risuChatParser(effect.regex,{chara:char}) : getVar(risuChatParser(effect.regex,{chara:char}))
                            const flags = effect.flagsType === 'value' ? risuChatParser(effect.flags,{chara:char}) : getVar(risuChatParser(effect.flags,{chara:char}))
                            const regex = new RegExp(regexPattern, flags)
                            const result = regex.test(value)
                            setVar(risuChatParser(effect.outputVar, {chara:char}), result ? '1' : '0')
                        } catch (error) {
                            setVar(risuChatParser(effect.outputVar, {chara:char}), '0')
                        }
                        break
                    }
                    case 'v2GetAuthorNote':{
                        setVar(risuChatParser(effect.outputVar, {chara:char}), chat.note ?? '')
                        break
                    }
                    case 'v2SetAuthorNote':{
                        const value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                        chat.note = value

                        if(!arg.displayMode){
                            const selectedCharId = get(selectedCharID)
                            const currentCharacter = getCurrentCharacter()
                            const db = getDatabase()
                            currentCharacter.chats[currentCharacter.chatPage].note = value
                            db.characters[selectedCharId].chats[currentCharacter.chatPage].note = value
                            setCurrentCharacter(currentCharacter)
                        }
                        break
                    }
                    case 'v2MakeDictVar':{
                        if(effect.var.startsWith('{') && effect.var.endsWith('}')){
                            return
                        }

                        setVar(risuChatParser(effect.var, {chara:char}), '{}')
                        break
                    }
                    case 'v2GetDictVar':{
                        try {
                            let varValue = effect.varType === 'value' ? risuChatParser(effect.var,{chara:char}) : getVar(risuChatParser(effect.var,{chara:char}))
                            let dict = JSON.parse(varValue)
                            let key = effect.keyType === 'value' ? risuChatParser(effect.key,{chara:char}) : getVar(risuChatParser(effect.key,{chara:char}))
                            setVar(risuChatParser(effect.outputVar, {chara:char}), dict[key] ?? 'null')
                        } catch (error) {
                            setVar(risuChatParser(effect.outputVar, {chara:char}), 'null')
                        }
                        break
                    }
                    case 'v2SetDictVar':{
                        try {
                            const value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                            const key = effect.keyType === 'value' ? risuChatParser(effect.key,{chara:char}) : getVar(risuChatParser(effect.key,{chara:char}))

                            if(effect.varType === 'value') {
                                break
                            }

                            let varValue = getVar(risuChatParser(effect.var,{chara:char}))
                            let dict = JSON.parse(varValue)
                            dict[key] = value
                            setVar(risuChatParser(effect.var, {chara:char}), JSON.stringify(dict))
                        } catch (error) {
                            if(effect.varType === 'var') {
                                const value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                                const key = effect.keyType === 'value' ? risuChatParser(effect.key,{chara:char}) : getVar(risuChatParser(effect.key,{chara:char}))
                                let dict = {}
                                dict[key] = value
                                setVar(risuChatParser(effect.var, {chara:char}), JSON.stringify(dict))
                            }
                        }
                        break
                    }
                    case 'v2DeleteDictKey':{
                        try {
                            if(effect.varType === 'value') {
                                break
                            }

                            let varValue = getVar(risuChatParser(effect.var,{chara:char}))
                            let dict = JSON.parse(varValue)
                            let key = effect.keyType === 'value' ? risuChatParser(effect.key,{chara:char}) : getVar(risuChatParser(effect.key,{chara:char}))
                            delete dict[key]
                            setVar(risuChatParser(effect.var, {chara:char}), JSON.stringify(dict))
                        } catch (error) {
                            if(effect.varType === 'var') {
                                setVar(risuChatParser(effect.var, {chara:char}), '{}')
                            }
                        }
                        break
                    }
                    case 'v2HasDictKey':{
                        try {
                            let varValue = effect.varType === 'value' ? risuChatParser(effect.var,{chara:char}) : getVar(risuChatParser(effect.var,{chara:char}))
                            let dict = JSON.parse(varValue)
                            let key = effect.keyType === 'value' ? risuChatParser(effect.key,{chara:char}) : getVar(risuChatParser(effect.key,{chara:char}))
                            setVar(risuChatParser(effect.outputVar, {chara:char}), Object.hasOwn(dict, key) ? '1' : '0')
                        } catch (error) {
                            setVar(risuChatParser(effect.outputVar, {chara:char}), '0')
                        }
                        break
                    }
                    case 'v2ClearDict':{
                        if(effect.var.startsWith('{') && effect.var.endsWith('}')){
                            return
                        }
                        setVar(risuChatParser(effect.var, {chara:char}), '{}')
                        break
                    }
                    case 'v2GetDictSize':{
                        try {
                            let varValue = effect.varType === 'value' ? risuChatParser(effect.var,{chara:char}) : getVar(risuChatParser(effect.var,{chara:char}))
                            let dict = JSON.parse(varValue)
                            setVar(risuChatParser(effect.outputVar, {chara:char}), Object.keys(dict).length.toString())
                        } catch (error) {
                            setVar(risuChatParser(effect.outputVar, {chara:char}), '0')
                        }
                        break
                    }
                    case 'v2GetDictKeys':{
                        try {
                            let varValue = effect.varType === 'value' ? risuChatParser(effect.var,{chara:char}) : getVar(risuChatParser(effect.var,{chara:char}))
                            let dict = JSON.parse(varValue)
                            let keys = Object.keys(dict)
                            setVar(risuChatParser(effect.outputVar, {chara:char}), JSON.stringify(keys))
                        } catch (error) {
                            setVar(risuChatParser(effect.outputVar, {chara:char}), '[]')
                        }
                        break
                    }
                    case 'v2GetDictValues':{
                        try {
                            let varValue = effect.varType === 'value' ? risuChatParser(effect.var,{chara:char}) : getVar(risuChatParser(effect.var,{chara:char}))
                            let dict = JSON.parse(varValue)
                            let values = Object.values(dict)
                            setVar(risuChatParser(effect.outputVar, {chara:char}), JSON.stringify(values))
                        } catch (error) {
                            setVar(risuChatParser(effect.outputVar, {chara:char}), '[]')
                        }
                        break
                    }
                    case 'v2Calculate':{
                        try {
                            let expression = effect.expressionType === 'value' ? risuChatParser(effect.expression,{chara:char}) : getVar(risuChatParser(effect.expression,{chara:char}))
                            expression = expression.replace(/\$([a-zA-Z0-9_]+)/g, (_, varName) => {
                                const varValue = getVar(varName)
                                const parsed = parseFloat(varValue)
                                return isNaN(parsed) ? '0' : parsed.toString()
                            })

                            const result = calcString(expression)
                            setVar(risuChatParser(effect.outputVar, {chara:char}), result.toString())
                        } catch (error) {
                            setVar(risuChatParser(effect.outputVar, {chara:char}), '0')
                        }
                        break
                    }
                    case 'v2ReplaceString':{
                        try {
                            const source = effect.sourceType === 'value' ? risuChatParser(effect.source,{chara:char}) : getVar(risuChatParser(effect.source,{chara:char}))
                            const regexPattern = effect.regexType === 'value' ? risuChatParser(effect.regex,{chara:char}) : getVar(risuChatParser(effect.regex,{chara:char}))
                            const resultFormat = effect.resultType === 'value' ? risuChatParser(effect.result,{chara:char}) : getVar(risuChatParser(effect.result,{chara:char}))
                            const replacement = effect.replacementType === 'value' ? risuChatParser(effect.replacement,{chara:char}) : getVar(risuChatParser(effect.replacement,{chara:char}))
                            const flags = effect.flagsType === 'value' ? risuChatParser(effect.flags,{chara:char}) : getVar(risuChatParser(effect.flags,{chara:char}))

                            const regex = new RegExp(regexPattern, flags)
                            const result = source.replace(regex, (...args) => {
                                const match = args[0]
                                const groups = args.slice(1, -2)

                                const targetGroupMatch = resultFormat.match(/^\$(\d+)$/)
                                if (targetGroupMatch) {
                                    const targetIndex = Number(targetGroupMatch[1])
                                    if (targetIndex === 0) {
                                        return replacement
                                    } else {
                                        const targetGroup = groups[targetIndex - 1]
                                        if (targetGroup) {
                                            return match.replace(targetGroup, replacement)
                                        }
                                    }
                                }

                                return resultFormat.replace(/\$[0-9]+/g, (placeholder) => {
                                    const index = Number(placeholder.slice(1))
                                    return index === 0 ? match : (groups[index - 1] || '')
                                }).replace(/\$&/g, match).replace(/\$\$/g, '$')
                            })
                            setVar(risuChatParser(effect.outputVar, {chara:char}), result)
                        } catch (error) {
                            const source = effect.sourceType === 'value' ? risuChatParser(effect.source,{chara:char}) : getVar(risuChatParser(effect.source,{chara:char}))
                            setVar(risuChatParser(effect.outputVar, {chara:char}), source)
                        }
                        break
                    }
                    case 'v2Comment':{
                        break
                    }
                }
            }
        }

        let caculatedTokens = 0
        if(additonalSysPrompt.start){
            caculatedTokens += await tokenize(additonalSysPrompt.start)
        }
        if(additonalSysPrompt.historyend){
            caculatedTokens += await tokenize(additonalSysPrompt.historyend)
        }
        if(additonalSysPrompt.promptend){
            caculatedTokens += await tokenize(additonalSysPrompt.promptend)
        }
        if(varChanged){
            const currentChat = getCurrentChat()
            currentChat.scriptstate = chat.scriptstate
            ReloadGUIPointer.set(get(ReloadGUIPointer) + 1)
        }

        if (shouldSetTriggerId && mode !== 'manual') {
            CurrentTriggerIdStore.set(previousTriggerId)
        }

        return {additonalSysPrompt, chat, tokens:caculatedTokens, stopSending, sendAIprompt, displayData: arg.displayData, tempVars: arg.tempVars}

    }

    // ── src/ts/process/scriptings.ts: Lua (runScripted and its API) ──────
    let luaFactory
    let ScriptingSafeIds = new Set()
    let ScriptingEditDisplayIds = new Set()
    let ScriptingLowLevelIds = new Set()
    let lastRequestResetTime = 0
    let lastRequestsCount = 0

    let ScriptingEngines = new Map()
    let luaFactoryPromise = null;
    let pendingEngineCreations = new Map();

    async function runScripted(code, arg

    ){
        const type = arg.type ?? 'lua'
        const char = arg.char ?? getCurrentCharacter()
        const data = arg.data ?? ''
        const setVar = arg.setVar ?? setChatVar
        const getVar = arg.getVar ?? getChatVar
        const meta = arg.meta ?? {}
        const mode = arg.mode ?? 'manual'

        let chat = arg.chat ?? getCurrentChat()
        let stopSending = false
        let lowLevelAccess = arg.lowLevelAccess ?? false

        if(type === 'lua'){
            await ensureLuaFactory()
        }
        let ScriptingEngineState = await getOrCreateEngineState(mode, type);

        return await ScriptingEngineState.mutex.runExclusive(async () => {
            ScriptingEngineState.chat = chat
            ScriptingEngineState.setVar = setVar
            ScriptingEngineState.getVar = getVar
            if (code !== ScriptingEngineState.code) {
                let declareAPI

                if(ScriptingEngineState.type === 'lua'){
                    ScriptingEngineState.engine?.global.close()
                    ScriptingEngineState.code = code
                    ScriptingEngineState.engine = await luaFactory.createEngine({injectObjects: true})
                    const luaEngine = ScriptingEngineState.engine
                    declareAPI = (name, func) => {
                        luaEngine.global.set(name, func)
                    }
                }
                if(ScriptingEngineState.type === 'py'){
                    console.log('Creating new Pyodide context for mode:', mode)
                    ScriptingEngineState.pyodide?.close()
                    ScriptingEngineState.pyodide = new PyodideContext()
                    declareAPI = (name, func) => {
                        ScriptingEngineState.pyodide?.declareAPI(name, func )
                    }
                }
                declareAPI('getChatVar', (id,key) => {
                    return ScriptingEngineState.getVar(key)
                })
                declareAPI('setChatVar', (id,key, value) => {
                    if(!ScriptingSafeIds.has(id) && !ScriptingEditDisplayIds.has(id)){
                        return
                    }
                    ScriptingEngineState.setVar(key, value)
                })
                declareAPI('setChatVarChanged', (id,key, value) => {
                    if(!ScriptingSafeIds.has(id) && !ScriptingEditDisplayIds.has(id)){
                        return
                    }
                    if(ScriptingEngineState.setVar(key, value) === true){
                        return true
                    }
                })
                declareAPI('getGlobalVar', (id, key) => {
                    return getGlobalChatVar(key)
                })
                declareAPI('stopChat', (id) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    stopSending = true
                })
                declareAPI('alertError', (id, value) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    alertError(value)
                })
                declareAPI('alertNormal', (id, value) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    alertNormal(value)
                })
                declareAPI('alertInput', (id, value) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    return alertInput(value)
                })
                declareAPI('alertSelect', (id, value) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    return alertSelect(value)
                })
                declareAPI('alertConfirm', (id, value) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    return alertConfirm(value).then(res => res ? true : false)
                })

                declareAPI('getChatMain', (id, index) => {
                    const chat = ScriptingEngineState.chat.message.at(index)
                    if(!chat){
                        return JSON.stringify(null)
                    }
                    const data = {
                        role: chat.role,
                        data: chat.data,
                        time: chat.time ?? 0
                    }
                    return JSON.stringify(data)
                })

                declareAPI('getChatData', (id, index) => {
                    const chat = ScriptingEngineState.chat.message.at(index)
                    return chat?.data ?? ''
                })

                declareAPI('getChatRole', (id, index) => {
                    const chat = ScriptingEngineState.chat.message.at(index)
                    return chat?.role ?? ''
                })

                declareAPI('getRecentChatsMain', (id, count) => {
                    const chats = ScriptingEngineState.chat.message
                    const safeCount = Math.max(0, Math.floor(count || 0))
                    const start = Math.max(0, chats.length - safeCount)
                    return JSON.stringify(chats.slice(start).map((v) => ({
                        role: v.role,
                        data: v.data,
                        time: v.time ?? 0,
                    })))
                })

                declareAPI('setChat', (id, index, value) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    const message = ScriptingEngineState.chat.message?.at(index)
                    if(message){
                        message.data = value ?? ''
                    }
                })
                declareAPI('setChatRole', (id, index, value) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    const message = ScriptingEngineState.chat.message?.at(index)
                    if(message){
                        message.role = value === 'user' ? 'user' : 'char'
                    }
                })
                declareAPI('cutChat', (id, start, end) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    ScriptingEngineState.chat.message = ScriptingEngineState.chat.message.slice(start,end)
                })
                declareAPI('removeChat', (id, index) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    ScriptingEngineState.chat.message.splice(index, 1)
                })
                declareAPI('addChat', (id, role, value) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    let roleData = role === 'user' ? 'user' : 'char'
                    ScriptingEngineState.chat.message.push({role: roleData, data: value ?? ''})
                })
                declareAPI('insertChat', (id, index, role, value) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    let roleData = role === 'user' ? 'user' : 'char'
                    ScriptingEngineState.chat.message.splice(index, 0, {role: roleData, data: value ?? ''})
                })

                declareAPI('getTokens', async (id, value) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    return await tokenize(value)
                })

                declareAPI('getChatLength', (id) => {
                    return ScriptingEngineState.chat.message.length
                })

                declareAPI('getFullChatMain', (id) => {
                    const data = JSON.stringify(ScriptingEngineState.chat.message.map((v) => {
                        return {
                            role: v.role,
                            data: v.data,
                            time: v.time ?? 0
                        }
                    }))
                    return data
                })

                declareAPI('sleep', (id, time) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    return new Promise((resolve) => {
                        setTimeout(() => {
                            resolve(true)
                        }, time)
                    })
                })

                declareAPI('cbs', (value) => {
                    return risuChatParser(value, { chara: getCurrentCharacter() })
                })

                declareAPI('setFullChatMain', (id, value) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    const realValue = JSON.parse(value)

                    ScriptingEngineState.chat.message = realValue.map((v) => {
                        return {
                            role: v.role,
                            data: v.data
                        }
                    })
                })

                declareAPI('logMain', (value) => {
                    console.log(JSON.parse(value))
                })

                declareAPI('reloadDisplay', (id) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    ReloadGUIPointer.set(get(ReloadGUIPointer) + 1)
                })

                declareAPI('reloadChat', (id, index) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    ReloadChatPointer.update((v) => {
                        v[index] = (v[index] ?? 0) + 1
                        return v
                    })
                })

                //Low Level Access
                declareAPI('similarity', async (id, source, value) => {
                    if(!ScriptingLowLevelIds.has(id)){
                        return
                    }
                    const processer = new HypaProcesser()
                    await processer.addText(value)
                    return await processer.similaritySearch(source)
                })

                declareAPI('request', async (id, url) => {
                    if(!ScriptingLowLevelIds.has(id)){
                        return
                    }

                    if(lastRequestResetTime + 60000 < Date.now()){
                        lastRequestsCount = 0
                        lastRequestResetTime = Date.now()
                    }

                    if(lastRequestsCount > 5){
                        return JSON.stringify({
                            status: 429,
                            data: 'Too many requests. you can request 5 times per minute'
                        })
                    }

                    lastRequestsCount++

                    try {
                        //for security and other reasons, only get request in 120 char is allowed
                        if(url.length > 120){
                            return JSON.stringify({
                                status: 413,
                                data: 'URL to large. max is 120 characters'
                            })
                        }

                        if(!url.startsWith('https://')){
                            return JSON.stringify({
                                status: 400,
                                data: "Only https requests are allowed"
                            })
                        }

                        const bannedURL = [
                            "https://realm.risuai.net",
                            "https://risuai.net",
                            "https://risuai.xyz"
                        ]

                        for(const burl of bannedURL){

                            if(url.startsWith(burl)){
                                return JSON.stringify({
                                    status: 400,
                                    data: "request to " + url + ' is not allowed'
                                })
                            }
                        }

                        //browser fetch
                        const d = await fetchNative(url, {
                            method: "GET"
                        })
                        const text = await d.text()
                        return JSON.stringify({
                            status: d.status,
                            data: text
                        })

                    } catch (error) {
                        return JSON.stringify({
                            status: 400,
                            data: 'internal error'
                        })
                    }
                })

                declareAPI('generateImage', async (id, value, negValue = '') => {
                    if(!ScriptingLowLevelIds.has(id)){
                        return
                    }
                    const gen = await generateAIImage(value, char , negValue, 'inlay')
                    if(!gen){
                        return 'Error: Image generation failed'
                    }
                    const imgHTML = new Image()
                    imgHTML.src = gen
                    const inlay = await writeInlayImage(imgHTML)
                    return `{{inlay::${inlay}}}`
                })

                declareAPI('getCharacterImageMain', async (id) => {
                    try {
                        const db = getDatabase()
                        const selectedChar = get(selectedCharID)

                        if (selectedChar < 0 || selectedChar >= db.characters.length) {
                            return ''
                        }

                        const character = db.characters[selectedChar]

                        if (!character || character.type === 'group' || !character.image) {
                            return ''
                        }

                        const img = await readImage(character.image)
                        const imgObj = new Image()
                        const extention = character.image.split('.').at(-1)

                        imgObj.src = URL.createObjectURL(new Blob([asBuffer(img)], {type: `image/${extention}`}))

                        const imgid = await writeInlayImage(imgObj, { name: character.image, ext: extention, id: character.image})

                        if (imgid) {
                            return `{{inlayed::${imgid}}}`
                        }
                        console.warn('Failed to create character image inlay')
                        return ''
                    } catch (error) {
                        console.error('Error in getCharacterImageMain:', error)
                        return ''
                    }
                })

                declareAPI('getPersonaImageMain', async (id) => {
                    try {
                        const icon = getUserIcon()

                        if(!icon) {
                            return ''
                        }

                        const img = await readImage(icon)
                        const imgObj = new Image()
                        const extention = icon.split('.').at(-1)

                        imgObj.src = URL.createObjectURL(new Blob([asBuffer(img)], {type: `image/${extention}`}))

                        const imgid = await writeInlayImage(imgObj, { name: icon, ext: extention, id: icon})

                        if (imgid) {
                            return `{{inlayed::${imgid}}}`
                        }

                        console.warn('Failed to create character image inlay')
                        return ''
                    } catch (error) {
                        console.error('Error in getCharacterImageMain:', error)
                        return ''
                    }
                })

                declareAPI('hash', async (id, value) => {
                    return await hasher(new TextEncoder().encode(value))
                })

                const parseLuaOptions = (optionsStr) => {
                    if (!optionsStr) {
                        return {};
                    }

                    try {
                        const parsed = JSON.parse(optionsStr);
                        return parsed && typeof parsed === 'object' ? parsed : {};
                    } catch {
                        return {};
                    }
                };

                const collectLuaStreamText = async (stream) => {
                    const reader = stream.getReader();
                    let text = '';

                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) {
                                break;
                            }
                            if (value && typeof value['0'] === 'string') {
                                text = value['0'];
                            }
                        }
                    } finally {
                        reader.releaseLock();
                    }

                    return text;
                };

                declareAPI('LLMMain', async (id, promptStr, useMultimodal = false, optionsStr = '') => {
                    let prompt = JSON.parse(promptStr)
                    if(!ScriptingLowLevelIds.has(id)){
                        return
                    }
                    let promptbody = prompt.map((dict) => {
                        let role = 'assistant'
                        switch(dict['role']){
                            case 'system':
                            case 'sys':
                                role = 'system'
                                break
                            case 'user':
                                role = 'user'
                                break
                            case 'assistant':
                            case 'bot':
                            case 'char':{
                                role = 'assistant'
                                break
                            }
                        }

                        return {
                            content: dict['content'] ?? '',
                            role: role,
                        }
                    })

                    if(useMultimodal) {
                        for(const msg of promptbody) {
                            const inlays = []
                            msg.content = msg.content.replace(/{{(inlay|inlayed|inlayeddata)::(.+?)}}/g, (
                                match,
                                p1,
                                p2
                            ) => {
                                if(msg.role === 'assistant') {
                                    if(p2 && p1 === 'inlayeddata') {
                                        inlays.push(p2)
                                    }
                                }
                                else {
                                    if(p2) {
                                        inlays.push(p2)
                                    }
                                }
                                return ''
                            })

                            const multimodals = []
                            for(const inlay of inlays) {
                                const inlayData = await getInlayAsset(inlay)
                                multimodals.push({
                                    type: inlayData?.type,
                                    base64: inlayData?.data,
                                    width: inlayData?.width,
                                    height: inlayData?.height
                                })
                            }

                            msg.multimodals = multimodals.length > 0 ? multimodals : undefined
                        }
                    }

                    const options = parseLuaOptions(optionsStr)
                    const result = await requestChatData({
                        formated: promptbody,
                        bias: {},
                        useStreaming: options.streaming === true,
                        forceStreaming: options.streaming === true,
                        noMultiGen: true,
                    }, 'model')

                    if(result.type === 'fail'){
                        return JSON.stringify({
                            success: false,
                            result: 'Error: ' + result.result
                        })
                    }

                    if(result.type === 'streaming'){
                        try {
                            return JSON.stringify({
                                success: true,
                                result: await collectLuaStreamText(result.result)
                            })
                        } catch (error) {
                            return JSON.stringify({
                                success: false,
                                result: 'Error: ' + error
                            })
                        }
                    }

                    if(result.type === 'multiline'){
                        return JSON.stringify({
                            success: false,
                            result: result.result
                        })
                    }

                    return JSON.stringify({
                        success: true,
                        result: result.result
                    })
                })

                declareAPI('simpleLLM', async (id, prompt) => {
                    if(!ScriptingLowLevelIds.has(id)){
                        return
                    }
                    const result = await requestChatData({
                        formated: [{
                            role: 'user',
                            content: prompt
                        }],
                        bias: {},
                        useStreaming: false,
                        noMultiGen: true,
                    }, 'model')

                    if(result.type === 'fail'){
                        return {
                            success: false,
                            result: 'Error: ' + result.result
                        }
                    }

                    if(result.type === 'streaming' || result.type === 'multiline'){
                        return {
                            success: false,
                            result: result.result
                        }
                    }

                    return {
                        success: true,
                        result: result.result
                    }
                })

                declareAPI('getName', (id) => {
                    const db = getDatabase()
                    const selectedChar = get(selectedCharID)
                    const char = db.characters[selectedChar]
                    return char.name
                })

                declareAPI('setName', (id, name) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    const selectedChar = get(selectedCharID)
                    if(typeof name !== 'string'){
                        throw('Invalid data type')
                    }
                    DBState.db.characters[selectedChar].name = name
                })

                declareAPI('getDescription', (id) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    const selectedChar = get(selectedCharID)
                    const char = DBState.db.characters[selectedChar]
                    if(char.type === 'group'){
                        throw('Character is a group')
                    }
                    return char.desc
                })

                declareAPI('setDescription', (id, desc) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    const selectedChar = get(selectedCharID)
                    const char = DBState.db.characters[selectedChar]
                    if(typeof data !== 'string'){
                        throw('Invalid data type')
                    }
                    if(char.type === 'group'){
                        throw('Character is a group')
                    }
                    char.desc = desc
                    DBState.db.characters[selectedChar] = char
                })

                declareAPI('getCharacterFirstMessage', (id) => {
                    const selectedChar = get(selectedCharID)
                    const char = DBState.db.characters[selectedChar]
                    return char.firstMessage
                })

                declareAPI('setCharacterFirstMessage', (id, data) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    const db = getDatabase()
                    const selectedChar = get(selectedCharID)
                    const char = db.characters[selectedChar]
                    if(typeof data !== 'string'){
                        return false
                    }
                    char.firstMessage = data
                    DBState.db.characters[selectedChar] = char
                    return true
                })

                declareAPI('getPersonaName', (id) => {
                    return getUserName()
                })

                declareAPI('getPersonaDescription', (id) => {
                    const db = getDatabase()
                    const selectedChar = get(selectedCharID)
                    const char = db.characters[selectedChar]

                    return risuChatParser(getPersonaPrompt(), { chara: char })
                })

                declareAPI('getAuthorsNote', (id) => {
                    return ScriptingEngineState.chat?.note ?? ''
                })

                declareAPI('getBackgroundEmbedding', (id) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    const db = getDatabase()
                    const selectedChar = get(selectedCharID)
                    const char = db.characters[selectedChar]
                    return char.backgroundHTML
                })

                declareAPI('setBackgroundEmbedding', (id, data) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }
                    const db = getDatabase()
                    const selectedChar = get(selectedCharID)
                    if(typeof data !== 'string'){
                        return false
                    }
                    DBState.db.characters[selectedChar].backgroundHTML = data
                    return true
                })

                // Lore books
                declareAPI('getLoreBooksMain', (id, search) => {
                    const db = getDatabase()
                    const selectedChar = db.characters[get(selectedCharID)]
                    if (selectedChar.type !== 'character') {
                        return
                    }

                    const loreSources = [
                        selectedChar.chats[selectedChar.chatPage]?.localLore ?? [],
                        selectedChar.globalLore,
                        getModuleLorebooks()
                    ]

                    const found = []
                    for (const source of loreSources) {
                        for (const b of source) {
                            if (b.comment === search) {
                                found.push({ ...b, content: risuChatParser(b.content, { chara: selectedChar }) })
                            }
                        }
                    }

                    return JSON.stringify(found)
                })



                declareAPI('upsertLocalLoreBook', (id, name, content, options) => {
                    if(!ScriptingSafeIds.has(id)){
                        return
                    }

                    if (char.type !== 'character') {
                        return
                    }

                    const {
                        alwaysActive = false,
                        insertOrder = 100,
                        key = '',
                        regex = false,
                        secondKey = '',
                    } = options

                    const currentChat = char.chats[char.chatPage]

                    const newLocalLoreBooks = currentChat.localLore.filter((book) => book.comment !== name)
                    newLocalLoreBooks.push({
                        alwaysActive,
                        comment: name,
                        content: content,
                        insertorder: insertOrder,
                        mode: 'normal',
                        key,
                        secondkey: secondKey,
                        selective: !!secondKey,
                        useRegex: regex,
                    })
                    currentChat.localLore = newLocalLoreBooks
                })

                declareAPI('loadLoreBooksMain', async (id, reserve) => {
                    if(!ScriptingLowLevelIds.has(id)){
                        return
                    }

                    const db = getDatabase()

                    const selectedChar = db.characters[get(selectedCharID)]

                    if (selectedChar.type !== 'character') {
                        return
                    }

                    const fullLoreBooks = (await loadLoreBookV3Prompt()).actives
                    const maxContext = db.maxContext - reserve
                    if (maxContext < 0) {
                        return JSON.stringify([])
                    }

                    let totalTokens = 0
                    const loreBooks = []

                    for (const book of fullLoreBooks) {
                        const parsed = risuChatParser(book.prompt, { chara: selectedChar }).trim()
                        if (parsed.length === 0) {
                            continue
                        }

                        const tokens = await tokenize(parsed)

                        if (totalTokens + tokens > maxContext) {
                            break
                        }
                        totalTokens += tokens
                        loreBooks.push({
                            data: parsed,
                            role: book.role === 'assistant' ? 'char' : book.role,
                        })
                    }

                    return JSON.stringify(loreBooks)
                })

                declareAPI('axLLMMain', async (id, promptStr, useMultimodal = false, optionsStr = '') => {
                    let prompt = JSON.parse(promptStr)
                    if(!ScriptingLowLevelIds.has(id)){
                        return
                    }
                    let promptbody = prompt.map((dict) => {
                        let role = 'assistant'
                        switch(dict['role']){
                            case 'system':
                            case 'sys':
                                role = 'system'
                                break
                            case 'user':
                                role = 'user'
                                break
                            case 'assistant':
                            case 'bot':
                            case 'char':{
                                role = 'assistant'
                                break
                            }
                        }

                        return {
                            content: dict['content'] ?? '',
                            role: role,
                        }
                    })

                    if(useMultimodal) {
                        for(const msg of promptbody) {
                            const inlays = []
                            msg.content = msg.content.replace(/{{(inlay|inlayed|inlayeddata)::(.+?)}}/g, (
                                match,
                                p1,
                                p2
                            ) => {
                                if(msg.role === 'assistant') {
                                    if(p2 && p1 === 'inlayeddata') {
                                        inlays.push(p2)
                                    }
                                }
                                else {
                                    if(p2) {
                                        inlays.push(p2)
                                    }
                                }
                                return ''
                            })

                            const multimodals = []
                            for(const inlay of inlays) {
                                const inlayData = await getInlayAsset(inlay)
                                multimodals.push({
                                    type: inlayData?.type,
                                    base64: inlayData?.data,
                                    width: inlayData?.width,
                                    height: inlayData?.height
                                })
                            }

                            msg.multimodals = multimodals.length > 0 ? multimodals : undefined
                        }
                    }

                    const options = parseLuaOptions(optionsStr)
                    const modes = new Set(['emotion', 'memory', 'otherAx', 'submodel', 'translate'])
                    const mode = options.mode ?? 'otherAx'
                    if (!modes.has(mode)) {
                        return JSON.stringify({
                            result: 'Error: Invalid axLLM mode: ' + mode,
                            success: false
                        })
                    }
                    const result = await requestChatData({
                        formated: promptbody,
                        bias: {},
                        useStreaming: options.streaming === true,
                        forceStreaming: options.streaming === true,
                        noMultiGen: true,
                    }, mode )

                    if(result.type === 'fail'){
                        return JSON.stringify({
                            success: false,
                            result: 'Error: ' + result.result
                        })
                    }

                    if(result.type === 'streaming'){
                        try {
                            return JSON.stringify({
                                success: true,
                                result: await collectLuaStreamText(result.result)
                            })
                        } catch (error) {
                            return JSON.stringify({
                                success: false,
                                result: 'Error: ' + error
                            })
                        }
                    }

                    if(result.type === 'multiline'){
                        return JSON.stringify({
                            success: false,
                            result: result.result
                        })
                    }

                    return JSON.stringify({
                        success: true,
                        result: result.result
                    })
                })

                declareAPI('getCharacterLastMessage', (id) => {
                    const chat = ScriptingEngineState.chat
                    if (!chat) {
                        return ''
                    }

                    const db = getDatabase()
                    const selchar = db.characters[get(selectedCharID)]

                    let pointer = chat.message.length - 1
                    while (pointer >= 0) {
                        if (chat.message[pointer].role === 'char') {
                            const messageData = chat.message[pointer].data
                            return messageData
                        }
                        pointer--
                    }

                    return selchar.firstMessage
                })

                declareAPI('getUserLastMessage', (id) => {
                    const chat = ScriptingEngineState.chat
                    if (!chat) {
                        return ''
                    }

                    let pointer = chat.message.length - 1
                    while (pointer >= 0) {
                        if (chat.message[pointer].role === 'user') {
                            const messageData = chat.message[pointer].data
                            return messageData
                        }
                        pointer--
                    }

                    return ''
                })

                declareAPI('getCharacterLastMessage', (id) => {
                    const chat = ScriptingEngineState.chat
                    if (!chat) {
                        return ''
                    }

                    const db = getDatabase()
                    const selchar = db.characters[get(selectedCharID)]

                    let pointer = chat.message.length - 1
                    while (pointer >= 0) {
                        if (chat.message[pointer].role === 'char') {
                            const messageData = chat.message[pointer].data
                            return messageData
                        }
                        pointer--
                    }

                    return selchar.firstMessage
                })

                declareAPI('getUserLastMessage', (id) => {
                    const chat = ScriptingEngineState.chat
                    if (!chat) {
                        return ''
                    }

                    let pointer = chat.message.length - 1
                    while (pointer >= 0) {
                        if (chat.message[pointer].role === 'user') {
                            const messageData = chat.message[pointer].data
                            return messageData
                        }
                        pointer--
                    }
                    return ''
                })

                if(ScriptingEngineState.type === 'lua'){
                    await ScriptingEngineState.engine?.doString(luaCodeWrapper(code))
                }
                if(ScriptingEngineState.type === 'py'){
                    await ScriptingEngineState.pyodide?.init(code)
                }
                ScriptingEngineState.code = code
            }
            let accessKey = v4()
            if(mode === 'editDisplay'){
                ScriptingEditDisplayIds.add(accessKey)
            }
            else{
                ScriptingSafeIds.add(accessKey)
                if(lowLevelAccess){
                    ScriptingLowLevelIds.add(accessKey)
                }
            }
            let res
            if(ScriptingEngineState.type === 'lua'){
                const luaEngine = ScriptingEngineState.engine
                try {
                    switch(mode){
                        case 'input':{
                            const func = luaEngine.global.get('onInput')
                            if(func){
                                res = await func(accessKey)
                            }
                            break
                        }
                        case 'output':{
                            const func = luaEngine.global.get('onOutput')
                            if(func){
                                res = await func(accessKey)
                            }
                            break
                        }
                        case 'start':{
                            const func = luaEngine.global.get('onStart')
                            if(func){
                                res = await func(accessKey)
                            }
                            break
                        }
                        case 'onButtonClick':{
                            const func = luaEngine.global.get('onButtonClick')
                            if(func){
                                res = await func(accessKey, data)
                            }
                            break
                        }
                        case 'editRequest':
                        case 'editDisplay':
                        case 'editInput':
                        case 'editOutput':{
                            const func = luaEngine.global.get('callListenMain')
                            if(func){
                                res = await func(mode, accessKey, JSON.stringify(data), JSON.stringify(meta))
                                res = JSON.parse(res)
                            }
                            break
                        }
                        default:{
                            const func = luaEngine.global.get(mode)
                            if(func){
                                res = await func(accessKey)
                            }
                            break
                        }
                    }
                    if(res === false){
                        stopSending = true
                    }
                } catch (error) {
                    console.error(error)
                }
            }
            if(ScriptingEngineState.type === 'py'){
                switch(mode){
                    case 'input':{
                        res = await ScriptingEngineState.pyodide?.python(`onInput('${accessKey}')`)
                        break
                    }
                    case 'output':{
                        res = await ScriptingEngineState.pyodide?.python(`onOutput('${accessKey}')`)
                        break
                    }
                    case 'start':{
                        res = await ScriptingEngineState.pyodide?.python(`onStart('${accessKey}')`)
                        break
                    }
                    case 'onButtonClick':{
                        res = await ScriptingEngineState.pyodide?.python(`onButtonClick('${accessKey}', '${data }')`)
                        break
                    }
                    case 'editRequest':
                    case 'editDisplay':
                    case 'editInput':
                    case 'editOutput':{
                        res = await ScriptingEngineState.pyodide?.python(`callListenMain('${mode}', '${accessKey}', '${JSON.stringify(data)}', '${JSON.stringify(meta)}')`)
                        res = JSON.parse(res)
                        break
                    }
                    default:{
                        res = await ScriptingEngineState.pyodide?.python(`${mode}('${accessKey}')`)
                        break
                    }
                }
            }
            ScriptingSafeIds.delete(accessKey)
            ScriptingLowLevelIds.delete(accessKey)
            chat = ScriptingEngineState.chat

            return {
                stopSending, chat, res
            }
        })
    }

    // DumDum: the page builds the factory (wasmoon + RisuAI's json.lua).
    async function makeLuaFactory(){
        luaFactory = await HOST.luaFactory()
    }

    async function ensureLuaFactory() {
        if (luaFactory) return;

        if (luaFactoryPromise) {
            try {
                await luaFactoryPromise;
            } catch (error) {
                luaFactoryPromise = null;
            }
            return;
        }

        try {
            luaFactoryPromise = makeLuaFactory();
            await luaFactoryPromise;
        } finally {
            luaFactoryPromise = null;
        }
    }

    async function getOrCreateEngineState(
        mode,
        type
    ) {
        let engineState = ScriptingEngines.get(mode);
        if (engineState) {
            return engineState;
        }

        let pendingCreation = pendingEngineCreations.get(mode);
        if (pendingCreation) {
            return pendingCreation;
        }

        const creationPromise = (() => {
            const engineState = {
                mutex: new Mutex(),
                type: type,
            };
            ScriptingEngines.set(mode, engineState);

            pendingEngineCreations.delete(mode);

            return Promise.resolve(engineState);
        })();

        pendingEngineCreations.set(mode, creationPromise);

        return creationPromise;
    }

    function luaCodeWrapper(code){
        return `
    json = require 'json'

    function getChat(id, index)
        return json.decode(getChatMain(id, index))
    end

    function getFullChat(id)
        return json.decode(getFullChatMain(id))
    end

    function getRecentChats(id, count)
        return json.decode(getRecentChatsMain(id, count))
    end

    function setFullChat(id, value)
        setFullChatMain(id, json.encode(value))
    end

    function log(value)
        logMain(json.encode(value))
    end

    function getLoreBooks(id, search)
        return json.decode(getLoreBooksMain(id, search))
    end

    function loadLoreBooks(id)
        return json.decode(loadLoreBooksMain(id):await())
    end

    function LLM(id, prompt, useMultimodal, options)
        useMultimodal = useMultimodal or false
        options = options or {}
        return json.decode(LLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())
    end

    function axLLM(id, prompt, useMultimodal, options)
        useMultimodal = useMultimodal or false
        options = options or {}
        return json.decode(axLLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())
    end

    function getCharacterImage(id)
        return getCharacterImageMain(id):await()
    end

    function getPersonaImage(id)
        return getPersonaImageMain(id):await()
    end

    local editRequestFuncs = {}
    local editDisplayFuncs = {}
    local editInputFuncs = {}
    local editOutputFuncs = {}

    function listenEdit(type, func)
        if type == 'editRequest' then
            editRequestFuncs[#editRequestFuncs + 1] = func
            return
        end

        if type == 'editDisplay' then
            editDisplayFuncs[#editDisplayFuncs + 1] = func
            return
        end

        if type == 'editInput' then
            editInputFuncs[#editInputFuncs + 1] = func
            return
        end

        if type == 'editOutput' then
            editOutputFuncs[#editOutputFuncs + 1] = func
            return
        end

        throw('Invalid type')
    end

    function getState(id, name)
        local escapedName = "__"..name
        return json.decode(getChatVar(id, escapedName))
    end

    function setState(id, name, value)
        local escapedName = "__"..name
        setChatVar(id, escapedName, json.encode(value))
    end

    function setStateChanged(id, name, value)
        local escapedName = "__"..name
        return setChatVarChanged(id, escapedName, json.encode(value))
    end

    function async(callback)
        return function(...)
            local co = coroutine.create(callback)
            local safe, result = coroutine.resume(co, ...)

            return Promise.create(function(resolve, reject)
                local checkresult
                local step = function()
                    if coroutine.status(co) == "dead" then
                        local send = safe and resolve or reject
                        return send(result)
                    end

                    safe, result = coroutine.resume(co)
                    checkresult()
                end

                checkresult = function()
                    if safe and result == Promise.resolve(result) then
                        result:finally(step)
                    else
                        step()
                    end
                end

                checkresult()
            end)
        end
    end

    callListenMain = async(function(type, id, value, meta)
        local realValue = json.decode(value)
        local realMeta = json.decode(meta)

        if type == 'editRequest' then
            for _, func in ipairs(editRequestFuncs) do
                realValue = func(id, realValue, realMeta)
            end
        end

        if type == 'editDisplay' then
            for _, func in ipairs(editDisplayFuncs) do
                realValue = func(id, realValue, realMeta)
            end
        end

        if type == 'editInput' then
            for _, func in ipairs(editInputFuncs) do
                realValue = func(id, realValue, realMeta)
            end
        end

        if type == 'editOutput' then
            for _, func in ipairs(editOutputFuncs) do
                realValue = func(id, realValue, realMeta)
            end
        end

        return json.encode(realValue)
    end)

    ${code}
    `
    }

    async function runLuaEditTrigger(char, mode, content, meta){
        switch(mode){
            case 'editinput':
                mode = 'editInput'
                break
            case 'editoutput':
                mode = 'editOutput'
                break
            case 'editdisplay':
                mode = 'editDisplay'
                break
            case 'editprocess':
                return content
        }

        try {
            let data = content

            const triggers = char.type === 'group' ? (getModuleTriggers()) : (char.triggerscript.map((v) => {
                v.lowLevelAccess = false
                return v
            }).concat(getModuleTriggers()))

            for(let trigger of triggers){
                if(trigger?.effect?.[0]?.type === 'triggerlua'){
                    const runResult = await runScripted(trigger.effect[0].code, {
                        char: char,
                        lowLevelAccess: false,
                        mode: mode,
                        data,
                        meta,
                    })
                    data = runResult.res ?? data
                }
            }


            return data
        } catch (error) {
            return content
        }
    }

    async function runLuaButtonTrigger(char, data){
        let runResult
        try {
            const triggers = char.type === 'group' ? getModuleTriggers() : char.triggerscript.map((v) => ({
                ...v,
                lowLevelAccess: char.type !== 'simple' ? char.lowLevelAccess ?? false : false
            })).concat(getModuleTriggers())

            for(let trigger of triggers){
                if(trigger?.effect?.[0]?.type === 'triggerlua'){
                    runResult = await runScripted(trigger.effect[0].code, {
                        char: char,
                        lowLevelAccess: trigger.lowLevelAccess,
                        mode: 'onButtonClick',
                        data: data
                    })
                }
            }
        } catch (error) {
            throw(error)
        }
        return runResult
    }

    // ── Entry points ─────────────────────────────────────────────────────
    const ctxs = new Map();     // key → view
    const withCtx = (key, seed, fn) => {
        const c = ctxs.get(key);
        if (!c) return null;
        CUR = c;
        c.vars0 = c.vars;
        c.vars = Object.assign({}, c.vars);      // a job never changes the stored variables
        _rng = seed ? seeded(String(seed)) : Math.random;
        try { return fn(c); }
        finally { c.vars = c.vars0; _rng = Math.random; CUR = null; }
    };

    return {
        setCtx(key, c) { ctxs.set(key, view(c)); },
        dropCtx(key) { ctxs.delete(key); },
        /** Plain CBS (what RisuAI does to a text without a message index). */
        parse(key, text, o) {
            o = o || {};
            const r = withCtx(key, o.seed, () => risuChatParser(String(text), { chatID: o.chatID == null ? -1 : o.chatID, cbsConditions: o.cbs || {} }));
            return r == null ? String(text) : r;
        },
        /** A message on screen: Chat.svelte's displaya() (CBS with rmVar and
         *  visualize), then ParseMarkdown's editdisplay pass. o = {chatID,
         *  role, firstmsg, seed}; hooks = {skip: Set, onScript(i, name)}. */
        display(key, text, o, hooks) {
            o = o || {};
            const r = withCtx(key, o.seed, () => {
                const cbsConditions = { firstmsg: !!o.firstmsg, chatRole: o.role || null };
                const chatID = o.chatID == null ? -1 : o.chatID;
                let data = risuChatParser(String(text), { chatID, rmVar: true, visualize: true, cbsConditions });
                return processScriptFull(data, 'editdisplay', chatID, cbsConditions, hooks).data;
            });
            return r == null ? String(text) : r;
        },
        /** A script pass that is not the screen: o.mode 'editinput' |
         *  'editoutput' | 'editprocess'. processScriptFull parses CBS first;
         *  o.pre ('history') is the extra parse RisuAI does on each history
         *  message before editprocess (risuChatParser with the character and the
         *  role); o.rmVar drops {{setvar}} and friends (they already ran). */
        script(key, text, o, hooks) {
            o = o || {};
            const r = withCtx(key, o.seed, (c) => {
                const chatID = o.chatID == null ? -1 : o.chatID;
                let data = String(text);
                if (o.pre === 'history') data = risuChatParser(data, { chara: c.char, role: o.role, rmVar: !!o.rmVar });
                return processScriptFull(data, o.mode, chatID, { chatRole: o.role || null }, hooks).data;
            });
            return r == null ? String(text) : r;
        },
        /** RisuAI's runCurrentChatFunction: CBS with runVar over messages, in
         *  order, so {{setvar}}/{{addvar}} change the variables. list =
         *  [{text, chatID}]. Returns the variables after the last one. */
        runVars(key, list) {
            const c = ctxs.get(key);
            if (!c) return null;
            CUR = c;
            const vars = Object.assign({}, c.vars);
            const keep = c.vars;
            c.vars = vars;
            try {
                for (const it of list || []) {
                    try { risuChatParser(String(it.text), { chara: c.char, chatID: it.chatID == null ? -1 : it.chatID, runVar: true }); }
                    catch (e) { /* one message does not stop the others */ }
                }
                return Object.assign({}, vars);
            } finally { c.vars = keep; CUR = null; }
        },
        /** Page side of the triggers: alerts, warn(what), reload(). */
        setHost(h) { HOST = h || {}; },
        /** RisuAI's runTrigger on this context (mode 'start' | 'input' |
         *  'output' | 'manual'; o = { manualName, triggerId }). The chat it
         *  sees is a copy: returns { messages, vars, sys, stop } (messages =
         *  the chat after the triggers, RisuAI's roles), or null without
         *  triggers. Run one at a time: the context stays set across awaits. */
        async trigger(key, mode, o) {
            o = o || {};
            const c = ctxs.get(key);
            if (!c || !Array.isArray(c.char.triggerscript) || !c.char.triggerscript.length) return null;
            const scriptstate = {};
            for (const [k, v] of Object.entries(c.vars)) scriptstate['$' + k] = v;
            const chat = {
                message: c.chat.message.map(m => Object.assign({}, m)), scriptstate,
                fmIndex: c.chat.fmIndex, localLore: [], note: c.chat.note || '',
            };
            const keep = c.vars;
            CUR = c;
            CURCHAT = { scriptstate };
            // CBS inside a trigger reads the variables the trigger is changing.
            c.vars = new Proxy({}, {
                get: (_, k) => (typeof k === 'string' ? CURCHAT.scriptstate['$' + k] : undefined),
                set: (_, k, v) => { CURCHAT.scriptstate['$' + String(k)] = v; return true; },
            });
            c.triggerId = o.triggerId || null;
            try {
                const r = await runTrigger(c.char, mode, { chat, manualName: o.manualName, triggerId: o.triggerId });
                const ss = (CURCHAT && CURCHAT.scriptstate) || scriptstate;
                const vars = {};
                for (const [k, v] of Object.entries(ss)) if (k[0] === '$') vars[k.slice(1)] = v == null ? 'null' : String(v);
                return {
                    messages: r && r.chat && Array.isArray(r.chat.message) ? r.chat.message.map(m => ({ role: m.role, data: String(m.data == null ? '' : m.data) })) : null,
                    vars, sys: r ? r.additonalSysPrompt : null, stop: !!(r && r.stopSending),
                };
            } finally { c.vars = keep; c.triggerId = null; CURCHAT = null; CUR = null; }
        },
        /** The card has Lua triggers (triggerlua). */
        hasLua(key) {
            const c = ctxs.get(key);
            return !!(c && (c.char.triggerscript || []).some(t => t && t.effect && t.effect[0] && t.effect[0].type === 'triggerlua'));
        },
        /** RisuAI's runLuaEditTrigger: the card's listenEdit functions on a text
         *  (mode 'editinput' | 'editoutput' | 'editdisplay') or on a request
         *  ('editRequest', data = [{role, content}]). Returns { data, vars }. */
        async luaEdit(key, mode, data, meta) {
            const c = ctxs.get(key);
            if (!c) return null;
            CUR = c;
            const keep = c.vars;
            c.vars = Object.assign({}, keep);
            try {
                let out;
                if (mode === 'editRequest') {
                    // runLuaEditTrigger has no case for it; RisuAI calls it straight.
                    out = data;
                    for (const t of (c.char.triggerscript || [])) {
                        if (t && t.effect && t.effect[0] && t.effect[0].type === 'triggerlua') {
                            const r = await runScripted(t.effect[0].code, { char: c.char, lowLevelAccess: false, mode: 'editRequest', data: out, meta });
                            out = (r && r.res) ?? out;
                        }
                    }
                } else out = await runLuaEditTrigger(c.char, mode, data, meta);
                return { data: out, vars: Object.assign({}, c.vars) };
            } finally { c.vars = keep; CUR = null; }
        },
        /** RisuAI's runLuaButtonTrigger (risu-btn="data"). Returns
         *  { messages, vars } like trigger(). */
        async luaButton(key, data) {
            const c = ctxs.get(key);
            if (!c) return null;
            CUR = c;
            const keepVars = c.vars, keepChat = c.chat;
            c.vars = Object.assign({}, keepVars);
            c.chat = Object.assign({}, keepChat, { message: keepChat.message.map(m => Object.assign({}, m)) });
            c.char.chats = [c.chat];
            try {
                const r = await runLuaButtonTrigger(c.char, String(data));
                const chat = (r && r.chat) || c.chat;
                return {
                    messages: Array.isArray(chat.message) ? chat.message.map(m => ({ role: m.role, data: String(m.data == null ? '' : m.data) })) : null,
                    vars: Object.assign({}, c.vars),
                };
            } finally { c.vars = keepVars; c.chat = keepChat; c.char.chats = [keepChat]; CUR = null; }
        },
        /** The card's backgroundHTML: BackgroundDom.svelte (CBS with the
         *  character) then ParseMarkdown's editdisplay pass, without a message. */
        background(key, html, o, hooks) {
            o = o || {};
            const r = withCtx(key, o.seed, (c) => {
                const data = risuChatParser(String(html), { chara: c.char });
                return processScriptFull(data, 'editdisplay', -1, {}, hooks).data;
            });
            return r == null ? String(html) : r;
        },
    };
}

/** Worker side: one job at a time, a message before each script so the page
 *  can stop a script that hangs (RisuAI cards are other people's regex). */
function rizzWorkerMain(E, self) {
    self.onmessage = (e) => {
        const d = e.data || {};
        if (d.t === 'ctx') { E.setCtx(d.key, d.ctx); return; }
        if (d.t === 'drop') { E.dropCtx(d.key); return; }
        const hooks = { skip: new Set(d.skip || []), onScript: (i) => self.postMessage({ id: d.id, i }) };
        let out = d.text, err = '';
        try {
            if (d.t === 'display') out = E.display(d.key, d.text, d.o, hooks);
            else if (d.t === 'background') out = E.background(d.key, d.text, d.o, hooks);
            else if (d.t === 'script') out = E.script(d.key, d.text, d.o, hooks);
            else if (d.t === 'parse') out = E.parse(d.key, d.text, d.o);
        } catch (x) { err = String((x && x.message) || x); }
        self.postMessage({ id: d.id, fim: true, out, err });
    };
}

dd.shared.engine = { rizzEngine, rizzWorkerMain };

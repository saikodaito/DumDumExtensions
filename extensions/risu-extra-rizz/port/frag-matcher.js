
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
            getModules: () => [],
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

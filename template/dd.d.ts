// Types for the `dd` object every extension script receives (API versions 1 and 2).
// Everything marked "API 2" needs "api": 2 in the manifest (app 1.30.0 or newer).
// "API 2.1" (Risu's extra Rizz F3a): the app version after 1.30.0; check that the
// function exists before using it if your minApp is older.
// Reference only: the app does not load this file.

type Text = string | { t: string; vars?: Record<string, string | number> };

interface DdStore {
    get(key: string): Promise<any>;          // null when missing
    set(key: string, value: any): Promise<void>;   // any structured-cloneable value, Blob included
    del(key: string): Promise<void>;
    keys(prefix?: string): Promise<string[]>;
}

interface DdChatMessage { role: 'user' | 'assistant' | 'system'; text: string; name: string | null; charId: string | null;
    time?: number;            // API 2.1: when it was sent (ms), 0 when unknown
}

interface DdModalHandle { el: HTMLElement; close(): void; }

/** Context of a slot. markDirty() tells the editor there is something to save. */
interface DdSlotCtx { charId: string | null; isNew: boolean; markDirty(): void; }

interface Dd {
    readonly id: string;
    readonly version: string;
    readonly apiVersion: 1 | 2;
    readonly appVersion: string;
    readonly platform: 'desktop' | 'mobile';
    readonly lang: 'pt' | 'en';
    /** Shared by all scripts of this extension. */
    readonly shared: Record<string, any>;

    onActivate(fn: () => void | Promise<void>): void;      // 10 s limit
    onDeactivate(fn: () => void | Promise<void>): void;    // 5 s limit; without it, turning off asks for a restart
    /** Returns a function that removes the handler.
     *  - app.ready     {}                                   after boot, or right after activation
     *  - chat.opened   { chatId, charId }
     *  - reply.start   { chatId, charId, kind, text(), since, ttsWillRead }   a streamed reply began;
     *                  text() returns the text so far (it grows); since = where the new text starts;
     *                  kind = 'send' | 'regen' | 'continue'; ttsWillRead = the automatic TTS will read it
     *  - reply.end     { chatId, aborted }                  once per reply.start
     *  - reply.full    { chatId, charId, kind, text, ttsWillRead }   a reply that arrived whole (streaming off)
     *  - char.saved    { charId }                           the character editor saved
     *  - char.deleted  { charId }                           your per-character storage is already cleared
     *  - lang.changed  { lang }
     *  - char.imported (API 2) DdCharImported   a character was imported and saved; the import
     *                  waits for your handler (60 s limit, call done() to let it go on sooner)
     *  - data.imported (API 2) { files, cleared? }   the user imported or wiped your own storage
     *                  from the extension's data window
     *  - chat.deleted  (API 2.1) { chatId }               your store.chat(chatId) is already cleared
     *  - audio.stopped (API 2.1) { chatId }               the user stopped your audio.music() with
     *                  the chat's stop button (do not start the same track again by yourself) */
    on(event: 'app.ready' | 'chat.opened' | 'reply.start' | 'reply.end' | 'reply.full' | 'char.saved' | 'char.deleted' | 'lang.changed' | 'data.imported' | 'chat.deleted' | 'audio.stopped', fn: (data: any) => void): () => void;
    on(event: 'char.imported', fn: (data: DdCharImported) => void | Promise<void>): () => void;

    /** blob: URL of a file declared in manifest.assets (or icon/banner). */
    asset(path: string): Promise<string>;
    log(...a: any[]): void;
    warn(...a: any[]): void;
    /** Your own i18n files; falls back to defaultLang, then to the key. */
    t(key: string, vars?: Record<string, string | number>): string;

    /** Outside backups and exports. Cleared when the extension is uninstalled. */
    store: DdStore & {
        char(charId: string): DdStore;   // cleared with the character
        chat(chatId: string): DdStore;   // API 2.1: cleared with the chat
    };

    state: {
        chat(): { id: string; charId: string | null; isGroup: boolean; messages: DdChatMessage[] } | null;
        char(id?: string): { id: string; name: string; description: string; personality: string; scenario: string; tags: string[]; creator: string;
            /** API 2.1 */
            inChatName: string; firstMessage: string; alternateGreetings: string[]; exampleDialogue: string; systemPrompt: string } | null;
        avatar(id?: string): Promise<string | null>;
        persona(): { name: string; description: string };
        ttsSpeaking(): boolean;
        ttsWillRead(): boolean;
        hidden(): boolean;
        streamingChatId(): string | null;
        activeChatId(): string | null;
        /** The reasoning tags the user configured (text between them is the model thinking). */
        reasoningTags(): { open: string; close: string }[];
    };

    audio: {
        /** The app's shared AudioContext (suspended until the first user gesture). */
        context(): AudioContext | null;
        /** Your own GainNode by name, connected to the app's Master volume. */
        output(name?: string): GainNode | null;
        /** Plays an AudioBuffer or a mono Float32Array (at the context's sample rate). */
        play(data: AudioBuffer | Float32Array, o?: { output?: string; rate?: number; gain?: number; when?: number; sampleRate?: number }): AudioBufferSourceNode | null;
        /** API 2.1. Background music of the open chat through an <audio> element (works with
         *  remote URLs that have no CORS). Volume = o.volume (0-1) x the app's Master. One track
         *  in the whole app: a new one replaces it; switching chats or turning your extension
         *  off stops it. The chat shows the name (o.label) with pause and stop buttons.
         *  url: http(s), blob: or data:audio. */
        music(url: string, o?: { volume?: number; loop?: boolean; label?: string }): { stop(): void; readonly playing: boolean; readonly active: boolean } | null;
    };

    ui: {
        /** Your global settings page (Settings > Extensions > configure). */
        settings(render: (el: HTMLElement, dd: Dd) => void): void;
        /** A section of yours inside an app modal. Only 'charEditor' for now (after Expressions).
         *  Returns a function that unregisters it. */
        slot(name: 'charEditor', h: ((el: HTMLElement, ctx: DdSlotCtx) => void) | {
            render(el: HTMLElement, ctx: DdSlotCtx): void;
            onSave?(ctx: DdSlotCtx): void | Promise<void>;   // the editor saved (5 s limit)
            onClose?(ctx: DdSlotCtx): void;
        }): () => void;
        modal(o: { title: Text; render?: (el: HTMLElement, h: DdModalHandle) => void; size?: 'sm' | 'md' | 'lg'; dismissable?: boolean; onClose?: () => void }): DdModalHandle;
        toast(text: string, type?: 'info' | 'success' | 'warning' | 'error'): void;
        confirm(text: string, o?: { ok?: string; cancel?: string }): Promise<boolean>;
        icons(el: Element): void;   // renders <i data-lucide="..."> inside el
        /** API 2. The app's media viewer. url: http(s), blob: or data:image. */
        lightbox(items: { type?: 'image' | 'video'; url: string }[], start?: number): void;
        /** API 2.1, needs "chatLayer" in manifest.permissions.ui. A layer of yours behind the
         *  messages of one chat, shown while that chat is open (null removes it). The HTML is
         *  sanitized (no scripts, styles or form controls; it does not get clicks). The CSS is
         *  scoped to that chat's messages (.dd-msg-body): body/html/:root mean the message itself. */
        chatLayer(chatId: string, o: { html?: string; css?: string } | null): void;
        section(o: { title: Text; icon?: string }): HTMLElement;
        toggle(o: { label: Text; desc?: Text; value?: boolean; onChange?: (v: boolean) => void }): HTMLElement;
        slider(o: { label: Text; min?: number; max?: number; step?: number; value?: number; format?: (v: number) => string; onInput?: (v: number) => void; onChange?: (v: number) => void }): HTMLElement;
        select(o: { label: Text; desc?: Text; options: { value: string; label?: Text }[]; value?: string; onChange?: (v: string) => void }): HTMLElement;
        pills(o: { options: { value: string; label?: Text }[]; value?: string; onChange?: (v: string) => void }): HTMLElement;
        button(o: { label?: Text; icon?: string; variant?: 'primary' | 'danger' | 'ghost'; size?: 'sm' | 'lg'; onClick?: (ev: MouseEvent) => void }): HTMLElement;
        hint(text: Text): HTMLElement;
    };

    net: {
        /** The app's fetch. Hosts outside manifest.permissions.network are refused. */
        fetch(url: string, init?: RequestInit): Promise<Response>;
    };

    /** Prompt hooks. Both need "prompt": true in manifest.permissions; without it
     *  they log a warning and do nothing. Each returns a function that unregisters it. */
    prompt: {
        /** Called once per reply (send, regenerate, continue; group chats go through send),
         *  before the prompt is assembled. 3 s limit. What you return is shown in the
         *  prompt inspector under your extension's name. The app has one token budget
         *  for all extensions (Settings > Extensions), filled in install order: an
         *  injection that does not fit is left out and shows crossed out. */
        inject(fn: (ctx: DdPromptCtx) => DdInjection | DdInjection[] | null | void
            | Promise<DdInjection | DdInjection[] | null | void>): () => void;
        /** Called on the final reply text before it is saved (never while it streams),
         *  without the reasoning. For continue, only the new piece. 3 s limit. Return the
         *  new text; anything that is not a non-empty string keeps the text as it was. */
        transform(fn: (text: string, ctx: DdPromptCtx & { partial?: boolean }) => string | Promise<string>): () => void;
        /** API 2.1. Called once per reply, before the lorebook is scanned and before the app's
         *  macros run, with the character's texts and every lorebook entry it can see. Return
         *  only what changes; it applies to this prompt only (nothing is saved). 2 min limit
         *  (it may wait for the user, like a card's question).
         *  lore changes: content, enabled, constant, position ('after_char' | 'before_char' |
         *  'depth'), depth (messages from the end of the history) and role. */
        fields(fn: (fields: DdFields, ctx: DdPromptCtx) => DdFieldsChange | null | void
            | Promise<DdFieldsChange | null | void>): () => void;
        /** API 2.1. The copy of the history that goes to the model (the reasoning already
         *  removed). Return one text per message, in order, or null to keep them. 3 s limit. */
        history(fn: (messages: (DdChatMessage & { index: number })[], ctx: DdPromptCtx) => string[] | null | void
            | Promise<string[] | null | void>): () => void;
    };

    /** API 2.1, needs "chatWrite": true in manifest.permissions. Never in a chat that is
     *  streaming a reply (returns false). Saved and redrawn right away. */
    chat: {
        /** New text for message i (the swipe on screen). */
        edit(chatId: string, index: number, text: string): boolean;
        /** A message at the end. */
        add(chatId: string, msg: { role: 'user' | 'assistant'; text: string; charId?: string }): boolean;
        /** Deletes count messages from i (the greeting, i = 0, stays). */
        remove(chatId: string, index: number, count?: number): boolean;
    };

    /** API 2.1: hooks of a card provider (today only 'risurealm'). Your extension decides when
     *  the provider's full package is used and what the update check compares; downloading
     *  and opening the package stays with the app. */
    cards: {
        source(provider: 'risurealm', h: {
            /** 'package' = import and preview this card through its package (.charx). */
            format?(cardId: string, o: { purpose: 'import' | 'preview' }): Promise<'package' | null> | 'package' | null;
            /** What the update check compares, or null for the app's own path. extra = changes
             *  only your extension knows (shown in the update list; apply() runs when accepted). */
            update?(char: { id: string; name: string; originId: string }): Promise<null | {
                description?: string; firstMessage?: string; scenario?: string; mesExample?: string;
                systemPrompt?: string; altGreetings?: string[]; characterBook?: any; version?: string;
                extra?: { key: string; label: string; info?: string; preview?: string }[];
            }>;
            apply?(char: { id: string; name: string; originId: string }, key: string): Promise<void>;
        }): () => void;
        /** The provider's own data about a card (RisuRealm: the type on its page). */
        info(provider: 'risurealm', cardId: string): Promise<{ type: string } | null>;
        /** The package's size without downloading it (null when the server does not say). */
        packageSize(provider: 'risurealm', cardId: string): Promise<number | null>;
        /** The whole package, fresh. o.progress shows the app's download window. */
        package(provider: 'risurealm', cardId: string, o?: { progress?: boolean }): Promise<{ card: any; bytes: number; file(name: string): Promise<Blob | null> }>;
    };

    /** API 2.1, needs "llm": true in manifest.permissions. One request to the model of the open
     *  chat's connection (its connection preset included), no streaming; it counts in the
     *  Usage tab as 'extension'. Resolves with the reply text; throws on errors. */
    llm: {
        ask(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], o?: { maxTokens?: number; temperature?: number }): Promise<string>;
    };

    /** API 2.1, needs "input": true in manifest.permissions. */
    input: {
        /** The user's message before it is saved (after the preset's regex). 2 min limit. Return
         *  the new text; anything that is not a non-empty string keeps it. */
        transform(fn: (text: string, ctx: { chatId: string; charId: string | null; isGroup: boolean }) => string | Promise<string>): () => void;
    };
}

interface DdPromptCtx {
    chatId: string;
    charId: string;           // in a group chat, the character who is replying
    kind: 'send' | 'regen' | 'continue';
    isGroup: boolean;
    /** inject only: the messages before the reply (a copy). */
    history?(): DdChatMessage[];
}

interface DdLoreEntry {
    id: string; name: string; content: string; keys: string[]; constant: boolean; enabled: boolean;
    position: 'after_char' | 'before_char' | 'depth'; depth: number | null; role: 'system' | 'user' | 'assistant' | null;
}
interface DdFields {
    description: string; personality: string; scenario: string; exampleDialogue: string;
    systemPrompt: string; persona: string; lore: DdLoreEntry[];
}
interface DdFieldsChange {
    description?: string; personality?: string; scenario?: string; exampleDialogue?: string;
    systemPrompt?: string; persona?: string;
    lore?: Record<string, Partial<Pick<DdLoreEntry, 'content' | 'enabled' | 'constant' | 'position' | 'depth' | 'role'>>>;
}

interface DdInjection {
    text: string;             // {{char}} and {{user}} are replaced
    /** 'system:end' (default): end of the system prompt.
     *  'beforeHistory': its own message, right before the chat history.
     *  'depth:N': its own message, N messages from the end of the history (0 = last). */
    position?: 'system:end' | 'beforeHistory' | `depth:${number}`;
    /** Role of the message ('beforeHistory' and 'depth:N' only). Default 'system'. */
    role?: 'system' | 'user' | 'assistant';
    /** Name in the prompt inspector. Default: the extension's name. */
    label?: string;
}

interface Dd {
    /** API 2. Changes the text of chat messages before the markdown, at the same point as the
     *  preset's screen regex (in the bubble and while streaming, at most every 250 ms).
     *  SYNCHRONOUS: over 50 ms in one call it is turned off until the app reopens.
     *  The HTML you return is sanitized like the rest of the bubble; blob: URLs are allowed in src. */
    render: {
        /** API 2.1: fn may return { text, keepFixed, wide } (both need "chatLayer" in
         *  permissions.ui). keepFixed: position: fixed in that message's CSS is kept, held by the
         *  chat area instead of the bubble (side panels of RisuAI cards); otherwise fixed and
         *  sticky become absolute inside the bubble. wide: the message takes the chat's width,
         *  and the app keeps --dd-chat-vw (1% of that width) on the chat for vw-sized CSS. */
        text(fn: (text: string, ctx: DdRenderCtx) => string | { text: string; keepFixed?: boolean; wide?: boolean }): () => void;
        /** Redraws the open chat (after loading what your render function uses). */
        refresh(): void;
        /** API 2.1. A click inside a message of the open chat, on an element that matches the
         *  selector (inside the HTML your render function returned, for example). */
        click(selector: string, fn: (e: { chatId: string; msgIndex: number; el: Element }) => void | Promise<void>): () => void;
        /** API 2.1. Redraws one message of the open chat (an async result of yours arrived:
         *  your render function runs again for it). Batched; a streaming message is skipped. */
        redraw(chatId: string, msgIndex: number): void;
    };
    /** API 2, only with "storage": "own" in the manifest (null otherwise). A database of your own,
     *  outside the app backup and the character export. The user exports it from the data button
     *  next to your extension (.dumextdata). The char folder is deleted with the character; on
     *  uninstall the user chooses whether to keep it. */
    files: {
        char(charId: string): DdFolder;
        global(): DdFolder;
        usage(): Promise<{ files: number; bytes: number; chars: number }>;
    } | null;
    /** API 2. Expressions (sprites) of a character. */
    expr: {
        /** The user's Expressions setting is on. */
        enabled(): boolean;
        /** Asks the user (unless ask:false) and builds an expressions pack for the character from
         *  files named after the emotion ('angry.webp', 'joy.png'). Does nothing and returns false
         *  when Expressions are off. Replaces the current pack. */
        offer(charId: string, files: { name: string; blob: Blob }[], o?: { ask?: boolean }): Promise<boolean>;
    };
    /** API 2. The app's asset name matching (the same the Char Browser preview uses): no case,
     *  no extension; exact, then variants (name_1, name_2), then the closest by up to 4 edits. */
    assets: {
        norm(name: string): string;
        /** 'Hikari_angry_2' → 'hikari_angry' */
        group(name: string): string;
        /** maxEdits: 4 by default (Risu's rule); 0 = exact and variants only. */
        candidates(wanted: string, names: string[], maxEdits?: number): number[];
        /** One index or -1. Several candidates → a stable pick for the same seed. */
        match(wanted: string, names: string[], seed?: string, maxEdits?: number): number;
        /** Calls fn for every <img="name"> and {{type::name}} in the text; return the replacement
         *  or null to keep it. type: img, image, asset, emotion, raw, path, video, video-img,
         *  audio, bgm, bg, source (<img="..."> comes as 'img'). */
        /** native = the {{type::name}} syntax. <img="name"> is a card convention: match it with
         *  maxEdits 0, or one character's line may get another character's image. */
        replace(text: string, fn: (type: string, name: string, mark: string, native: boolean) => string | null): string;
    };
}

interface DdRenderCtx {
    chatId: string;
    charId: string | null;    // in a group chat, the character who wrote the message
    msgIndex: number;
    role: 'user' | 'assistant';
    streaming: boolean;
}

interface DdFolder {
    /** name: up to 300 characters, '/' allowed. Strings and buffers become a Blob of the given type. */
    put(name: string, data: Blob | ArrayBuffer | ArrayBufferView | string, type?: string): Promise<void>;
    get(name: string): Promise<Blob | null>;
    has(name: string): Promise<boolean>;
    list(): Promise<{ name: string; size: number; type: string; t: number }[]>;
    /** list() with the Blobs, in one pass. prefix filters by the start of the name. */
    entries(prefix?: string): Promise<{ name: string; size: number; type: string; t: number; blob: Blob }[]>;
    /** Many files at once (one transaction per 200): much faster than put() in a loop. */
    putMany(items: { name: string; data: Blob | ArrayBuffer | ArrayBufferView | string; type?: string }[]): Promise<void>;
    del(name: string): Promise<void>;
    clear(): Promise<void>;
}

interface DdCharImported {
    charId: string;
    /** 'file', 'link' or the Char Browser source ('risurealm', 'chub', 'janny'...). */
    source: string;
    /** A copy of the card as it came, before the import changed it (assets, extensions). */
    card: any;
    /** An embedded file of the card ('embeded://path' or 'path'): an entry of the .charx or a
     *  chunk of the PNG. null when missing. Works while your handler runs. */
    file(path: string): Promise<Blob | null>;
    /** Lets the import go on now; your handler may keep working in the background. */
    done(): void;
    /** API 2.1: the provider's id of the card ('' when not from a provider). */
    originId: string;
    /** API 2.1: the size of the package it came in (RisuRealm .charx), 0 when it came as JSON. */
    packageSize: number;
}

declare const dd: Dd;

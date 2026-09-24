// Types for the `dd` object every extension script receives (API version 1).
// Reference only: the app does not load this file.

type Text = string | { t: string; vars?: Record<string, string | number> };

interface DdStore {
    get(key: string): Promise<any>;          // null when missing
    set(key: string, value: any): Promise<void>;   // any structured-cloneable value, Blob included
    del(key: string): Promise<void>;
    keys(prefix?: string): Promise<string[]>;
}

interface DdChatMessage { role: 'user' | 'assistant' | 'system'; text: string; name: string | null; charId: string | null; }

interface DdModalHandle { el: HTMLElement; close(): void; }

/** Context of a slot. markDirty() tells the editor there is something to save. */
interface DdSlotCtx { charId: string | null; isNew: boolean; markDirty(): void; }

interface Dd {
    readonly id: string;
    readonly version: string;
    readonly apiVersion: 1;
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
     *  - lang.changed  { lang } */
    on(event: 'app.ready' | 'chat.opened' | 'reply.start' | 'reply.end' | 'reply.full' | 'char.saved' | 'char.deleted' | 'lang.changed', fn: (data: any) => void): () => void;

    /** blob: URL of a file declared in manifest.assets (or icon/banner). */
    asset(path: string): Promise<string>;
    log(...a: any[]): void;
    warn(...a: any[]): void;
    /** Your own i18n files; falls back to defaultLang, then to the key. */
    t(key: string, vars?: Record<string, string | number>): string;

    /** Outside backups and exports. Cleared when the extension is uninstalled. */
    store: DdStore & { char(charId: string): DdStore };   // char scope is cleared with the character

    state: {
        chat(): { id: string; charId: string | null; isGroup: boolean; messages: DdChatMessage[] } | null;
        char(id?: string): { id: string; name: string; description: string; personality: string; scenario: string; tags: string[]; creator: string } | null;
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
}

declare const dd: Dd;

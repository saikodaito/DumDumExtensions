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
    /** Returns a function that removes the handler. */
    on(event: 'app.ready' | 'chat.opened' | 'char.deleted' | 'lang.changed' | string, fn: (data: any) => void): () => void;

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
    };

    ui: {
        /** Your global settings page (Settings > Extensions > configure). */
        settings(render: (el: HTMLElement, dd: Dd) => void): void;
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

// Hello World: a tour of the `dd` API.
// Everything goes through `dd`; never the app's DB, window.__TAURI__ or internal functions.

let activations = 0;
let greet = true;
let offChatOpened = null;

dd.onActivate(async () => {
    activations = ((await dd.store.get('activations')) || 0) + 1;
    await dd.store.set('activations', activations);
    const saved = await dd.store.get('greet');
    if (saved != null) greet = !!saved;

    // Event: the user switched chats.
    offChatOpened = dd.on('chat.opened', ({ chatId, charId }) => {
        const char = dd.state.char(charId);
        if (greet) dd.ui.toast(dd.t('toast_chat', { name: char ? char.name : '?' }));
        dd.log('chat opened', chatId, charId);
    });

    dd.ui.settings(renderSettings);
    dd.log('activated', { version: dd.version, platform: dd.platform, lang: dd.lang, activations });
});

// Turning the extension off without a restart cleans up after itself.
dd.onDeactivate(() => {
    if (offChatOpened) offChatOpened();
    dd.log('deactivated');
});

function renderSettings(el) {
    const section = dd.ui.section({ title: { t: 'sec_main' }, icon: 'hand' });
    section.appendChild(dd.ui.hint({ t: 'hint_opens', vars: { n: activations } }));

    section.appendChild(dd.ui.toggle({
        label: { t: 'lbl_greet' }, desc: { t: 'desc_greet' }, value: greet,
        onChange: v => { greet = v; dd.store.set('greet', v); },
    }));

    const sliderSlot = document.createElement('div');
    section.appendChild(sliderSlot);
    dd.store.get('volume').then(volume => {
        sliderSlot.appendChild(dd.ui.slider({
            label: { t: 'lbl_volume' }, min: 0, max: 100, value: volume == null ? 50 : volume,
            format: v => v + '%',
            onChange: v => dd.store.set('volume', v),
        }));
    });

    section.appendChild(dd.ui.select({
        label: { t: 'lbl_color' },
        options: [{ value: 'red', label: { t: 'opt_red' } }, { value: 'blue', label: { t: 'opt_blue' } }],
        value: 'blue',
        onChange: v => dd.log('color', v),
    }));

    section.appendChild(dd.ui.pills({
        options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }],
        value: 'a',
        onChange: v => dd.log('pill', v),
    }));

    const row = document.createElement('div');
    row.className = 'dd-hello-row';
    row.appendChild(dd.ui.button({ label: { t: 'btn_toast' }, icon: 'bell', onClick: () => dd.ui.toast(dd.t('toast_hi'), 'success') }));
    row.appendChild(dd.ui.button({ label: { t: 'btn_modal' }, icon: 'square', variant: 'primary', onClick: openModal }));
    row.appendChild(dd.ui.button({
        label: { t: 'btn_confirm' }, icon: 'help-circle',
        onClick: async () => dd.ui.toast(dd.t((await dd.ui.confirm(dd.t('confirm_q'))) ? 'said_yes' : 'said_no')),
    }));
    section.appendChild(row);
    el.appendChild(section);
}

function openModal() {
    dd.ui.modal({
        title: { t: 'modal_title' },
        render(body, handle) {
            const chat = dd.state.chat();
            const p = document.createElement('p');
            p.className = 'dd-hello-text';
            p.textContent = chat ? dd.t('modal_chat', { n: chat.messages.length }) : dd.t('modal_nochat');
            body.appendChild(p);
            body.appendChild(dd.ui.button({ label: { t: 'btn_close' }, onClick: () => handle.close() }));
        },
        onClose: () => dd.log('modal closed'),
    });
}

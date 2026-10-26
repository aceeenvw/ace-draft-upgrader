import { t } from './i18n.js';
import {
    clampInt,
    counterFontSize,
    COUNTER_SIZE_MODES,
    defaultInstruction,
    getSettings,
    HISTORY_COUNTS,
    HISTORY_LIMITS,
    HISTORY_MODES,
    INSTRUCTION_MAX,
    LENGTH_MODES,
    LENGTH_WORDS,
    normalizeInstruction,
    parseCustomTokens,
    resolveProfileId,
    saveSettings,
    selectedPrompt,
    setPromptSelection,
    tokenBudget,
    TOKEN_LIMITS,
    WORD_LIMITS,
} from './settings.js';
import { activePresetName, presetEntries } from './prompt.js';
import { resolveRequestContext } from './request.js';
import { mountComposerActions } from './composer-actions.js';

const WAND_ID = 'adu_wand_button';
const QUICK_ID = 'adu_quick_button';
let menuObserver = null;
let menuTimer = 0;
let dialogOpen = false;
let dialogCleanup = null;
let quickCleanup = null;
let composerCleanup = null;
let countTarget = null;
let countSource = null;
let countHandler = null;
let countLast = null;
let countEnabled = true;
let hotkeyHandler = null;
let settingsAbort = null;
let recoveryActions = null;
let resultClose = null;

function hotkeyMatches(event, hotkey) {
    if (!hotkey) return false;
    if (!!event.ctrlKey !== hotkey.ctrl || !!event.shiftKey !== hotkey.shift) return false;
    if (!!event.altKey !== hotkey.alt || !!event.metaKey !== hotkey.meta) return false;
    if (/^(Key[A-Z]|Digit[0-9])$/.test(hotkey.code)) return event.code === hotkey.code;
    return String(event.key).toLowerCase() === String(hotkey.key).toLowerCase();
}

function hotkeyLabel(hotkey) {
    if (!hotkey) return t('settingsHotkeyNone');
    const parts = [];
    if (hotkey.ctrl) parts.push('Ctrl');
    if (hotkey.shift) parts.push('Shift');
    if (hotkey.alt) parts.push('Alt');
    if (hotkey.meta) parts.push(/Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Meta');
    const names = { ' ': 'Space', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
    const physicalKey = hotkey.code?.match(/^Key([A-Z])$/)?.[1] || hotkey.code?.match(/^Digit([0-9])$/)?.[1];
    const key = physicalKey || names[hotkey.key] || (hotkey.key?.length === 1 ? hotkey.key.toUpperCase() : hotkey.key);
    parts.push(key || hotkey.code);
    return parts.join(' + ');
}

function isEditableTarget(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    const editable = path.find(element => element?.matches?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
    return !!editable && editable.id !== 'send_textarea';
}

function isMobileClient() {
    return !!SillyTavern.getContext().isMobile?.();
}

function bindGlobalHotkey() {
    if (hotkeyHandler) return;
    hotkeyHandler = event => {
        if (event.defaultPrevented || event.repeat || event.isComposing || event.getModifierState?.('AltGraph')
            || isMobileClient() || isEditableTarget(event)) return;
        if (!hotkeyMatches(event, getSettings().hotkey)) return;
        const button = document.getElementById(QUICK_ID);
        if (!button) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        button.click();
    };
    document.addEventListener('keydown', hotkeyHandler, true);
}

function isValidNumber(value, { min, max }) {
    const number = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isInteger(number) && number >= min && number <= max && String(number) === String(value).trim();
}

function node(tag, className, text = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
}

function checkboxRow(id, label, checked) {
    const row = node('label', 'adu-toggle');
    row.htmlFor = id;
    const input = node('input');
    input.id = id;
    input.type = 'checkbox';
    input.checked = checked;
    const text = node('span', 'adu-toggle__label', label);
    row.append(input, text);
    return { row, input };
}

function buildStamp(element) {
    const deltas = [2, 2, 0, 9, 8, 1];
    const bytes = [0x61];
    for (const delta of deltas) bytes.push(bytes[bytes.length - 1] + delta);
    element.dataset.build = btoa(JSON.stringify({ a: String.fromCharCode(...bytes), v: '1.2.0' }));
}

function supportedProfiles() {
    try {
        const service = SillyTavern.getContext().ConnectionManagerRequestService;
        return service?.getSupportedProfiles?.() || [];
    } catch (error) {
        console.warn('[ADU] connection profiles', error);
        return [];
    }
}

function createModelSection(settings) {
    const section = node('section', 'adu-card');
    const select = node('select', 'text_pole adu-model-select');
    select.id = 'adu_model_select';
    const heading = node('label', 'adu-card__heading', t('model'));
    heading.htmlFor = select.id;
    section.appendChild(heading);
    select.appendChild(new Option(t('modelUseCurrent'), ''));

    const profiles = supportedProfiles();
    const groups = new Map();
    for (const profile of profiles) {
        if (!profile?.id) continue;
        const api = SillyTavern.getContext().CONNECT_API_MAP?.[profile.api]?.selected;
        const label = api === 'textgenerationwebui' ? t('modelTextCompletion') : t('modelChatCompletion');
        if (!groups.has(label)) {
            const group = document.createElement('optgroup');
            group.label = label;
            groups.set(label, group);
        }
        groups.get(label).appendChild(new Option(String(profile.name || profile.id), profile.id));
    }
    for (const group of groups.values()) select.appendChild(group);

    select.value = profiles.some(profile => profile?.id === settings.profileId) ? settings.profileId : '';
    select.disabled = !profiles.length;
    section.appendChild(select);
    section.appendChild(node('p', 'adu-hint', profiles.length ? t('modelHint') : t('modelNoProfiles')));
    return { section, select };
}

function closeWandMenu() {
    const menu = document.getElementById('extensionsMenu');
    if (menu) menu.style.display = 'none';
}

function setBusyState(root, busy, stopping = false) {
    root.classList.toggle('adu-dialog--busy', busy);
    const action = root.querySelector('.adu-upgrade');
    const stop = root.querySelector('.adu-stop');
    const status = root.querySelector('.adu-status');
    if (action) action.disabled = busy;
    if (stop) {
        stop.hidden = !busy;
        stop.disabled = stopping;
    }
    if (status) {
        status.hidden = !busy;
        status.textContent = t(stopping ? 'stopping' : 'upgrading');
    }
    root.querySelectorAll('.adu-card button, .adu-card input, .adu-card select, .adu-card textarea').forEach(control => {
        if (busy) {
            if (!Object.hasOwn(control.dataset, 'aduBusyDisabled')) {
                control.dataset.aduBusyDisabled = String(control.disabled);
            }
            control.disabled = true;
        } else if (Object.hasOwn(control.dataset, 'aduBusyDisabled')) {
            control.disabled = control.dataset.aduBusyDisabled === 'true';
            delete control.dataset.aduBusyDisabled;
        }
    });
}

function createLengthSection(settings, modelSelect) {
    const section = node('section', 'adu-card');
    const heading = node('div', 'adu-card__heading', t('length'));
    const modes = node('div', 'adu-length-grid');
    const customWrap = node('label', 'adu-custom-length');
    const customLabel = node('span', '', t('customWords'));
    const customInput = node('input', 'text_pole');
    customInput.type = 'number';
    customInput.min = '1';
    customInput.max = '5000';
    customInput.step = '1';
    customInput.value = String(settings.customWords);
    customWrap.append(customLabel, customInput);

    const buttons = [];
    for (const mode of LENGTH_MODES) {
        const button = node('button', 'adu-length', t(mode));
        button.type = 'button';
        button.dataset.mode = mode;
        button.setAttribute('aria-pressed', String(settings.lengthMode === mode));
        if (mode !== 'custom') button.appendChild(node('small', '', t('words', { count: LENGTH_WORDS[mode] })));
        button.addEventListener('click', () => {
            for (const item of buttons) item.setAttribute('aria-pressed', String(item === button));
            customWrap.hidden = mode !== 'custom';
            if (mode === 'custom') customInput.focus();
        });
        buttons.push(button);
        modes.appendChild(button);
    }
    customWrap.hidden = settings.lengthMode !== 'custom';
    const tokens = createTokenControl(settings, buttons, customInput, modelSelect);
    section.append(heading, modes, customWrap, node('p', 'adu-hint', t('approximate')), tokens.fieldset);
    return { section, buttons, customInput, tokens };
}

function createTokenControl(settings, lengthButtons, wordInput, modelSelect) {
    const fieldset = node('fieldset', 'adu-token-budget');
    fieldset.appendChild(node('legend', 'adu-card__heading', t('tokenBudget')));
    const defaultRow = node('label', 'adu-token-option');
    const customRow = node('div', 'adu-token-custom');
    const customLabel = node('label', 'adu-token-option');
    const radios = ['default', 'custom'].map(mode => {
        const radio = node('input');
        radio.type = 'radio';
        radio.name = 'adu_token_mode';
        radio.id = `adu_token_${mode}`;
        radio.value = mode;
        radio.checked = settings.tokenMode === mode;
        return radio;
    });
    const [defaultRadio, customRadio] = radios;
    defaultRow.htmlFor = defaultRadio.id;
    customLabel.htmlFor = customRadio.id;
    const defaultText = node('span', '', t('tokenDefault') + ' ');
    const allowance = node('span', 'adu-token-allowance');
    allowance.setAttribute('aria-live', 'polite');
    defaultText.appendChild(allowance);
    defaultRow.append(defaultRadio, defaultText);
    customLabel.append(customRadio, node('span', '', t('tokenCustom')));

    const input = node('input', 'text_pole');
    input.id = 'adu_custom_tokens';
    input.type = 'text';
    input.inputMode = 'numeric';
    input.value = String(settings.customTokens);
    input.setAttribute('aria-label', t('customTokens'));
    input.setAttribute('aria-describedby', 'adu_token_hint adu_token_error');
    customRow.append(customLabel, input);
    const hint = node('p', 'adu-hint', t('tokenHint', TOKEN_LIMITS));
    hint.id = 'adu_token_hint';
    const error = node('p', 'adu-hint adu-token-error');
    error.id = 'adu_token_error';
    error.hidden = true;
    error.setAttribute('role', 'alert');
    fieldset.append(defaultRow, customRow, hint, error);

    const clearError = () => {
        input.removeAttribute('aria-invalid');
        error.hidden = true;
        error.textContent = '';
    };
    const syncMode = () => {
        input.disabled = !customRadio.checked;
        clearError();
    };
    radios.forEach(radio => radio.addEventListener('change', syncMode));
    input.addEventListener('input', clearError);
    syncMode();

    const refresh = () => {
        const lengthMode = pressedMode(lengthButtons, LENGTH_MODES, 'medium');
        let text = t('tokenUnavailable');
        if (lengthMode !== 'custom' || isValidNumber(wordInput.value, WORD_LIMITS)) {
            try {
                const { contextLimit } = resolveRequestContext(resolveProfileId({ profileId: modelSelect.value }));
                const count = tokenBudget({ tokenMode: 'default', lengthMode, customWords: wordInput.value }, contextLimit);
                text = t('tokens', { count });
            } catch {}
        }
        allowance.textContent = `· ${text}`;
    };
    lengthButtons.forEach(button => button.addEventListener('click', refresh));
    wordInput.addEventListener('input', refresh);
    modelSelect.addEventListener('change', refresh);
    refresh();

    const validate = () => {
        if (!customRadio.checked || parseCustomTokens(input.value) !== null) {
            clearError();
            return true;
        }
        input.setAttribute('aria-invalid', 'true');
        error.textContent = t('invalidTokens', TOKEN_LIMITS);
        error.hidden = false;
        input.focus();
        return false;
    };
    return { fieldset, customRadio, input, refresh, validate };
}

function createContextSection(settings) {
    const section = node('section', 'adu-card');
    section.appendChild(node('div', 'adu-card__heading', t('context')));
    const grid = node('div', 'adu-context-grid');
    const controls = {};
    for (const [key, label] of [['persona', t('persona')], ['card', t('card')], ['lorebook', t('lorebook')], ['history', t('history')]]) {
        const control = checkboxRow(`adu_${key}`, label, settings[key]);
        controls[key] = control.input;
        grid.appendChild(control.row);
    }
    section.appendChild(grid);

    const depth = node('div', 'adu-history-depth');
    depth.appendChild(node('div', 'adu-history-depth__label', t('historyDepth')));
    const modes = node('div', 'adu-history-grid');
    const customWrap = node('label', 'adu-custom-length');
    const customInput = node('input', 'text_pole');
    customInput.type = 'number';
    customInput.min = String(HISTORY_LIMITS.min);
    customInput.max = String(HISTORY_LIMITS.max);
    customInput.step = '1';
    customInput.value = String(settings.historyCustom);
    customWrap.append(node('span', '', t('historyCustom')), customInput);

    const buttons = [];
    for (const mode of HISTORY_MODES) {
        const label = mode === 'all' ? t('historyAll')
            : mode === 'custom' ? t('custom')
                : t('historyLast', { count: HISTORY_COUNTS[mode] });
        const button = node('button', 'adu-length', label);
        button.type = 'button';
        button.dataset.mode = mode;
        button.setAttribute('aria-pressed', String(settings.historyMode === mode));
        button.addEventListener('click', () => {
            for (const item of buttons) item.setAttribute('aria-pressed', String(item === button));
            customWrap.hidden = mode !== 'custom';
            if (mode === 'custom') customInput.focus();
        });
        buttons.push(button);
        modes.appendChild(button);
    }
    customWrap.hidden = settings.historyMode !== 'custom';
    depth.append(modes, customWrap, node('p', 'adu-hint', t('historyHint')));
    section.appendChild(depth);

    const syncDepth = () => depth.classList.toggle('adu-history-depth--off', !controls.history.checked);
    controls.history.addEventListener('change', syncDepth);
    syncDepth();

    return { section, controls, history: { buttons, customInput } };
}

function createPresetSection(settings) {
    const section = node('section', 'adu-card');
    const head = node('div', 'adu-card__heading adu-preset-head');
    const title = node('span', '', t('preset'));
    const name = activePresetName();
    head.append(title, node('span', 'adu-preset-name', name ? t('presetName', { name }) : t('noPreset')));
    section.appendChild(head);

    const toolbar = node('div', 'adu-preset-toolbar');
    const selectAll = node('button', 'menu_button', t('selectAll'));
    const clear = node('button', 'menu_button', t('selectNone'));
    selectAll.type = clear.type = 'button';
    toolbar.append(selectAll, clear);

    const list = node('div', 'adu-prompt-list');
    const controls = [];
    const entries = name ? presetEntries() : [];
    for (const entry of entries) {
        const row = checkboxRow(`adu_prompt_${controls.length}`, entry.name, selectedPrompt(settings, name, entry.identifier, entry.sourceEnabled));
        row.row.classList.add('adu-prompt-row');
        row.input.dataset.identifier = entry.identifier;
        if (!entry.sourceEnabled) {
            row.row.classList.add('adu-prompt-row--disabled');
            row.row.appendChild(node('span', 'adu-source-state', t('sourceDisabled')));
        }
        row.row.appendChild(node('span', 'adu-role', entry.role));
        controls.push({ input: row.input, entry });
        list.appendChild(row.row);
    }
    if (!entries.length) list.appendChild(node('p', 'adu-empty', name ? t('noPrompts') : t('noPreset')));
    const details = node('details', 'adu-preset-details');
    const summary = node('summary', 'adu-preset-summary');
    const updateCount = () => {
        const selected = controls.filter(control => control.input.checked).length;
        summary.textContent = t('promptCount', { selected, total: controls.length });
    };
    selectAll.addEventListener('click', () => {
        controls.forEach(control => { control.input.checked = control.entry.sourceEnabled; });
        updateCount();
    });
    clear.addEventListener('click', () => {
        controls.forEach(control => { control.input.checked = false; });
        updateCount();
    });
    controls.forEach(control => control.input.addEventListener('change', updateCount));
    updateCount();
    details.append(summary, toolbar, list);
    section.appendChild(details);
    return { section, controls, presetName: name };
}

function pressedMode(buttons, allowed, fallback) {
    const active = buttons.find(button => button.getAttribute('aria-pressed') === 'true');
    return allowed.includes(active?.dataset.mode) ? active.dataset.mode : fallback;
}

function persistDialog(settings, model, length, context, preset) {
    settings.profileId = String(model.select.value || '');
    settings.lengthMode = pressedMode(length.buttons, LENGTH_MODES, 'medium');
    settings.customWords = clampInt(length.customInput.value, WORD_LIMITS, settings.customWords);
    settings.tokenMode = length.tokens.customRadio.checked ? 'custom' : 'default';
    settings.customTokens = parseCustomTokens(length.tokens.input.value) ?? settings.customTokens;
    settings.historyMode = pressedMode(context.history.buttons, HISTORY_MODES, 'all');
    settings.historyCustom = clampInt(context.history.customInput.value, HISTORY_LIMITS, settings.historyCustom);
    for (const [key, input] of Object.entries(context.controls)) settings[key] = input.checked;
    for (const control of preset.controls) {
        setPromptSelection(settings, preset.presetName, control.entry.identifier, control.input.checked);
    }
    saveSettings();
}

async function openLastResult() {
    const actions = recoveryActions;
    if (resultClose || !actions?.get()) return;
    const ctx = SillyTavern.getContext();
    const root = node('div', 'adu-dialog adu-result-view');
    const heading = node('h3', '', t('lastResult'));
    heading.id = 'adu_result_title';
    const content = node('div', 'adu-result-content');
    const empty = node('p', 'adu-hint', t('lastResultEmpty'));
    const status = node('p', 'adu-hint');
    status.setAttribute('role', 'status');
    const reason = node('p', 'adu-hint', t('restoreUnavailable'));
    reason.id = 'adu_restore_reason';
    const restore = node('button', 'menu_button adu-result-restore', t('restoreOriginal'));
    const retry = node('button', 'menu_button adu-result-retry', t('retry'));
    restore.type = retry.type = 'button';
    restore.setAttribute('aria-describedby', reason.id);
    retry.setAttribute('aria-describedby', reason.id);
    const fields = [];
    let shownId;
    let disposed = false;
    root.append(heading, node('p', 'adu-hint', t('lastResultHint')), content, empty, status);

    const refresh = () => {
        if (disposed) return;
        const result = actions.get();
        if (shownId !== result?.id) {
            shownId = result?.id;
            for (const field of fields) field.textarea.value = result?.[field.key] || '';
            status.textContent = '';
        }
        content.hidden = !result;
        empty.hidden = !!result;
        for (const field of fields) field.copy.disabled = !result || field.copying;
        restore.disabled = !actions.canRestore(shownId);
        const busy = actions.isBusy();
        retry.textContent = t(busy ? 'stop' : 'retry');
        retry.title = t(busy ? 'quickStop' : 'retryHint');
        retry.disabled = busy ? actions.isStopping() : !actions.canRetry(shownId);
        reason.hidden = !restore.disabled;
    };

    for (const [key, labelKey, copyKey] of [
        ['upgraded', 'upgradedDraft', 'copyUpgraded'], ['original', 'originalDraft', 'copyOriginal'],
    ]) {
        const block = node(key === 'original' ? 'details' : 'section', 'adu-result-block');
        const label = node(key === 'original' ? 'summary' : 'label', 'adu-card__heading', t(labelKey));
        label.id = `adu_result_${key}_label`;
        const textarea = node('textarea', 'text_pole adu-result-text');
        textarea.id = `adu_result_${key}`;
        textarea.readOnly = true;
        textarea.dir = 'auto';
        textarea.rows = 7;
        textarea.setAttribute('aria-labelledby', label.id);
        if (key === 'upgraded') label.htmlFor = textarea.id;
        const copy = node('button', 'menu_button', t(copyKey));
        copy.type = 'button';
        const field = { key, textarea, copy, copying: false };
        fields.push(field);
        copy.addEventListener('click', async () => {
            const result = actions.get();
            if (disposed || !result || result.id !== shownId || field.copying) return;
            const id = result.id;
            field.copying = true;
            copy.disabled = true;
            try {
                await navigator.clipboard.writeText(result[key]);
                if (!disposed && actions.get()?.id === id) status.textContent = t('copied');
            } catch {
                if (!disposed && actions.get()?.id === id) status.textContent = t('copyFailed');
            } finally {
                field.copying = false;
                refresh();
            }
        });
        block.append(label, textarea, copy);
        content.appendChild(block);
    }
    const buttons = node('div', 'adu-actions');
    buttons.append(restore, retry);
    content.append(buttons, reason);
    restore.addEventListener('click', () => {
        if (disposed) return;
        actions.restore(shownId);
        refresh();
    });
    retry.addEventListener('click', async () => {
        if (disposed) return;
        if (actions.isBusy()) {
            actions.cancel();
            return;
        }
        try {
            await actions.retry(shownId);
        } catch {}
    });
    const unsubscribe = actions.subscribe(refresh);
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        for (const field of fields) field.textarea.value = '';
        status.textContent = '';
    };
    const popup = new ctx.Popup(root, ctx.POPUP_TYPE.TEXT, '', {
        wide: true,
        allowVerticalScrolling: true,
        okButton: t('close'),
        cancelButton: false,
        onClose: dispose,
    });
    popup.dlg?.setAttribute('aria-labelledby', heading.id);
    const close = () => {
        dispose();
        popup.complete(ctx.POPUP_RESULT.CANCELLED);
    };
    resultClose = close;
    refresh();
    try {
        await popup.show();
    } finally {
        dispose();
        if (resultClose === close) resultClose = null;
    }
}

async function openUpgradeDialog(onUpgrade, onCancel) {
    if (dialogOpen) return;
    const ctx = SillyTavern.getContext();
    const recovery = recoveryActions;
    const hasResult = !!recovery?.get();
    if (!hasResult && !resolveProfileId(getSettings()) && ctx.mainApi !== 'openai' && !supportedProfiles().length) {
        toastr.warning(t('noApi'), t('title'));
        return;
    }
    const textarea = document.getElementById('send_textarea');
    if (!textarea?.value?.trim()) {
        if (hasResult) return openLastResult();
        toastr.info(t('emptyDraft'), t('title'));
        textarea?.focus();
        return;
    }

    const settings = getSettings();
    const root = node('div', 'adu-dialog');
    const title = node('div', 'adu-title');
    const glyph = node('span', 'adu-title__glyph', '✦');
    glyph.setAttribute('aria-hidden', 'true');
    const titleText = node('h3', '', t('title'));
    titleText.id = 'adu_dialog_title';
    title.append(glyph, titleText, glyph.cloneNode(true));
    root.append(title, node('p', 'adu-intro', t('intro')));
    const lastResult = node('button', 'menu_button adu-last-result', t('lastResult'));
    lastResult.type = 'button';
    let disposed = false;
    const refreshResult = () => {
        if (disposed) return;
        lastResult.hidden = !recovery?.get();
        setBusyState(root, !!recovery?.isBusy(), !!recovery?.isStopping());
    };
    lastResult.addEventListener('click', openLastResult);
    refreshResult();
    root.appendChild(lastResult);

    const model = createModelSection(settings);
    const length = createLengthSection(settings, model.select);
    const context = createContextSection(settings);
    const preset = createPresetSection(settings);
    root.append(model.section, length.section, context.section, preset.section);

    const instructionCard = node('section', 'adu-card');
    const instruction = node('textarea', 'text_pole adu-instruction');
    instruction.id = 'adu_instruction';
    instruction.rows = 4;
    instruction.maxLength = INSTRUCTION_MAX;
    instruction.value = settings.instruction;
    const instructionLabel = node('label', 'adu-card__heading', t('instruction'));
    instructionLabel.htmlFor = instruction.id;
    instructionCard.appendChild(instructionLabel);
    instructionCard.append(instruction, node('p', 'adu-hint', t('instructionHint')));
    root.appendChild(instructionCard);

    const status = node('div', 'adu-status');
    status.hidden = true;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const actions = node('div', 'adu-actions');
    const stop = node('button', 'menu_button adu-stop', t('stop'));
    const upgrade = node('button', 'menu_button adu-upgrade');
    stop.type = upgrade.type = 'button';
    stop.hidden = true;
    upgrade.append(node('i', 'fa-solid fa-wand-magic-sparkles'), node('span', '', t('upgrade')));
    actions.append(stop, upgrade);
    root.append(status, actions);

    const popup = new ctx.Popup(root, ctx.POPUP_TYPE.TEXT, '', {
        wide: true,
        allowVerticalScrolling: true,
        okButton: t('cancel'),
        cancelButton: false,
        onClosing: () => !root.classList.contains('adu-dialog--busy'),
    });
    popup.dlg?.setAttribute('aria-labelledby', titleText.id);

    stop.addEventListener('click', () => {
        if (!disposed) onCancel();
    });
    upgrade.addEventListener('click', async () => {
        if (disposed || recovery?.isBusy()) return;
        if (!model.select.value && SillyTavern.getContext().mainApi !== 'openai') {
            toastr.warning(t('noApi'), t('title'));
            model.select.focus();
            return;
        }
        const mode = pressedMode(length.buttons, LENGTH_MODES, 'medium');
        if (mode === 'custom' && !isValidNumber(length.customInput.value, WORD_LIMITS)) {
            toastr.warning(t('invalidWords'), t('title'));
            length.customInput.focus();
            return;
        }
        if (!length.tokens.validate()) return;
        const depthMode = pressedMode(context.history.buttons, HISTORY_MODES, 'all');
        if (context.controls.history.checked && depthMode === 'custom'
            && !isValidNumber(context.history.customInput.value, HISTORY_LIMITS)) {
            toastr.warning(t('invalidHistory', { max: HISTORY_LIMITS.max }), t('title'));
            context.history.customInput.focus();
            return;
        }
        settings.instruction = normalizeInstruction(instruction.value);
        persistDialog(settings, model, length, context, preset);
        try {
            const completed = await onUpgrade(settings);
            if (completed && !disposed) popup.complete(ctx.POPUP_RESULT.AFFIRMATIVE);
        } catch {} finally {
            refreshResult();
        }
    });

    const events = ctx.eventTypes || ctx.event_types || {};
    const budgetEvents = [events.SETTINGS_UPDATED, events.PRESET_CHANGED, events.CONNECTION_PROFILE_UPDATED].filter(Boolean);
    for (const event of budgetEvents) ctx.eventSource?.on(event, length.tokens.refresh);
    const unsubscribeResult = recovery?.subscribe(refreshResult);
    const cleanup = (close = false) => {
        if (disposed) return;
        disposed = true;
        for (const event of budgetEvents) ctx.eventSource?.removeListener(event, length.tokens.refresh);
        unsubscribeResult?.();
        if (close) {
            setBusyState(root, false);
            popup.complete(ctx.POPUP_RESULT.CANCELLED);
        }
    };
    dialogCleanup = cleanup;
    refreshResult();
    dialogOpen = true;
    try {
        await popup.show();
    } finally {
        cleanup();
        if (dialogCleanup === cleanup) {
            dialogCleanup = null;
            dialogOpen = false;
        }
    }
}

function addWandButton(onUpgrade, onCancel) {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    if (document.getElementById(WAND_ID)) return true;
    const button = node('div', 'list-group-item flex-container flexGap5 interactable');
    button.id = WAND_ID;
    button.tabIndex = 0;
    button.setAttribute('role', 'button');
    button.title = t('menuTitle');
    buildStamp(button);
    const icon = node('div', 'fa-solid fa-file-pen extensionsMenuExtensionButton');
    button.append(icon, node('span', '', 'DRAFT UPGRADER'));
    const activate = event => {
        if (event.type === 'keydown') {
            if (!['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            button.click();
            return;
        }
        event.preventDefault();
        closeWandMenu();
        openUpgradeDialog(onUpgrade, onCancel);
    };
    button.addEventListener('click', activate);
    button.addEventListener('keydown', activate);
    menu.appendChild(button);
    return true;
}

function countWords(value) {
    const trimmed = String(value ?? '').trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
}

function formatCount(words) {
    return words < 1000 ? String(words) : `${(words / 1000).toFixed(1).replace(/\.0$/, '')}k`;
}

function refreshCount() {
    if (!countTarget || !countSource) return;
    if (!countEnabled || countTarget.closest('.adu-quick--hidden')) {
        countTarget.hidden = true;
        countTarget.textContent = '';
        countLast = null;
        return;
    }
    const value = countSource.value;
    if (value === countLast) return;
    countLast = value;
    const words = countWords(value);
    countTarget.hidden = words === 0;
    countTarget.textContent = words ? formatCount(words) : '';
}

function applyCountSize(settings) {
    countTarget?.style.setProperty('--adu-count-size', `${counterFontSize(settings)}px`);
}

function setWordCounterSize() {
    applyCountSize(getSettings());
}

function setQuickBusy(button) {
    const busy = !!recoveryActions?.isBusy();
    const stopping = !!recoveryActions?.isStopping();
    button.classList.toggle('adu-quick--busy', busy);
    button.disabled = stopping;
    button.title = t(stopping ? 'stopping' : busy ? 'quickStop' : 'quickTitle');
    button.setAttribute('aria-label', button.title);
    button.querySelector('.adu-quick__label').textContent = busy ? t('stop') : 'UP';
}

function addQuickButton(onUpgrade, onCancel) {
    const sendControls = document.getElementById('rightSendForm');
    const sendButton = document.getElementById('send_but');
    const textarea = document.getElementById('send_textarea');
    if (!sendControls || !sendButton || !textarea) return false;
    if (document.getElementById(QUICK_ID)) return true;
    const button = node('button', 'adu-quick');
    button.id = QUICK_ID;
    button.type = 'button';
    button.appendChild(node('span', 'adu-quick__label', 'UP'));
    const count = node('span', 'adu-quick__count');
    count.setAttribute('aria-hidden', 'true');
    count.hidden = true;
    button.appendChild(count);
    setQuickBusy(button);
    button.classList.toggle('adu-quick--hidden', !getSettings().quickButton);
    button.addEventListener('click', async () => {
        if (recoveryActions?.isBusy()) {
            onCancel();
            return;
        }
        try {
            await onUpgrade(getSettings());
        } catch {}
    });
    sendControls.insertBefore(button, sendButton);
    countTarget = count;
    countSource = textarea;
    countEnabled = getSettings().wordCounter;
    applyCountSize(getSettings());
    countHandler = () => refreshCount();
    textarea.addEventListener('input', countHandler);
    refreshCount();
    return true;
}

function setQuickVisible(visible) {
    document.getElementById(QUICK_ID)?.classList.toggle('adu-quick--hidden', !visible);
    refreshCount();
}

function setWordCounterVisible(visible) {
    countEnabled = !!visible;
    refreshCount();
}

function stopMenuObserver() {
    menuObserver?.disconnect();
    menuObserver = null;
    window.clearTimeout(menuTimer);
    menuTimer = 0;
}

export function mountUi(onUpgrade, onCancel, recovery = recoveryActions) {
    recoveryActions = recovery;
    recoveryActions?.mount();
    if (!composerCleanup && recoveryActions) composerCleanup = mountComposerActions(recoveryActions);
    if (!quickCleanup) quickCleanup = recoveryActions?.subscribe(() => {
        const button = document.getElementById(QUICK_ID);
        if (button) setQuickBusy(button);
    });
    bindGlobalHotkey();
    const mountAll = () => {
        const wandReady = addWandButton(onUpgrade, onCancel);
        const quickReady = addQuickButton(onUpgrade, onCancel);
        return wandReady && quickReady;
    };
    if (mountAll()) {
        stopMenuObserver();
        return;
    }
    if (menuObserver) return;
    menuObserver = new MutationObserver(() => {
        if (mountAll()) stopMenuObserver();
    });
    menuObserver.observe(document.body, { childList: true, subtree: true });
    menuTimer = window.setTimeout(stopMenuObserver, 15000);
}

export function unmountUi() {
    composerCleanup?.();
    composerCleanup = null;
    quickCleanup?.();
    quickCleanup = null;
    recoveryActions?.cleanup();
    recoveryActions = null;
    resultClose?.();
    resultClose = null;
    dialogCleanup?.(true);
    dialogCleanup = null;
    dialogOpen = false;
    stopMenuObserver();
    if (hotkeyHandler) document.removeEventListener('keydown', hotkeyHandler, true);
    hotkeyHandler = null;
    settingsAbort?.abort();
    settingsAbort = null;
    if (countSource && countHandler) countSource.removeEventListener('input', countHandler);
    countTarget = null;
    countSource = null;
    countHandler = null;
    countLast = null;
    countEnabled = true;
    document.getElementById(WAND_ID)?.remove();
    document.getElementById(QUICK_ID)?.remove();
    document.querySelector('.ace-draft-upgrader-settings')?.remove();
}

export function bindSettingsUi() {
    const settings = getSettings();
    const root = document.querySelector('.ace-draft-upgrader-settings');
    if (!root) return;
    const instruction = root.querySelector('#adu_default_instruction');
    const reset = root.querySelector('#adu_reset_instruction');
    const quickToggle = root.querySelector('#adu_quick_toggle');
    const counterToggle = root.querySelector('#adu_counter_toggle');
    const counterSize = root.querySelector('#adu_counter_size');
    const hotkeyRow = root.querySelector('#adu_hotkey_row');
    const hotkeyInput = root.querySelector('#adu_hotkey_input');
    const hotkeyDesc = root.querySelector('#adu_hotkey_desc');
    const hotkeyClear = root.querySelector('#adu_hotkey_clear');
    if (!instruction || !reset || !quickToggle || !counterToggle || !counterSize
        || !hotkeyRow || !hotkeyInput || !hotkeyDesc || !hotkeyClear) return;
    settingsAbort?.abort();
    settingsAbort = new AbortController();
    const listenerOptions = { signal: settingsAbort.signal };
    root.querySelectorAll('[data-adu-i18n]').forEach(element => {
        element.textContent = t(element.dataset.aduI18n);
    });
    hotkeyRow.hidden = isMobileClient();
    hotkeyInput.value = hotkeyLabel(settings.hotkey);
    hotkeyInput.setAttribute('aria-label', t('settingsHotkeyRecord'));
    hotkeyClear.title = t('settingsHotkeyClear');
    hotkeyClear.setAttribute('aria-label', t('settingsHotkeyClear'));

    hotkeyInput.addEventListener('focus', () => {
        hotkeyDesc.textContent = t('settingsHotkeyDesc');
        hotkeyInput.value = t('settingsHotkeyPress');
        hotkeyInput.classList.add('adu-hotkey--recording');
    }, listenerOptions);
    hotkeyInput.addEventListener('blur', () => {
        hotkeyDesc.textContent = t('settingsHotkeyDesc');
        hotkeyInput.value = hotkeyLabel(settings.hotkey);
        hotkeyInput.classList.remove('adu-hotkey--recording');
    }, listenerOptions);
    hotkeyInput.addEventListener('keydown', event => {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat || event.isComposing) return;
        if (event.getModifierState?.('AltGraph')) return;
        if (event.key === 'Escape') {
            hotkeyInput.blur();
            return;
        }
        if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(event.key)) return;
        if (!event.ctrlKey && !event.altKey && !event.metaKey) {
            hotkeyInput.value = t('settingsHotkeyModifier');
            hotkeyDesc.textContent = t('settingsHotkeyModifier');
            return;
        }
        settings.hotkey = {
            code: String(event.code || '').slice(0, 32),
            key: String(event.key || '').slice(0, 32),
            ctrl: !!event.ctrlKey,
            shift: !!event.shiftKey,
            alt: !!event.altKey,
            meta: !!event.metaKey,
        };
        saveSettings();
        hotkeyInput.blur();
    }, listenerOptions);
    hotkeyClear.addEventListener('click', () => {
        settings.hotkey = null;
        saveSettings();
        hotkeyInput.value = hotkeyLabel(settings.hotkey);
    }, listenerOptions);

    quickToggle.checked = settings.quickButton;
    quickToggle.addEventListener('change', () => {
        settings.quickButton = quickToggle.checked;
        setQuickVisible(settings.quickButton);
        saveSettings();
    }, listenerOptions);
    counterToggle.checked = settings.wordCounter;
    counterToggle.addEventListener('change', () => {
        settings.wordCounter = counterToggle.checked;
        setWordCounterVisible(settings.wordCounter);
        saveSettings();
    }, listenerOptions);
    counterSize.value = settings.counterSize;
    counterSize.addEventListener('change', () => {
        if (!COUNTER_SIZE_MODES.includes(counterSize.value)) counterSize.value = 'medium';
        settings.counterSize = counterSize.value;
        setWordCounterSize();
        saveSettings();
    }, listenerOptions);
    instruction.value = settings.instruction.trim() || defaultInstruction();
    instruction.addEventListener('change', () => {
        settings.instruction = normalizeInstruction(instruction.value);
        instruction.value = settings.instruction;
        saveSettings();
        toastr.success(t('settingsSaved'), t('title'));
    }, listenerOptions);
    reset.addEventListener('click', () => {
        settings.instruction = defaultInstruction();
        instruction.value = settings.instruction;
        saveSettings();
    }, listenerOptions);
}

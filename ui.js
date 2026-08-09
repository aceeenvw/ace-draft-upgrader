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
    LENGTH_MODES,
    LENGTH_WORDS,
    resolveProfileId,
    saveSettings,
    selectedPrompt,
    setPromptSelection,
    WORD_LIMITS,
} from './settings.js';
import { activePresetName, presetEntries } from './prompt.js';

const WAND_ID = 'adu_wand_button';
const QUICK_ID = 'adu_quick_button';
let menuObserver = null;
let dialogOpen = false;
let quickBusy = false;
let countTarget = null;
let countSource = null;
let countHandler = null;
let countLast = null;
let countEnabled = true;

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
    element.dataset.build = btoa(JSON.stringify({ a: String.fromCharCode(...bytes), v: '1.1.0' }));
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
    const section = node('section', 'adu-card adu-model-card');
    section.appendChild(node('div', 'adu-card__heading', t('model')));

    const select = node('select', 'text_pole adu-model-select');
    select.id = 'adu_model_select';
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

function setBusyState(root, busy) {
    root.classList.toggle('adu-dialog--busy', busy);
    const action = root.querySelector('.adu-upgrade');
    const stop = root.querySelector('.adu-stop');
    const status = root.querySelector('.adu-status');
    if (action) action.disabled = busy;
    if (stop) stop.hidden = !busy;
    if (status) {
        status.hidden = !busy;
        status.textContent = t('upgrading');
    }
}

function createLengthSection(settings) {
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
    section.append(heading, modes, customWrap, node('p', 'adu-hint', t('approximate')));
    return { section, buttons, customInput };
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
    settings.historyMode = pressedMode(context.history.buttons, HISTORY_MODES, 'all');
    settings.historyCustom = clampInt(context.history.customInput.value, HISTORY_LIMITS, settings.historyCustom);
    for (const [key, input] of Object.entries(context.controls)) settings[key] = input.checked;
    for (const control of preset.controls) {
        setPromptSelection(settings, preset.presetName, control.entry.identifier, control.input.checked);
    }
    saveSettings();
}

export async function openUpgradeDialog(onUpgrade, onCancel) {
    if (dialogOpen) return;
    const ctx = SillyTavern.getContext();
    if (!resolveProfileId(getSettings()) && ctx.mainApi !== 'openai' && !supportedProfiles().length) {
        toastr.warning(t('noApi'), t('title'));
        return;
    }
    const textarea = document.getElementById('send_textarea');
    if (!textarea?.value?.trim()) {
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

    const model = createModelSection(settings);
    const length = createLengthSection(settings);
    const context = createContextSection(settings);
    const preset = createPresetSection(settings);
    root.append(model.section, length.section, context.section, preset.section);

    const instructionCard = node('section', 'adu-card');
    instructionCard.appendChild(node('div', 'adu-card__heading', t('instruction')));
    const instruction = node('textarea', 'text_pole adu-instruction');
    instruction.rows = 4;
    instruction.value = settings.instruction;
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
        stop.disabled = true;
        onCancel();
    });
    upgrade.addEventListener('click', async () => {
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
        const depthMode = pressedMode(context.history.buttons, HISTORY_MODES, 'all');
        if (context.controls.history.checked && depthMode === 'custom'
            && !isValidNumber(context.history.customInput.value, HISTORY_LIMITS)) {
            toastr.warning(t('invalidHistory', { max: HISTORY_LIMITS.max }), t('title'));
            context.history.customInput.focus();
            return;
        }
        settings.instruction = instruction.value.trim() || defaultInstruction();
        persistDialog(settings, model, length, context, preset);
        setBusyState(root, true);
        stop.disabled = false;
        let completed = false;
        try {
            completed = await onUpgrade(settings);
        } catch {
            completed = false;
        } finally {
            setBusyState(root, false);
        }
        if (completed) popup.complete(ctx.POPUP_RESULT.AFFIRMATIVE);
    });

    dialogOpen = true;
    try {
        await popup.show();
    } finally {
        dialogOpen = false;
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
    const icon = node('div', 'fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton');
    button.append(icon, node('span', '', t('title')));
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

export function setWordCounterSize() {
    applyCountSize(getSettings());
}

function setQuickBusy(button, busy) {
    quickBusy = busy;
    button.classList.toggle('adu-quick--busy', busy);
    button.title = busy ? t('quickStop') : t('quickTitle');
    button.setAttribute('aria-label', button.title);
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
    setQuickBusy(button, false);
    button.classList.toggle('adu-quick--hidden', !getSettings().quickButton);
    button.addEventListener('click', async () => {
        if (quickBusy) {
            onCancel();
            return;
        }
        setQuickBusy(button, true);
        try {
            await onUpgrade(getSettings());
        } catch {
            setQuickBusy(button, false);
            return;
        }
        setQuickBusy(button, false);
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

export function setQuickVisible(visible) {
    document.getElementById(QUICK_ID)?.classList.toggle('adu-quick--hidden', !visible);
    refreshCount();
}

export function setWordCounterVisible(visible) {
    countEnabled = !!visible;
    refreshCount();
}

export function mountUi(onUpgrade, onCancel) {
    const mountAll = () => {
        const wandReady = addWandButton(onUpgrade, onCancel);
        const quickReady = addQuickButton(onUpgrade, onCancel);
        return wandReady && quickReady;
    };
    if (mountAll()) return;
    menuObserver = new MutationObserver(() => {
        if (!mountAll()) return;
        menuObserver?.disconnect();
        menuObserver = null;
    });
    menuObserver.observe(document.body, { childList: true, subtree: true });
}

export function unmountUi() {
    menuObserver?.disconnect();
    menuObserver = null;
    if (countSource && countHandler) countSource.removeEventListener('input', countHandler);
    countTarget = null;
    countSource = null;
    countHandler = null;
    countLast = null;
    countEnabled = true;
    document.getElementById(WAND_ID)?.remove();
    document.getElementById(QUICK_ID)?.remove();
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
    if (!instruction || !reset || !quickToggle || !counterToggle || !counterSize) return;
    root.querySelectorAll('[data-adu-i18n]').forEach(element => {
        element.textContent = t(element.dataset.aduI18n);
    });
    quickToggle.checked = settings.quickButton;
    quickToggle.addEventListener('change', () => {
        settings.quickButton = quickToggle.checked;
        setQuickVisible(settings.quickButton);
        saveSettings();
    });
    counterToggle.checked = settings.wordCounter;
    counterToggle.addEventListener('change', () => {
        settings.wordCounter = counterToggle.checked;
        setWordCounterVisible(settings.wordCounter);
        saveSettings();
    });
    counterSize.value = settings.counterSize;
    counterSize.addEventListener('change', () => {
        if (!COUNTER_SIZE_MODES.includes(counterSize.value)) counterSize.value = 'medium';
        settings.counterSize = counterSize.value;
        setWordCounterSize();
        saveSettings();
    });
    instruction.value = settings.instruction.trim() || defaultInstruction();
    instruction.addEventListener('change', () => {
        settings.instruction = instruction.value.trim() || defaultInstruction();
        instruction.value = settings.instruction;
        saveSettings();
        toastr.success(t('settingsSaved'), t('title'));
    });
    reset.addEventListener('click', () => {
        settings.instruction = defaultInstruction();
        instruction.value = settings.instruction;
        saveSettings();
    });
}

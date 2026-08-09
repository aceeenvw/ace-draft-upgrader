const MODULE_NAME = 'ace-draft-upgrader';
export const LENGTH_WORDS = Object.freeze({ short: 50, medium: 200, long: 500 });
export const LENGTH_MODES = Object.freeze([...Object.keys(LENGTH_WORDS), 'custom']);
export const HISTORY_COUNTS = Object.freeze({ last5: 5, last15: 15, last30: 30 });
export const HISTORY_MODES = Object.freeze(['all', ...Object.keys(HISTORY_COUNTS), 'custom']);
export const WORD_LIMITS = Object.freeze({ min: 1, max: 5000 });
export const COUNTER_SIZES = Object.freeze({ small: 7, medium: 8, large: 10 });
export const COUNTER_SIZE_MODES = Object.freeze(Object.keys(COUNTER_SIZES));
export const HISTORY_LIMITS = Object.freeze({ min: 1, max: 500 });
const INSTRUCTION_MAX = 10000;
const PROFILE_ID_MAX = 200;
const DEFAULT_INSTRUCTION = 'Rewrite and improve the draft below. Preserve its intent, point of view, factual details, and roleplay continuity. Make the prose natural and polished. Return only the upgraded draft, with no commentary or quotation marks.';

const DEFAULTS = Object.freeze({
    lengthMode: 'medium',
    customWords: 300,
    historyMode: 'all',
    historyCustom: 20,
    persona: true,
    card: true,
    lorebook: true,
    history: true,
    quickButton: true,
    wordCounter: true,
    counterSize: 'medium',
    profileId: '',
    instruction: DEFAULT_INSTRUCTION,
    promptSelections: {},
});

let cached = null;

function plainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sanitizeSelections(value) {
    const output = {};
    for (const [preset, selections] of Object.entries(plainObject(value))) {
        if (!preset || preset === '__proto__' || preset === 'constructor' || preset === 'prototype') continue;
        const clean = {};
        for (const [identifier, enabled] of Object.entries(plainObject(selections))) {
            if (!identifier || identifier === '__proto__' || identifier === 'constructor' || identifier === 'prototype') continue;
            if (typeof enabled === 'boolean') clean[identifier] = enabled;
        }
        output[preset] = clean;
    }
    return output;
}

function normalizeInstruction(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return DEFAULT_INSTRUCTION;
    }
    return stripControlCharacters(value).slice(0, INSTRUCTION_MAX);
}

function stripControlCharacters(value) {
    return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function clampInt(value, { min, max }, fallback) {
    const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(number)));
}

function normalizeProfileId(value) {
    if (typeof value !== 'string') return '';
    return stripControlCharacters(value).trim().slice(0, PROFILE_ID_MAX);
}

export function getSettings() {
    const ctx = SillyTavern.getContext();
    const current = ctx.extensionSettings[MODULE_NAME];
    if (cached && current === cached) return cached;
    const raw = plainObject(current);
    cached = {
        lengthMode: LENGTH_MODES.includes(raw.lengthMode) ? raw.lengthMode : DEFAULTS.lengthMode,
        customWords: clampInt(raw.customWords, WORD_LIMITS, DEFAULTS.customWords),
        historyMode: HISTORY_MODES.includes(raw.historyMode) ? raw.historyMode : DEFAULTS.historyMode,
        historyCustom: clampInt(raw.historyCustom, HISTORY_LIMITS, DEFAULTS.historyCustom),
        persona: typeof raw.persona === 'boolean' ? raw.persona : DEFAULTS.persona,
        card: typeof raw.card === 'boolean' ? raw.card : DEFAULTS.card,
        lorebook: typeof raw.lorebook === 'boolean' ? raw.lorebook : DEFAULTS.lorebook,
        history: typeof raw.history === 'boolean' ? raw.history : DEFAULTS.history,
        quickButton: typeof raw.quickButton === 'boolean' ? raw.quickButton : DEFAULTS.quickButton,
        wordCounter: typeof raw.wordCounter === 'boolean' ? raw.wordCounter : DEFAULTS.wordCounter,
        counterSize: COUNTER_SIZE_MODES.includes(raw.counterSize) ? raw.counterSize : DEFAULTS.counterSize,
        profileId: normalizeProfileId(raw.profileId),
        instruction: normalizeInstruction(raw.instruction),
        promptSelections: sanitizeSelections(raw.promptSelections),
    };
    ctx.extensionSettings[MODULE_NAME] = cached;
    return cached;
}

export function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

export function counterFontSize(settings) {
    return COUNTER_SIZES[settings.counterSize] || COUNTER_SIZES.medium;
}

export function defaultInstruction() {
    return DEFAULT_INSTRUCTION;
}

export function targetWords(settings) {
    return settings.lengthMode === 'custom'
        ? clampInt(settings.customWords, WORD_LIMITS, DEFAULTS.customWords)
        : LENGTH_WORDS[settings.lengthMode] || LENGTH_WORDS.medium;
}

export function historyLimit(settings) {
    if (settings.historyMode === 'all') return 0;
    if (settings.historyMode === 'custom') {
        return clampInt(settings.historyCustom, HISTORY_LIMITS, DEFAULTS.historyCustom);
    }
    return HISTORY_COUNTS[settings.historyMode] || 0;
}

export function resolveProfileId(settings) {
    const id = normalizeProfileId(settings.profileId);
    if (!id) return '';
    try {
        const ctx = SillyTavern.getContext();
        if (ctx.extensionSettings?.disabledExtensions?.includes('connection-manager')) return '';
        const exists = ctx.extensionSettings?.connectionManager?.profiles?.some(profile => profile?.id === id);
        return exists ? id : '';
    } catch {
        return '';
    }
}

export function selectedPrompt(settings, presetName, identifier, sourceEnabled) {
    const stored = settings.promptSelections?.[presetName];
    return Object.prototype.hasOwnProperty.call(plainObject(stored), identifier)
        && typeof stored[identifier] === 'boolean'
        ? stored[identifier]
        : !!sourceEnabled;
}

export function setPromptSelection(settings, presetName, identifier, enabled) {
    const unsafe = value => !value || ['__proto__', 'constructor', 'prototype'].includes(value);
    if (unsafe(presetName) || unsafe(identifier)) return;
    if (!Object.prototype.hasOwnProperty.call(settings.promptSelections, presetName)) {
        settings.promptSelections[presetName] = {};
    }
    settings.promptSelections[presetName][identifier] = !!enabled;
}

import { is_send_press } from '/script.js';
import { playMessageSound } from '/scripts/power-user.js';
import { t } from './i18n.js';
import { buildUpgradeRequest } from './prompt.js';
import { resolveProfileId } from './settings.js';
import { profileRequestOverrides, RequestBudgetError, resolveRequestContext } from './request.js';
import { bindSettingsUi, mountUi, unmountUi } from './ui.js';

const EXT_PATH = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const TAG = 'ADU';
const ANCHOR_SELECTOR = '.ace-entry-track-settings';
const ANCHOR_TIMEOUT_MS = 15000;
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_DESKTOP_OS = !IS_IOS && !/Android|webOS|BlackBerry|Opera Mini|IEMobile/i.test(navigator.userAgent);
let inFlight = false;
let activeAbort = null;
let activeMainGeneration = false;
let activeRun = null;
let lastResult = null;
let resultSequence = 0;
let composerWrite = false;
let lifecycleCleanup = null;
let settingsController = null;
const resultListeners = new Set();

const warn = (scope, error) => console.warn(`[${TAG}] ${scope}`, error);

function playCompletionSound() {
    if (IS_DESKTOP_OS) playMessageSound();
}

function setComposerValue(textarea, value) {
    composerWrite = true;
    try {
        textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.selectionStart = textarea.selectionEnd = value.length;
    } finally {
        composerWrite = false;
    }
}

function chatKey() {
    const ctx = SillyTavern.getContext();
    return JSON.stringify([ctx.groupId || null, ctx.groupId ? null : ctx.characterId ?? null,
        ctx.getCurrentChatId?.() ?? ctx.chatId ?? null]);
}

function getLastResult() {
    return lastResult?.chatKey === chatKey() ? lastResult : null;
}

function notifyResult() {
    for (const listener of resultListeners) listener();
}

function canRestoreResult(id) {
    const result = getLastResult();
    const textarea = document.getElementById('send_textarea');
    return !!result && result.id === id && result.applied && !result.edited && !inFlight && !is_send_press
        && textarea === result.textarea && textarea?.value === result.upgraded;
}

function restoreResult(id) {
    if (!canRestoreResult(id)) return false;
    const result = lastResult;
    result.applied = false;
    result.restored = true;
    setComposerValue(result.textarea, result.original);
    if (IS_DESKTOP_OS) result.textarea.focus({ preventScroll: true });
    notifyResult();
    toastr.info(t('restored'), t('title'));
    return true;
}

async function retryDraft(id) {
    if (!canRestoreResult(id)) return false;
    return upgradeDraft(lastResult.settings, lastResult);
}

function isCancellation(error) {
    for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth++) {
        if (current.name === 'AbortError') return true;
        if (/cancel|abort|stop/i.test(String(current.message || current || ''))) return true;
    }
    return false;
}

function cancelUpgrade() {
    if (!inFlight || activeAbort?.signal.aborted) return false;
    activeAbort?.abort(new DOMException('Cancelled by user', 'AbortError'));
    notifyResult();
    if (activeMainGeneration && !is_send_press) SillyTavern.getContext().stopGeneration?.();
    return true;
}

function clearResult() {
    lastResult = null;
    activeRun = null;
    cancelUpgrade();
    notifyResult();
}

function mountRecovery() {
    if (lifecycleCleanup) return;
    const ctx = SillyTavern.getContext();
    const events = ctx.eventTypes || ctx.event_types || {};
    const resetEvents = [events.CHAT_CHANGED, events.MESSAGE_SENT].filter(Boolean);
    for (const event of resetEvents) ctx.eventSource?.on(event, clearResult);
    const onInput = event => {
        if (composerWrite || event.target?.id !== 'send_textarea' || (!activeRun && !lastResult)) return;
        if (!event.target.value.trim() && !event.isComposing) {
            clearResult();
            return;
        }
        let changed = false;
        for (const result of [activeRun, lastResult]) {
            if (!result || result.edited) continue;
            result.edited = true;
            changed = true;
        }
        if (changed) notifyResult();
    };
    document.addEventListener('input', onInput, true);
    lifecycleCleanup = () => {
        for (const event of resetEvents) ctx.eventSource?.removeListener(event, clearResult);
        document.removeEventListener('input', onInput, true);
        clearResult();
        resultListeners.clear();
        lifecycleCleanup = null;
    };
}

const recovery = {
    mount: mountRecovery,
    get: getLastResult,
    canRestore: canRestoreResult,
    restore: restoreResult,
    canRetry: canRestoreResult,
    retry: retryDraft,
    cancel: cancelUpgrade,
    isBusy: () => inFlight,
    isStopping: () => inFlight && !!activeAbort?.signal.aborted,
    subscribe(listener) {
        resultListeners.add(listener);
        return () => resultListeners.delete(listener);
    },
    cleanup() {
        settingsController?.abort();
        settingsController = null;
        lifecycleCleanup?.();
    },
};

function showUndo(id) {
    const restore = () => restoreResult(id);
    const toast = toastr.success(t('replaced'), t('undo'), {
        timeOut: 9000,
        extendedTimeOut: 3000,
        onclick: restore,
    });
    toast?.attr?.({ role: 'button', tabindex: 0, 'aria-label': t('undo') });
    toast?.on?.('keydown', event => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        restore();
    });
}

async function generateViaMainApi(ctx, request, signal) {
    activeMainGeneration = true;
    try {
        const result = await ctx.generateRaw({
            prompt: request.prompt,
            api: 'openai',
            responseLength: request.responseLength,
            trimNames: false,
        });
        signal.throwIfAborted();
        return String(result || '');
    } finally {
        activeMainGeneration = false;
    }
}

async function generateViaProfile(ctx, route, request, signal) {
    const service = ctx.ConnectionManagerRequestService;
    if (!service) throw new Error('Connection Manager is not available');
    const overrides = await profileRequestOverrides(route, request);
    signal.throwIfAborted();
    const result = await service.sendRequest(route.profile.id, request.prompt, request.responseLength, {
        stream: false,
        extractData: true,
        includePreset: route.api.selected !== 'openai',
        signal,
    }, overrides);
    signal.throwIfAborted();
    return String(result?.content || '');
}

async function upgradeDraft(settings, previous = null) {
    if (inFlight || is_send_press) {
        toastr.warning(t('busy'), t('title'));
        return false;
    }
    const ctx = SillyTavern.getContext();
    const profileId = resolveProfileId(settings);
    if (previous && settings.profileId && profileId !== settings.profileId) {
        toastr.warning(t('retryProfileMissing'), t('title'));
        return false;
    }
    if (!profileId && ctx.mainApi !== 'openai') {
        toastr.warning(t('noApi'), t('title'));
        return false;
    }
    const textarea = document.getElementById('send_textarea');
    const composerValue = String(textarea?.value || '');
    if (!textarea || !composerValue.trim()) {
        toastr.info(t('emptyDraft'), t('title'));
        return false;
    }

    const run = {
        id: ++resultSequence,
        chatKey: chatKey(),
        textarea,
        original: previous?.original ?? composerValue,
        settings: structuredClone(settings),
        upgraded: '',
        applied: false,
        edited: false,
    };
    run.settings.profileId = profileId;
    inFlight = true;
    activeAbort = new AbortController();
    const signal = activeAbort.signal;
    activeRun = run;
    notifyResult();
    try {
        const route = resolveRequestContext(profileId);
        const request = await buildUpgradeRequest(run.original, run.settings, signal, route);
        signal.throwIfAborted();
        if (activeRun !== run || run.chatKey !== chatKey()) return false;
        const upgraded = (profileId
            ? await generateViaProfile(ctx, route, request, signal)
            : await generateViaMainApi(ctx, request, signal)).trim();
        if (activeRun !== run || run.chatKey !== chatKey()) return false;
        if (!upgraded) throw new Error('Empty generation result');
        run.upgraded = upgraded;
        lastResult = run;
        const currentTextarea = document.getElementById('send_textarea');
        if (run.edited || currentTextarea !== textarea || currentTextarea.value !== composerValue) {
            run.edited = true;
            toastr.warning(t('draftChanged'), t('title'));
            return false;
        }
        setComposerValue(currentTextarea, upgraded);
        run.applied = currentTextarea.value === upgraded;
        playCompletionSound();
        if (IS_DESKTOP_OS) currentTextarea.focus({ preventScroll: true });
        showUndo(run.id);
        return true;
    } catch (error) {
        if (activeRun !== run || run.chatKey !== chatKey()) return false;
        if (error instanceof RequestBudgetError) {
            toastr.warning(error.message, t('title'));
            return false;
        }
        if (signal.aborted || isCancellation(error)) {
            toastr.info(t('stopped'), t('title'));
            return false;
        }
        warn('upgrade', error);
        toastr.error(t('failed'), t('title'));
        throw error;
    } finally {
        if (activeRun === run) activeRun = null;
        inFlight = false;
        activeAbort = null;
        notifyResult();
    }
}

function placeAfterAnchor(host, block) {
    const anchor = host.querySelector(ANCHOR_SELECTOR);
    if (!anchor || anchor === block) return false;
    anchor.insertAdjacentElement('afterend', block);
    return true;
}

function watchForAnchor(host, block, signal) {
    let timer = 0;
    const stop = () => {
        observer.disconnect();
        window.clearTimeout(timer);
        signal.removeEventListener('abort', stop);
    };
    const observer = new MutationObserver(() => {
        if (placeAfterAnchor(host, block)) stop();
    });
    observer.observe(host, { childList: true });
    signal.addEventListener('abort', stop, { once: true });
    timer = window.setTimeout(stop, ANCHOR_TIMEOUT_MS);
}

async function mountSettings() {
    if (document.querySelector('.ace-draft-upgrader-settings')) return;
    settingsController?.abort();
    settingsController = new AbortController();
    const { signal } = settingsController;
    const response = await fetch(`${EXT_PATH}/settings.html`, { signal });
    if (!response.ok) throw new Error(`Settings template returned ${response.status}`);
    const html = await response.text();
    signal.throwIfAborted();
    const host = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
    if (!host) throw new Error('Extensions settings container is unavailable');
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    const block = template.content.firstElementChild;
    if (!block) throw new Error('Settings template is empty');
    host.appendChild(block);
    bindSettingsUi();
    if (!placeAfterAnchor(host, block)) watchForAnchor(host, block, signal);
}

jQuery(async () => {
    mountUi(upgradeDraft, cancelUpgrade, recovery);
    window.addEventListener('pagehide', unmountUi, { once: true });
    try {
        await mountSettings();
    } catch (error) {
        if (!isCancellation(error)) warn('settings', error);
    }
});

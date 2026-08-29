import { is_send_press } from '/script.js';
import { playMessageSound } from '/scripts/power-user.js';
import { t } from './i18n.js';
import { buildUpgradeRequest } from './prompt.js';
import { resolveProfileId } from './settings.js';
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

const warn = (scope, error) => console.warn(`[${TAG}] ${scope}`, error);

function playCompletionSound() {
    if (IS_DESKTOP_OS) playMessageSound();
}

function setComposerValue(textarea, value) {
    textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.selectionStart = textarea.selectionEnd = value.length;
}

function isCancellation(error) {
    for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth++) {
        if (current.name === 'AbortError') return true;
        if (/cancel|abort|stop/i.test(String(current.message || current || ''))) return true;
    }
    return false;
}

function cancelUpgrade() {
    if (!inFlight) return false;
    activeAbort?.abort(new DOMException('Cancelled by user', 'AbortError'));
    if (activeMainGeneration) SillyTavern.getContext().stopGeneration?.();
    return true;
}

function showUndo(original, upgraded) {
    const restore = () => {
        const textarea = document.getElementById('send_textarea');
        if (!textarea || textarea.value !== upgraded) return;
        setComposerValue(textarea, original);
        textarea.focus();
        toastr.info(t('restored'), t('title'));
    };
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
            responseLength: request.responseLength,
            trimNames: false,
        });
        signal.throwIfAborted();
        return String(result || '');
    } finally {
        activeMainGeneration = false;
    }
}

async function generateViaProfile(ctx, profileId, request, signal) {
    const service = ctx.ConnectionManagerRequestService;
    if (!service) throw new Error('Connection Manager is not available');
    const result = await service.sendRequest(profileId, request.prompt, request.responseLength, {
        stream: false,
        extractData: true,
        includePreset: true,
        signal,
    });
    signal.throwIfAborted();
    return String(result?.content || '');
}

async function upgradeDraft(settings) {
    if (inFlight || is_send_press) {
        toastr.warning(t('busy'), t('title'));
        return false;
    }
    const ctx = SillyTavern.getContext();
    const profileId = resolveProfileId(settings);
    if (!profileId && ctx.mainApi !== 'openai') {
        toastr.warning(t('noApi'), t('title'));
        return false;
    }
    const textarea = document.getElementById('send_textarea');
    const original = String(textarea?.value || '');
    if (!textarea || !original.trim()) {
        toastr.info(t('emptyDraft'), t('title'));
        return false;
    }

    inFlight = true;
    activeAbort = new AbortController();
    try {
        const request = await buildUpgradeRequest(original, settings, activeAbort.signal);
        activeAbort.signal.throwIfAborted();
        const upgraded = (profileId
            ? await generateViaProfile(ctx, profileId, request, activeAbort.signal)
            : await generateViaMainApi(ctx, request, activeAbort.signal)).trim();
        if (!upgraded) throw new Error('Empty generation result');
        const currentTextarea = document.getElementById('send_textarea');
        if (currentTextarea !== textarea || currentTextarea.value !== original) {
            toastr.warning(t('draftChanged'), t('title'));
            return false;
        }
        setComposerValue(currentTextarea, upgraded);
        playCompletionSound();
        window.setTimeout(() => currentTextarea.focus(), 0);
        showUndo(original, upgraded);
        return true;
    } catch (error) {
        if (isCancellation(error)) {
            toastr.info(t('stopped'), t('title'));
            return false;
        }
        warn('upgrade', error);
        toastr.error(t('failed'), t('title'));
        throw error;
    } finally {
        inFlight = false;
        activeAbort = null;
    }
}

function placeAfterAnchor(host, block) {
    const anchor = host.querySelector(ANCHOR_SELECTOR);
    if (!anchor || anchor === block) return false;
    anchor.insertAdjacentElement('afterend', block);
    return true;
}

function watchForAnchor(host, block) {
    let timer = 0;
    const observer = new MutationObserver(() => {
        if (!placeAfterAnchor(host, block)) return;
        observer.disconnect();
        window.clearTimeout(timer);
    });
    observer.observe(host, { childList: true });
    timer = window.setTimeout(() => observer.disconnect(), ANCHOR_TIMEOUT_MS);
}

async function mountSettings() {
    if (document.querySelector('.ace-draft-upgrader-settings')) return;
    const response = await fetch(`${EXT_PATH}/settings.html`);
    if (!response.ok) throw new Error(`Settings template returned ${response.status}`);
    const html = await response.text();
    const host = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
    if (!host) throw new Error('Extensions settings container is unavailable');
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    const block = template.content.firstElementChild;
    if (!block) throw new Error('Settings template is empty');
    host.appendChild(block);
    bindSettingsUi();
    if (!placeAfterAnchor(host, block)) watchForAnchor(host, block);
}

jQuery(async () => {
    mountUi(upgradeDraft, cancelUpgrade);
    try {
        await mountSettings();
    } catch (error) {
        warn('settings', error);
    }

    window.addEventListener('pagehide', unmountUi, { once: true });
});

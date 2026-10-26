import { t } from './i18n.js';

export function mountComposerActions(actions) {
    let host = null;
    let group;
    let undo;
    let retry;
    let reason;
    let editor;
    let listeners;
    let resizeObserver;
    let layoutObserver;
    let frame = 0;
    let shownId;
    let disposed = false;

    function stop() {
        listeners?.abort();
        listeners = null;
        resizeObserver?.disconnect();
        layoutObserver?.disconnect();
        resizeObserver = layoutObserver = null;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        host?.remove();
        host = group = undo = retry = reason = editor = null;
    }

    function eligible(result, textarea) {
        return result && !result.restored && (result.applied || result.edited) && textarea === result.textarea
            && textarea?.isConnected;
    }

    function refresh() {
        if (disposed) return;
        const result = actions.get();
        const textarea = document.getElementById('send_textarea');
        if (!eligible(result, textarea)) { stop(); return; }
        if (host && !host.isConnected) stop();
        if (!host) start(textarea);
        shownId = result.id;
        const busy = actions.isBusy();
        const stopping = actions.isStopping();
        const canUndo = actions.canRestore(shownId);
        const canRetry = busy ? !stopping : actions.canRetry(shownId);
        reason.textContent = canUndo ? '' : t(stopping ? 'stopping' : busy ? 'busy'
            : result.edited || textarea.value !== result.upgraded ? 'composerEdited' : 'restoreUnavailable');
        undo.textContent = t('undo');
        retry.textContent = t(busy ? 'stop' : 'retry');
        undo.setAttribute('aria-disabled', String(!canUndo));
        retry.setAttribute('aria-disabled', String(!canRetry));
        undo.title = canUndo ? t('restoreOriginal') : reason.textContent;
        retry.title = canRetry ? t(busy ? 'quickStop' : 'retryHint') : reason.textContent;
        schedule();
    }

    function start(textarea) {
        editor = textarea;
        listeners = new AbortController();
        host = document.createElement('div');
        host.id = 'adu_composer_actions';
        group = document.createElement('div');
        group.className = 'adu-composer-actions';
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', t('composerActions'));
        reason = document.createElement('span');
        reason.id = 'adu_composer_reason';
        reason.className = 'adu-composer-reason';
        [undo, retry] = ['undo', 'retry'].map(name => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `adu-composer-${name}`;
            button.setAttribute('aria-describedby', reason.id);
            group.appendChild(button);
            return button;
        });
        group.appendChild(reason);
        host.appendChild(group);
        document.documentElement.appendChild(host);
        undo.addEventListener('click', () => {
            if (!actions.restore(shownId)) toastr.info(reason.textContent || t('restoreUnavailable'), t('title'));
        }, { signal: listeners.signal });
        retry.addEventListener('click', async () => {
            if (actions.isBusy()) { actions.cancel(); return; }
            if (!actions.canRetry(shownId)) { toastr.info(reason.textContent || t('restoreUnavailable'), t('title')); return; }
            try { await actions.retry(shownId); } catch {}
        }, { signal: listeners.signal });
        watchLayout();
    }

    function schedule() {
        if (host && !frame) frame = requestAnimationFrame(update);
    }

    function update() {
        frame = 0;
        if (!host) return;
        if (!eligible(actions.get(), document.getElementById('send_textarea'))) { stop(); return; }
        const rect = editor.getBoundingClientRect();
        const viewport = window.visualViewport;
        const left = (viewport?.offsetLeft || 0) + 8;
        const top = (viewport?.offsetTop || 0) + 8;
        const right = left + (viewport?.width || window.innerWidth) - 16;
        const bottom = top + (viewport?.height || window.innerHeight) - 16;
        if (document.hidden || rect.width <= 0 || rect.height <= 0 || right - left < 100
            || rect.right < left || rect.left > right || rect.bottom < top || rect.top > bottom
            || getComputedStyle(editor).visibility === 'hidden') {
            host.style.visibility = 'hidden';
            return;
        }
        group.style.maxWidth = `${right - left}px`;
        const width = group.offsetWidth;
        const height = group.offsetHeight;
        const y = rect.top - height - 6;
        if (y < top) { host.style.visibility = 'hidden'; return; }
        const origin = host.getBoundingClientRect();
        const x = Math.max(left, Math.min(rect.right - width, right - width));
        group.style.left = `${Math.round(x - origin.left)}px`;
        group.style.top = `${Math.round(y - origin.top)}px`;
        host.style.visibility = 'visible';
    }

    function watchLayout() {
        const on = (target, event, handler = schedule, capture = false) => {
            target?.addEventListener(event, handler, { signal: listeners.signal, passive: true, capture });
        };
        resizeObserver = new ResizeObserver(schedule);
        layoutObserver = new MutationObserver(schedule);
        resizeObserver.observe(group);
        for (let parent = editor; parent; parent = parent.parentElement) {
            resizeObserver.observe(parent);
            layoutObserver.observe(parent, {
                attributes: true, attributeFilter: ['style', 'class', 'hidden', 'disabled', 'readonly'],
                childList: true,
            });
        }
        on(window, 'resize');
        on(window.visualViewport, 'resize');
        on(window.visualViewport, 'scroll');
        on(document, 'visibilitychange');
        on(document.fonts, 'loadingdone');
        on(document, 'scroll', event => {
            if (event.target === document || event.target?.contains?.(editor)) schedule();
        }, true);
    }

    const unsubscribe = actions.subscribe(refresh);
    refresh();
    return () => {
        disposed = true;
        unsubscribe();
        stop();
    };
}

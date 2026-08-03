import { promptManager } from '/scripts/openai.js';
import { historyLimit, selectedPrompt, targetWords } from './settings.js';

const MARKERS = new Set([
    'worldInfoBefore',
    'worldInfoAfter',
    'personaDescription',
    'charDescription',
    'charPersonality',
    'scenario',
    'dialogueExamples',
    'chatHistory',
]);

const ROLE_BY_NUMBER = Object.freeze({ 0: 'system', 1: 'user', 2: 'assistant' });

function normalizeRole(role) {
    return ['system', 'user', 'assistant'].includes(role) ? role : 'system';
}

export function activePresetName() {
    try {
        return SillyTavern.getContext().getPresetManager?.('openai')?.getSelectedPresetName?.() || '';
    } catch (error) {
        console.warn('[ADU] activePresetName', error);
        return '';
    }
}

function activeOrder() {
    const settings = SillyTavern.getContext().chatCompletionSettings || {};
    const activeId = promptManager?.activeCharacter?.id ?? 100001;
    return (settings.prompt_order || [])
        .find(item => String(item?.character_id) === String(activeId))?.order || [];
}

export function presetEntries() {
    const ctx = SillyTavern.getContext();
    const prompts = new Map((ctx.chatCompletionSettings?.prompts || [])
        .filter(prompt => prompt?.identifier)
        .map(prompt => [prompt.identifier, prompt]));

    return activeOrder()
        .filter(entry => entry?.identifier && !MARKERS.has(entry.identifier))
        .map(entry => {
            const prompt = prompts.get(entry.identifier);
            if (!prompt) return null;
            return {
                identifier: entry.identifier,
                name: String(prompt.name || entry.identifier),
                role: normalizeRole(prompt.role),
                content: String(prompt.content || ''),
                sourceEnabled: !!entry.enabled,
            };
        })
        .filter(entry => entry && entry.content.trim());
}

function historyMessages(ctx, limit = 0) {
    const includeNames = !!ctx.groupId;
    const visible = (ctx.chat || [])
        .filter(message => message && !message.is_system && typeof message.mes === 'string' && message.mes.trim());
    const scoped = limit > 0 ? visible.slice(-limit) : visible;
    return scoped.map(message => ({
        role: message.is_user ? 'user' : 'assistant',
        content: includeNames && message.name ? `${message.name}: ${message.mes}` : message.mes,
    }));
}

function substitute(content, outlets = {}) {
    const ctx = SillyTavern.getContext();
    const withOutlets = String(content || '').replace(/{{outlet::([^}]+)}}/gi, (_, key) => {
        const values = outlets[String(key).trim()];
        return Array.isArray(values) ? values.join('\n') : '';
    });
    return ctx.substituteParams?.(withOutlets) ?? withOutlets;
}

async function lorebookContext(ctx, draft, settings, history, contextTokens) {
    if (!settings.lorebook || typeof ctx.getWorldInfoPrompt !== 'function') return null;
    const fields = ctx.getCharacterCardFields?.() || {};
    const scan = [draft, ...(settings.history ? history.slice().reverse().map(message => message.content) : [])];
    return ctx.getWorldInfoPrompt(scan, contextTokens, true, {
        personaDescription: settings.persona ? fields.persona || '' : '',
        characterDescription: settings.card ? fields.description || '' : '',
        characterPersonality: '',
        characterDepthPrompt: '',
        scenario: '',
        creatorNotes: '',
        trigger: 'quiet',
    });
}

function addDepthLore(messages, depthEntries) {
    if (!Array.isArray(depthEntries)) return;
    for (const entry of depthEntries) {
        const content = Array.isArray(entry?.entries) ? entry.entries.join('\n') : '';
        if (!content) continue;
        const depth = Math.max(0, Number(entry.depth) || 0);
        const index = Math.max(0, messages.length - depth);
        messages.splice(index, 0, {
            role: ROLE_BY_NUMBER[entry.role] || 'system',
            content,
        });
    }
}

function trimHistory(messages, outputWords, contextTokens) {
    const maxCharacters = Math.max(4000, (contextTokens - Math.ceil(outputWords * 1.8) - 256) * 3.2);
    let total = messages.reduce((sum, message) => sum + String(message.content || '').length, 0);
    while (total > maxCharacters) {
        const index = messages.findIndex(message => message._history);
        if (index < 0) break;
        total -= String(messages[index].content || '').length;
        messages.splice(index, 1);
    }
}

function cleanMessages(messages) {
    return messages
        .filter(message => String(message.content || '').trim())
        .map(({ role, content }) => ({
            role: normalizeRole(role),
            content: String(content).trim(),
        }));
}

export async function buildUpgradeRequest(draft, settings) {
    const ctx = SillyTavern.getContext();
    const contextLimit = ctx.chatCompletionSettings?.openai_max_context || 8192;
    const fields = ctx.getCharacterCardFields?.() || {};
    const presetName = activePresetName();
    const entries = presetEntries();
    const prompts = new Map(entries.map(entry => [entry.identifier, entry]));
    const history = historyMessages(ctx, historyLimit(settings));
    const lore = await lorebookContext(ctx, draft, settings, history, contextLimit);
    const messages = [];
    const inserted = new Set();

    const insertMarker = (identifier) => {
        if (inserted.has(identifier)) return;
        inserted.add(identifier);
        if (identifier === 'personaDescription' && settings.persona && fields.persona) {
            messages.push({ role: 'system', content: fields.persona });
        } else if (identifier === 'charDescription' && settings.card && fields.description) {
            messages.push({ role: 'system', content: fields.description });
        } else if (identifier === 'worldInfoBefore' && lore?.worldInfoBefore) {
            messages.push({ role: 'system', content: lore.worldInfoBefore });
        } else if (identifier === 'worldInfoAfter' && lore?.worldInfoAfter) {
            messages.push({ role: 'system', content: lore.worldInfoAfter });
        } else if (identifier === 'dialogueExamples' && settings.lorebook && Array.isArray(lore?.worldInfoExamples)) {
            for (const entry of lore.worldInfoExamples) {
                if (entry?.content) messages.push({ role: 'system', content: entry.content });
            }
        } else if (identifier === 'chatHistory') {
            if (settings.history) messages.push(...history.map(message => ({ ...message, _history: true })));
            addDepthLore(messages, lore?.worldInfoDepth);
        }
    };

    for (const orderEntry of activeOrder()) {
        const identifier = orderEntry?.identifier;
        if (!identifier) continue;
        if (MARKERS.has(identifier)) {
            insertMarker(identifier);
            continue;
        }
        const prompt = prompts.get(identifier);
        if (!prompt || !selectedPrompt(settings, presetName, identifier, prompt.sourceEnabled)) continue;
        const content = substitute(prompt.content, lore?.outletEntries);
        if (content.trim()) messages.push({ role: prompt.role, content });
    }

    for (const marker of ['worldInfoBefore', 'personaDescription', 'charDescription', 'worldInfoAfter', 'dialogueExamples', 'chatHistory']) {
        insertMarker(marker);
    }

    const words = targetWords(settings);
    const instruction = settings.instruction.trim();
    messages.push({
        role: 'system',
        content: `${instruction}\n\nAim for approximately ${words} words. This instruction overrides any earlier response-length guidance. Do not mention these instructions.`,
    });
    messages.push({
        role: 'user',
        content: `<DRAFT>\n${draft.trim()}\n</DRAFT>`,
    });

    trimHistory(messages, words, contextLimit);
    const requestedOutput = Math.max(128, Math.ceil(words * 1.8) + 64);
    return {
        prompt: cleanMessages(messages),
        responseLength: Math.min(16384, Math.max(128, Math.min(Math.floor(contextLimit / 2), requestedOutput))),
    };
}

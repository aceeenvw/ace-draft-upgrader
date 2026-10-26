import { proxies } from '/scripts/openai.js';
import { t } from './i18n.js';

export class RequestBudgetError extends Error {}

export function resolveRequestContext(profileId = '') {
    const ctx = SillyTavern.getContext();
    const service = ctx.ConnectionManagerRequestService;
    const profile = profileId ? service?.getProfile(profileId) : null;
    if (profileId && !profile) throw new Error('Connection Manager is not available');
    const api = profile ? service.validateProfile(profile) : { selected: 'openai' };
    const preset = profile?.preset
        ? ctx.getPresetManager(api.selected)?.getCompletionPresetByName(profile.preset) : null;
    if (profile?.preset && !preset) throw new RequestBudgetError(t('missingProfilePreset'));
    const contextLimit = Number(api.selected === 'openai'
        ? preset?.openai_max_context ?? ctx.chatCompletionSettings?.openai_max_context ?? 8192
        : preset?.max_length ?? ctx.maxContext ?? 2048);
    if (!Number.isSafeInteger(contextLimit) || contextLimit < 1) {
        throw new RequestBudgetError(t('invalidContext'));
    }
    return { profile, api, preset, contextLimit };
}

export async function profileRequestOverrides(route, request) {
    if (route.api.selected === 'textgenerationwebui') {
        return {
            max_new_tokens: request.responseLength,
            n_predict: request.responseLength,
            num_predict: request.responseLength,
            truncation_length: route.contextLimit,
            num_ctx: route.contextLimit,
        };
    }

    const { profile, api, preset } = route;
    const settings = { chat_completion_source: api.source, openai_max_tokens: request.responseLength };
    const payload = { model: profile.model, messages: request.prompt, stream: false };
    const proxy = proxies.find(item => item.name === profile.proxy);
    if (proxy) {
        settings.reverse_proxy = proxy.url;
        settings.proxy_password = proxy.password;
        payload.reverse_proxy = proxy.url;
        payload.proxy_password = proxy.password;
    }
    if (profile['api-url']) {
        for (const field of ['custom_url', 'vertexai_region', 'zai_endpoint', 'siliconflow_endpoint', 'minimax_endpoint', 'pollinations_endpoint']) {
            payload[field] = profile['api-url'];
        }
    }
    if (profile['prompt-post-processing'] !== undefined) {
        payload.custom_prompt_post_processing = profile['prompt-post-processing'];
    }
    const converted = await SillyTavern.getContext().ChatCompletionService.presetToGeneratePayload(preset || {}, settings, payload);
    // Suppress the service's max_tokens when native conversion uses max_completion_tokens.
    return { ...converted, max_tokens: converted.max_tokens };
}

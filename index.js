// ============================================================
// 绘图酒馆 - PixAI SillyTavern Image Generation Extension
// ============================================================

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'pixai_tavern';
const extensionFolderPath = new URL('.', import.meta.url).pathname.replace(/^\//, '').replace(/\/$/, '');
const LOCAL_VERSION = '1.1.0';
const UPDATE_CHECK_URL = 'https://raw.githubusercontent.com/golangcmj/image/main/manifest.json';

/** @returns {SillyTavern.Context} */
const getContext = () => SillyTavern.getContext();

const defaultSettings = {
    serverUrl: 'http://localhost:9090',
    apiKey: '',
    selectedPresetId: null,
    globalPositivePrompt: '',
    globalNegativePrompt: '',
    triggerRegex: 'image###(.+?)###',
    enabled: true,
};

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 100; // ~5 minutes at 3s interval
const POLL_FETCH_RETRIES = 3;    // retries per single poll fetch on network error
const RENDER_RETRY_DELAY_MS = 250;
const MAX_RENDER_RETRIES = 8;
const MAX_STORY_TEXT_LENGTH = 220;

/** Set of message indices that already have images injected (prevents duplicate processing). */
const processedMessages = new Set();

/** Cache of presets fetched from server. */
let presetsCache = [];

/** Per-message in-flight lock to prevent concurrent regen/variant. */
const inFlightByMessage = new Set();

/** Global HUD instance (created on jQuery ready). */
/** @type {HUDManager|null} */
let hud = null;

/** Structured error for terminal generation failures (task failed/cancelled/timeout/config). */
class TerminalGenerationError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'TerminalGenerationError';
    }
}

/** Set of task IDs currently being recovered — prevents concurrent duplicate recovery. */
const recoveringTaskIds = new Set();

// ============ Pending Task Persistence ============

/**
 * @typedef {{task_id: string, chat_id: string, message_index: number, prompt: string, marker_key: string, started_at: number}} PendingTask
 */

/** Get the pending tasks array from extension settings. */
function getPendingTasks() {
    const settings = getSettings();
    if (!Array.isArray(settings.pendingTasks)) {
        settings.pendingTasks = [];
    }
    return settings.pendingTasks;
}

/** Save a task as pending so it can be recovered after page refresh. */
function addPendingTask(taskId, chatId, messageIndex, prompt, markerKey) {
    const pending = getPendingTasks();
    pending.push({
        task_id: taskId,
        chat_id: chatId,
        message_index: messageIndex,
        prompt,
        marker_key: markerKey || '',
        started_at: Date.now(),
    });
    saveSettingsDebounced();
}

/** Remove a pending task after completion or failure. */
function removePendingTask(taskId) {
    const settings = getSettings();
    const pending = getPendingTasks();
    settings.pendingTasks = pending.filter(t => t.task_id !== taskId);
    saveSettingsDebounced();
}

/**
 * Resume polling for interrupted pending tasks (e.g. after page refresh).
 * Called once during initialization.
 */
async function recoverPendingTasks() {
    const pending = getPendingTasks();
    if (!pending.length) return;

    const currentChatId = getCurrentChatId();
    console.log(`[PixAI] Recovering ${pending.length} pending task(s)...`);

    // Snapshot and clear — each recovery re-adds on failure if needed
    const tasksToRecover = [...pending];

    for (const task of tasksToRecover) {
        // Skip tasks older than 10 minutes — they're likely expired
        if (Date.now() - task.started_at > 10 * 60 * 1000) {
            removePendingTask(task.task_id);
            console.warn(`[PixAI] Skipping expired pending task ${task.task_id}`);
            continue;
        }

        // Deduplicate: skip if already being recovered (e.g. rapid manual validate clicks)
        if (recoveringTaskIds.has(task.task_id)) continue;

        // Resume polling in background (don't block initialization)
        recoverSingleTask(task, currentChatId).catch(err => {
            console.error(`[PixAI] Recovery failed for task ${task.task_id}:`, err);
        });
    }
}

/** Recover a single pending task: poll → save → optionally insert DOM. */
async function recoverSingleTask(task, currentChatId) {
    recoveringTaskIds.add(task.task_id);
    if (hud) hud.addTask(task.task_id, task.prompt);

    try {
        const pollResult = await pollTask(task.task_id);

        if (pollResult.status === 'completed' && pollResult.image_urls?.length) {
            const imageUrl = pollResult.image_urls[0];

            // Only persist if we're in the correct chat to avoid cross-chat corruption
            if (getCurrentChatId() === task.chat_id) {
                saveImageToExtra(task.message_index, imageUrl, task.task_id, task.prompt, task.marker_key);
                const mesEl = getMessageElement(task.message_index);
                if (mesEl.length) {
                    insertImageIntoMessage(mesEl, imageUrl, task.task_id, task.prompt, task.message_index, {
                        markerKey: task.marker_key,
                    });
                }
            }
            // Terminal success — remove pending regardless of chat context
            removePendingTask(task.task_id);

            if (typeof toastr !== 'undefined') {
                toastr.success('恢复的图片生成完成');
            }
        } else {
            // Terminal: completed but no images — remove pending
            removePendingTask(task.task_id);
        }
    } catch (err) {
        if (err instanceof TerminalGenerationError) {
            removePendingTask(task.task_id);
        }
        // Transient errors: keep pending for retry on next load
        const label = err instanceof TerminalGenerationError ? 'terminal' : 'transient';
        console.warn(`[PixAI] Recovery failed (${label}) for task ${task.task_id}:`, err.message);
    } finally {
        recoveringTaskIds.delete(task.task_id);
    }
}

// ============ Settings Helpers ============

/**
 * Get current settings, initializing defaults if needed.
 * @returns {typeof defaultSettings}
 */
function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...defaultSettings };
    }
    const settings = extension_settings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = defaultSettings[key];
        }
    }
    return settings;
}

/**
 * Build trigger regex from settings with safe fallbacks.
 * Uses the `s` flag so `.` can match newlines in prompts.
 * @param {boolean} globalMatch
 * @returns {RegExp}
 */
function buildTriggerRegex(globalMatch = false) {
    const settings = getSettings();
    const pattern = settings.triggerRegex || defaultSettings.triggerRegex;
    const flags = globalMatch ? 'gs' : 's';

    try {
        return new RegExp(pattern, flags);
    } catch (err) {
        console.error('[PixAI] Invalid trigger regex, falling back to default:', pattern, err);
        return new RegExp('image###([\\s\\S]+?)###', flags);
    }
}

/**
 * Resolve message index from SillyTavern event payloads across versions.
 * @param {unknown} messageRef
 * @returns {number|null}
 */
function normalizeMessageIndex(messageRef) {
    const parseIntId = (value) => {
        if (Number.isInteger(value) && value >= 0) return value;
        if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Number.parseInt(value, 10);
            if (Number.isInteger(parsed) && parsed >= 0) return parsed;
        }
        return null;
    };

    const direct = parseIntId(messageRef);
    if (direct != null) return direct;

    if (messageRef && typeof messageRef === 'object') {
        const obj = /** @type {Record<string, unknown>} */ (messageRef);
        const candidateKeys = ['messageId', 'message_id', 'id', 'mesId', 'mesid'];
        for (const key of candidateKeys) {
            const parsed = parseIntId(obj[key]);
            if (parsed != null) return parsed;
        }
    }

    return null;
}

/**
 * Extract prompt text from a regex match.
 * Prefers capture group 1; if missing, falls back to default tag parsing.
 * @param {RegExpMatchArray} match
 * @returns {string}
 */
function extractPromptFromMatch(match) {
    if (!match) return '';
    if (typeof match[1] === 'string') return match[1].trim();

    const full = String(match[0] || '');
    const fallback = /image###([\s\S]+?)###/i.exec(full);
    return fallback?.[1]?.trim() || '';
}

/**
 * Retry message processing when DOM render timing is not ready yet.
 * @param {number} messageId
 * @param {number} attempt
 * @param {string} reason
 */
function scheduleRenderRetry(messageId, attempt, reason) {
    if (attempt >= MAX_RENDER_RETRIES) {
        console.warn(`[PixAI] Skip message ${messageId}: retry limit reached (${reason})`);
        return;
    }

    setTimeout(() => {
        onMessageRendered(messageId, attempt + 1).catch(err => {
            console.error('[PixAI] onMessageRendered retry error:', err);
        });
    }, RENDER_RETRY_DELAY_MS);
}

/**
 * Re-process recent messages, used as a safety net after editor/re-render operations.
 * @param {number} limit
 * @param {number} delayMs
 */
function reprocessRecentMessages(limit = 30, delayMs = 80) {
    const context = getContext();
    const chat = context.chat || [];
    if (!chat.length) return;

    const start = Math.max(0, chat.length - Math.max(1, limit));
    let offset = 0;
    for (let i = start; i < chat.length; i++) {
        processedMessages.delete(i);
        setTimeout(() => {
            onMessageRendered(i).catch(err => {
                console.error('[PixAI] reprocessRecentMessages error:', err);
            });
        }, offset);
        offset += delayMs;
    }
}

/**
 * Check whether a text node is inside a visible/rendered DOM branch.
 * @param {Text} textNode
 * @param {Node} root
 * @returns {boolean}
 */
function isTextNodeInVisibleTree(textNode, root) {
    let el = textNode.parentElement;
    if (!el) return false;

    if (el.closest('script, style, textarea')) return false;
    if (el.closest('[aria-hidden="true"], .hidden, .displayNone, .st-hidden')) return false;

    while (el && el !== root && el !== document.body) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        el = el.parentElement;
    }
    return true;
}

// ============ API Layer ============

/**
 * Shared fetch wrapper for all backend API calls.
 * @param {string} method - HTTP method
 * @param {string} path - API path (e.g. /v1/validate)
 * @param {object|null} body - Request body (JSON)
 * @returns {Promise<any>}
 */
async function apiCall(method, path, body = null) {
    const settings = getSettings();
    const url = `${settings.serverUrl}${path}`;
    /** @type {RequestInit} */
    const opts = {
        method,
        headers: {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json',
        },
    };
    if (body) {
        opts.body = JSON.stringify(body);
    }
    const resp = await fetch(url, opts);
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(err.detail || resp.statusText);
    }
    return resp.json();
}

// ============ Connection Validation ============

/**
 * Validate the API key against the server.
 * Updates the status indicator in the settings panel.
 */
async function validateConnection() {
    const statusEl = $('#pixai_status');
    statusEl
        .text('验证中...')
        .removeClass('pixai-status-connected pixai-status-error pixai-status-disconnected');

    try {
        const data = await apiCall('GET', '/v1/validate');
        statusEl
            .html(`<span class="pixai-status-dot online"></span>${data.username || data.user_id} (${data.points_remaining >= 0 ? data.points_remaining : '∞'} 积分)`)
            .addClass('pixai-status-connected')
            .removeClass('pixai-status-error pixai-status-disconnected');
        console.log('[PixAI] Connection validated:', data.username);

        // Update HUD balance
        if (hud) {
            hud.updateBalance(data.points_remaining ?? -1);
        }

        return true;
    } catch (err) {
        statusEl
            .html(`<span class="pixai-status-dot offline"></span>${err.message}`)
            .addClass('pixai-status-error')
            .removeClass('pixai-status-connected pixai-status-disconnected');
        console.error('[PixAI] Validation failed:', err.message);
        return false;
    }
}

// ============ Presets ============

/**
 * Load presets from the server and populate the dropdown.
 */
async function loadPresets() {
    try {
        const data = await apiCall('GET', '/v1/presets');
        presetsCache = data;

        const select = $('#pixai_preset_select');
        select.empty();

        if (!data.length) {
            select.append('<option value="">-- 无可用预设 --</option>');
            return;
        }

        select.append('<option value="">-- 选择预设 --</option>');
        for (const preset of data) {
            const label = `${preset.name} (${preset.width}x${preset.height}, ${preset.steps}步)`;
            select.append(`<option value="${preset.id}">${escapeHtml(label)}</option>`);
        }

        // Restore previous selection if still available
        const settings = getSettings();
        if (settings.selectedPresetId) {
            const exists = data.some(p => p.id === settings.selectedPresetId);
            if (exists) {
                select.val(settings.selectedPresetId);
            } else {
                settings.selectedPresetId = null;
                saveSettingsDebounced();
            }
        }

        console.log(`[PixAI] Loaded ${data.length} presets`);

        // Update HUD cost for currently selected preset
        if (hud) {
            const settings = getSettings();
            if (settings.selectedPresetId) {
                const selectedPreset = data.find(p => p.id === settings.selectedPresetId);
                if (selectedPreset) {
                    fetchPresetCost(selectedPreset).then(cost => hud.updatePresetCost(cost));
                }
            }
        }
    } catch (err) {
        console.error('[PixAI] Failed to load presets:', err.message);
        if (typeof toastr !== 'undefined') {
            toastr.error('加载预设失败: ' + err.message);
        }
    }
}

// ============ Image Generation ============

/**
 * Submit a generation request using the selected preset.
 * @param {string} prompt - The generation prompt
 * @param {number} messageIndex - SillyTavern chat message index
 * @returns {Promise<{task_id: string, status: string, paid_credit: number}>}
 */
async function generateImage(prompt, messageIndex) {
    const settings = getSettings();

    if (!settings.selectedPresetId) {
        throw new TerminalGenerationError('请先选择生成预设');
    }

    const finalPrompt = settings.globalPositivePrompt
        ? `${settings.globalPositivePrompt.trim()}, ${prompt}`
        : prompt;

    const body = {
        preset_id: settings.selectedPresetId,
        prompt: finalPrompt,
        negative_prompt_override: settings.globalNegativePrompt || null,
        metadata: {
            source: 'sillytavern',
            chat_id: getCurrentChatId(),
            message_index: messageIndex,
            character_name: getCurrentCharacterName(),
        },
    };

    return apiCall('POST', '/v1/images/generate-preset', body);
}

/**
 * Generate a variant — uses full generate endpoint with forced seed=-1
 * to guarantee a different image even if preset has a fixed seed.
 * @param {string} prompt
 * @param {number} messageIndex
 * @returns {Promise<{task_id: string, status: string, paid_credit: number}>}
 */
async function generateVariant(prompt, messageIndex) {
    const settings = getSettings();

    if (!settings.selectedPresetId) {
        throw new TerminalGenerationError('请先选择生成预设');
    }

    // Find the selected preset from loaded list
    const preset = presetsCache.find(p => p.id === settings.selectedPresetId);
    if (!preset) {
        // Fallback: use preset endpoint (seed will be whatever preset defines)
        return generateImage(prompt, messageIndex);
    }

    const finalPrompt = settings.globalPositivePrompt
        ? `${settings.globalPositivePrompt.trim()}, ${prompt}`
        : prompt;

    const body = {
        prompt: finalPrompt,
        negative_prompt: settings.globalNegativePrompt || preset.negative_prompt || 'bad quality, worst quality, lowres',
        model_id: preset.model_id || null,
        width: preset.width || 768,
        height: preset.height || 1280,
        steps: preset.steps || 25,
        cfg_scale: preset.cfg_scale || 7.0,
        sampler: preset.sampler || 'Euler a',
        batch_size: preset.batch_size || 1,
        seed: -1, // Force random seed for variant
        priority: preset.priority || 1000,
        loras: preset.loras || null,
        upscale: preset.upscale || 1,
        upscale_denoising_steps: preset.upscale_denoising_steps || null,
        enable_tile: preset.enable_tile || false,
        enable_adetailer: preset.enable_adetailer || false,
        prompt_helper: preset.prompt_helper || false,
        vae_model_id: preset.vae_model_id || null,
        metadata: {
            source: 'sillytavern',
            chat_id: getCurrentChatId(),
            message_index: messageIndex,
            character_name: getCurrentCharacterName(),
        },
    };

    return apiCall('POST', '/v1/images/generate', body);
}

/**
 * Poll a task until completed or failed.
 * @param {string} taskId
 * @returns {Promise<{task_id: string, status: string, image_urls?: string[]}>}
 */
async function pollTask(taskId) {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
        await delay(POLL_INTERVAL_MS);

        // Retry individual fetch to survive transient network errors
        let data;
        for (let retry = 0; retry <= POLL_FETCH_RETRIES; retry++) {
            try {
                data = await apiCall('GET', `/v1/tasks/${taskId}`);
                break;
            } catch (fetchErr) {
                if (retry >= POLL_FETCH_RETRIES) {
                    console.error(`[PixAI] Poll fetch failed after ${POLL_FETCH_RETRIES + 1} attempts:`, fetchErr);
                    if (hud) hud.updateTask(taskId, 'failed');
                    throw fetchErr;
                }
                console.warn(`[PixAI] Poll fetch retry ${retry + 1}/${POLL_FETCH_RETRIES}:`, fetchErr.message);
                await delay(1000 * (retry + 1)); // backoff: 1s, 2s, 3s
            }
        }

        if (data.status === 'completed') {
            if (hud) {
                const firstUrl = data.image_urls?.[0] || null;
                hud.updateTask(taskId, 'completed', firstUrl);
            }
            return data;
        }
        if (data.status === 'failed' || data.status === 'cancelled') {
            if (hud) hud.updateTask(taskId, 'failed');
            throw new TerminalGenerationError(`生成任务${data.status === 'failed' ? '失败' : '已取消'}`);
        }

        if (hud) hud.updateTask(taskId, 'generating');
    }

    if (hud) hud.updateTask(taskId, 'failed');
    throw new TerminalGenerationError('生成超时，请稍后重试');
}

// ============ Message Processing ============

/**
 * Handler for CHARACTER_MESSAGE_RENDERED event.
 * Scans the message for trigger regex matches and handles image generation.
 * @param {unknown} messageRef - Event payload or rendered message index
 * @param {number} attempt - Internal retry attempt count
 */
async function onMessageRendered(messageRef, attempt = 0) {
    const settings = getSettings();
    if (!settings.enabled) return;

    const messageId = normalizeMessageIndex(messageRef);
    if (messageId == null) {
        console.warn('[PixAI] Unable to resolve message index from event payload:', messageRef);
        return;
    }

    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message) {
        scheduleRenderRetry(messageId, attempt, 'message not found in context.chat');
        return;
    }

    const messageText = message.mes || '';

    // Build regex from settings
    const regex = buildTriggerRegex(true);
    const matches = [...messageText.matchAll(regex)];
    const storedImages = getStoredImagesForMessage(message);
    const hasExtra = storedImages.length > 0;
    if (!matches.length && !hasExtra) return;

    const mesEl = getMessageElement(messageId);
    const mesBody = getMessageBody(mesEl);
    if (!mesEl.length || !mesBody.length) {
        scheduleRenderRetry(messageId, attempt, 'message DOM not ready');
        return;
    }

    if (matches.length) {
        const inserted = showGenerateTrigger(mesEl, messageText, messageId);
        if (!inserted) {
            scheduleRenderRetry(messageId, attempt, 'generate trigger insertion skipped');
            return;
        }
    }

    // Restore previously generated images into the message.
    if (hasExtra) {
        for (const imgData of storedImages) {
            insertImageIntoMessage(
                mesEl,
                imgData.url,
                imgData.task_id || '',
                imgData.prompt || '',
                messageId,
                { markerKey: imgData.marker_key || '' },
            );
        }
    }

    processedMessages.add(messageId);
}

/**
 * Show a clickable "Generate" button in the message.
 * @param {JQuery} mesEl - The .mes element
 * @param {string} messageText - Raw message text
 * @param {number} messageIndex
 */
/**
 * Walk all text nodes inside an element, find the first regex match,
 * split the text node and insert `newEl` in place of the matched text.
 * Returns true if replacement happened.
 */
function replaceTextNodeWithElement(root, regex, newEl, visibleOnly = false) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    /** @type {Array<{node: Text, text: string, start: number, end: number}>} */
    const nodes = [];
    let cursor = 0;
    while (walker.nextNode()) {
        const node = /** @type {Text} */ (walker.currentNode);
        if (visibleOnly && !isTextNodeInVisibleTree(node, root)) continue;
        const text = node.textContent || '';
        const end = cursor + text.length;
        nodes.push({ node, text, start: cursor, end });
        cursor = end;
    }

    if (!nodes.length) return false;

    const fullText = nodes.map(n => n.text).join('');
    if (!fullText) return false;

    // Ensure single-match behavior with index support.
    const flags = (regex.flags || '').replace(/g/g, '');
    const singleRegex = new RegExp(regex.source, flags);
    const match = singleRegex.exec(fullText);
    if (!match || match.index == null || !match[0]) return false;

    const startIndex = match.index;
    const endIndex = startIndex + match[0].length;
    const endNeedle = endIndex - 1;

    const startInfo = nodes.find(n => startIndex >= n.start && startIndex < n.end);
    const endInfo = nodes.find(n => endNeedle >= n.start && endNeedle < n.end);
    if (!startInfo || !endInfo) return false;

    const startOffset = startIndex - startInfo.start;
    const endOffset = endIndex - endInfo.start;
    const before = startInfo.text.slice(0, startOffset);
    const after = endInfo.text.slice(endOffset);
    const el = newEl instanceof $ ? newEl[0] : newEl;

    if (!startInfo.node.parentNode || !endInfo.node.parentNode) return false;

    if (before) {
        startInfo.node.parentNode.insertBefore(document.createTextNode(before), startInfo.node);
    }
    startInfo.node.parentNode.insertBefore(el, startInfo.node);
    if (after) {
        endInfo.node.parentNode.insertBefore(document.createTextNode(after), endInfo.node.nextSibling);
    }

    let removing = false;
    for (const info of nodes) {
        if (info.node === startInfo.node) removing = true;
        if (removing && info.node.parentNode) {
            info.node.parentNode.removeChild(info.node);
        }
        if (info.node === endInfo.node) break;
    }

    return true;
}

function showGenerateTrigger(mesEl, messageText, messageIndex) {
    const mesBody = getMessageBody(mesEl);
    if (!mesBody.length) return false;

    const triggerRegex = buildTriggerRegex(true);
    const matches = [...String(messageText || '').matchAll(triggerRegex)];
    if (!matches.length) return false;

    let handledCount = 0;
    let insertedCount = 0;
    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const prompt = extractPromptFromMatch(match);
        if (!prompt) continue;

        const markerKey = `${messageIndex}:${i}`;
        const hasMarkerAlready = mesBody
            .find('.pixai-generate-trigger, .pixai-image-container')
            .filter((_, el) => $(el).attr('data-marker-key') === markerKey)
            .length > 0;
        const normalizedPrompt = String(prompt).trim();
        const hasPromptAlready = mesBody
            .find('.pixai-generate-trigger, .pixai-image-container')
            .filter((_, el) => String($(el).attr('data-prompt') || '').trim() === normalizedPrompt)
            .length > 0;
        if (hasMarkerAlready || hasPromptAlready) {
            handledCount++;
            continue;
        }

        const btn = $('<button>')
            .addClass('pixai-generate-trigger')
            .attr('data-prompt', prompt)
            .attr('data-mesid', messageIndex)
            .attr('data-marker-key', markerKey)
            .css({
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                margin: '8px 0',
                padding: '8px 16px',
                border: '1px solid #8b5cf6',
                borderRadius: '6px',
                background: 'linear-gradient(135deg, rgba(139,92,246,0.15), rgba(0,240,255,0.1))',
                color: '#8b5cf6',
                fontSize: '13px',
                fontWeight: '500',
                cursor: 'pointer',
                visibility: 'visible',
                opacity: '1',
                width: 'auto',
                height: 'auto',
                overflow: 'visible',
            })
            .text('🎨 生成图片');

        let replaced = false;
        const fullTag = String(match[0] || '');
        if (fullTag) {
            const exactTagRegex = new RegExp(escapeRegex(fullTag), 's');
            replaced = replaceTextNodeWithElement(mesBody[0], exactTagRegex, btn, true);
            if (!replaced) {
                replaced = replaceTextNodeWithElement(mesBody[0], exactTagRegex, btn, false);
            }
        }

        if (!replaced) {
            const genericRegex = buildTriggerRegex(false);
            replaced = replaceTextNodeWithElement(mesBody[0], genericRegex, btn, true);
            if (!replaced) {
                replaced = replaceTextNodeWithElement(mesBody[0], genericRegex, btn, false);
            }
        }

        if (replaced) {
            insertedCount++;
            handledCount++;
        }
    }

    return handledCount > 0;
}

/**
 * Execute the full generate -> poll -> insert flow.
 * @param {JQuery} mesEl
 * @param {string} prompt
 * @param {number} messageIndex
 */
async function doGenerate(mesEl, prompt, messageIndex, options = {}) {
    const originChatId = getCurrentChatId();
    const mesBody = getMessageBody(mesEl);
    const triggerBtn = options.triggerButton ? $(options.triggerButton) : $();

    // Show loading spinner next to the trigger button
    const loadingEl = $(buildLoadingHtml());
    if (triggerBtn.length) {
        triggerBtn.after(loadingEl);
    } else {
        mesBody.append(loadingEl);
    }

    /** Reset the trigger button to clickable state. */
    const resetButton = () => {
        if (triggerBtn.length) {
            triggerBtn.prop('disabled', false).text('🎨 重试生成');
            triggerBtn.data('pixaiBusy', false);
        }
    };

    let taskId = null;
    try {
        const result = await generateImage(prompt, messageIndex);
        taskId = result.task_id;

        // Register task in HUD + persist for crash recovery
        if (hud) hud.addTask(taskId, prompt);
        addPendingTask(taskId, originChatId, messageIndex, prompt, options.markerKey || '');

        const pollResult = await pollTask(taskId);

        loadingEl.remove();

        if (pollResult.status === 'completed' && pollResult.image_urls?.length) {
            const imageUrl = pollResult.image_urls[0];
            const markerKey = options.markerKey || '';

            // Check chat context BEFORE any persistence or DOM work
            const currentChatId = getCurrentChatId();
            if (currentChatId !== originChatId) {
                // Wrong chat active — do NOT write to context.chat (would corrupt).
                // Keep pending task alive so server-side /v1/chat-images can restore later.
                console.warn('[PixAI] Chat changed during generation, skipping local save to avoid corruption');
                if (typeof toastr !== 'undefined') {
                    toastr.info('图片已生成，切回原聊天后刷新可查看');
                }
            } else {
                // Same chat — safe to persist and insert DOM
                removePendingTask(taskId);
                saveImageToExtra(messageIndex, imageUrl, taskId, prompt, markerKey);
                const freshMesEl = getMessageElement(messageIndex);
                if (freshMesEl.length) {
                    insertImageIntoMessage(freshMesEl, imageUrl, taskId, prompt, messageIndex, options);
                } else {
                    console.warn('[PixAI] Message DOM not found after poll, image saved for restore');
                }
                if (typeof toastr !== 'undefined') {
                    toastr.success('图片生成完成');
                }
            }
        } else {
            removePendingTask(taskId);
            resetButton();
            showError(mesBody, '生成完成但未返回图片', triggerBtn.length ? triggerBtn : loadingEl);
        }

        // Refresh balance in HUD after generation completes
        try {
            const refreshData = await apiCall('GET', '/v1/validate');
            if (hud) hud.updateBalance(refreshData.points_remaining ?? -1);
        } catch {
            // Non-critical: balance refresh failure is silently ignored
        }
    } catch (err) {
        loadingEl.remove();
        // Only remove pending on terminal failures; keep for transient network errors
        if (taskId && err instanceof TerminalGenerationError) {
            removePendingTask(taskId);
        }
        resetButton();
        showError(mesBody, err.message, triggerBtn);
        console.error('[PixAI] Generation failed:', err);
    }
}

// ============ Image Injection & Persistence ============

/**
 * Append a styled image container with action buttons to a message.
 * @param {JQuery} mesEl - The .mes element
 * @param {string} imageUrl
 * @param {string} taskId
 * @param {string} prompt
 * @param {number} messageIndex
 */
function insertImageIntoMessage(mesEl, imageUrl, taskId, prompt, messageIndex, options = {}) {
    const mesBody = getMessageBody(mesEl);
    if (!mesBody.length) return;
    const markerKey = String(options.markerKey || '');

    // Marker-level idempotency for coexist mode.
    if (markerKey) {
        const existingByMarker = mesBody
            .find('.pixai-image-container')
            .filter((_, el) => $(el).attr('data-marker-key') === markerKey)
            .first();
        if (existingByMarker.length) {
            existingByMarker.attr('data-task-id', taskId || '');
            existingByMarker.attr('data-prompt', prompt || '');
            existingByMarker.find('img').attr('src', imageUrl);
            return;
        }
    }

    // Avoid duplicate containers for the same task
    if (taskId && mesBody.find(`.pixai-image-container[data-task-id="${taskId}"]`).length) return;

    // Build image container element
    const container = $(`
        <div class="pixai-image-container" data-task-id="${escapeAttr(taskId)}" data-prompt="${escapeAttr(prompt)}" data-mesid="${messageIndex}" data-marker-key="${escapeAttr(markerKey)}">
            <img src="${escapeAttr(imageUrl)}" alt="Generated image" loading="lazy" />
            <div class="pixai-image-actions">
                <button class="pixai-btn pixai-btn-regen" title="重新生成">🔄</button>
                <button class="pixai-btn pixai-btn-variant" title="变体">🎲</button>
            </div>
        </div>
    `);
    container.find('img').on('click', () => window.open(imageUrl, '_blank'));

    // 1) Prefer replacing the exact clicked trigger button (only if still attached to document).
    const clickedBtn = options.triggerButton ? $(options.triggerButton) : $();
    if (clickedBtn.length && document.contains(clickedBtn[0])) {
        clickedBtn.replaceWith(container);
        return;
    }

    // 2) Marker-level replacement for coexist mode.
    if (markerKey) {
        const markerBtn = mesBody
            .find('.pixai-generate-trigger')
            .filter((_, el) => $(el).attr('data-marker-key') === markerKey)
            .first();
        if (markerBtn.length) {
            markerBtn.replaceWith(container);
            return;
        }
    }

    // 3) Prompt-level fallback.
    const promptBtn = mesBody
        .find('.pixai-generate-trigger')
        .filter((_, el) => String($(el).attr('data-prompt') || '').trim() === String(prompt || '').trim())
        .first();
    if (promptBtn.length) {
        promptBtn.replaceWith(container);
        return;
    }

    // 4) Legacy fallback: first trigger in this message.
    const legacyTriggerBtn = mesBody.find(`.pixai-generate-trigger[data-mesid="${messageIndex}"]`).first();
    if (legacyTriggerBtn.length) {
        legacyTriggerBtn.replaceWith(container);
        return;
    }

    // 5) Last fallback: replace raw trigger text in DOM text nodes.
    let replaced = false;
    try {
        const tagRegex = buildTriggerRegex(false);
        replaced = replaceTextNodeWithElement(mesBody[0], tagRegex, container, true);
        if (!replaced) {
            replaced = replaceTextNodeWithElement(mesBody[0], tagRegex, container, false);
        }
    } catch { /* ignore regex errors */ }

    // 6) Final fallback: append at end.
    if (!replaced) mesBody.append(container);
}

/**
 * Save image info to SillyTavern chat message extra field for local persistence.
 * @param {number} messageIndex
 * @param {string} imageUrl
 * @param {string} taskId
 * @param {string} prompt
 */
function saveImageToExtra(messageIndex, imageUrl, taskId, prompt, markerKey = '') {
    const context = getContext();
    if (!context.chat?.[messageIndex]) return;

    const message = context.chat[messageIndex];
    message.extra = message.extra || {};
    const key = String(markerKey || '');

    /** @type {{url: string, task_id: string, prompt: string, marker_key?: string}} */
    const imageData = {
        url: imageUrl,
        task_id: taskId,
        prompt,
        marker_key: key || undefined,
    };

    const images = Array.isArray(message.extra.pixai_images)
        ? message.extra.pixai_images
            .filter(it => it && typeof it === 'object' && it.url)
        : [];

    let replaced = false;
    if (key) {
        for (let i = 0; i < images.length; i++) {
            if (String(images[i].marker_key || '') === key) {
                images[i] = imageData;
                replaced = true;
                break;
            }
        }
    }

    if (!replaced && prompt) {
        for (let i = 0; i < images.length; i++) {
            if (String(images[i].prompt || '') === String(prompt)) {
                images[i] = imageData;
                replaced = true;
                break;
            }
        }
    }

    if (!replaced) images.push(imageData);

    message.extra.pixai_images = images;
    // Keep backward compatibility for old consumers.
    message.extra.pixai_image = imageData;
    context.saveChat();
}

/**
 * Read all locally stored images from message.extra, compatible with old/new formats.
 * @param {SillyTavern.ChatMessage} message
 * @returns {Array<{url: string, task_id: string, prompt: string, marker_key?: string}>}
 */
function getStoredImagesForMessage(message) {
    const extra = message?.extra || {};
    /** @type {Array<{url: string, task_id: string, prompt: string, marker_key?: string}>} */
    const out = [];

    if (Array.isArray(extra.pixai_images)) {
        for (const item of extra.pixai_images) {
            if (!item?.url) continue;
            out.push({
                url: item.url,
                task_id: item.task_id || '',
                prompt: item.prompt || '',
                marker_key: item.marker_key || undefined,
            });
        }
    }

    if (extra.pixai_image?.url) {
        const old = extra.pixai_image;
        const already = out.some(item =>
            item.url === old.url
            && String(item.task_id || '') === String(old.task_id || '')
            && String(item.prompt || '') === String(old.prompt || ''),
        );
        if (!already) {
            out.push({
                url: old.url,
                task_id: old.task_id || '',
                prompt: old.prompt || '',
                marker_key: old.marker_key || undefined,
            });
        }
    }

    return out;
}

/**
 * Restore images for a chat session.
 * 1) Check SillyTavern message extra.pixai_image fields
 * 2) For missing images, call the server API to restore
 * @param {string} chatId
 */
async function restoreImagesForChat(chatId) {
    const context = getContext();
    const chat = context.chat;
    if (!chat?.length) return;

    // Track which messages already have local image data
    const messagesNeedingRestore = [];

    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        const messageText = String(message?.mes || '');
        const matches = [...messageText.matchAll(buildTriggerRegex(true))];
        const storedImages = getStoredImagesForMessage(message);
        if (!matches.length && !storedImages.length) continue;

        const mesEl = getMessageElement(i);
        const mesBody = getMessageBody(mesEl);
        if (!mesEl.length || !mesBody.length) continue;

        if (matches.length) {
            showGenerateTrigger(mesEl, messageText, i);
        }

        if (storedImages.length) {
            for (const imgData of storedImages) {
                insertImageIntoMessage(
                    mesEl,
                    imgData.url,
                    imgData.task_id || '',
                    imgData.prompt || '',
                    i,
                    { markerKey: imgData.marker_key || '' },
                );
            }
            processedMessages.add(i);
        } else {
            messagesNeedingRestore.push(i);
            processedMessages.add(i);
        }
    }

    // If some messages might have server-side images, try to restore
    if (!messagesNeedingRestore.length) return;

    try {
        const serverImages = await apiCall('GET', `/v1/chat-images?chat_id=${encodeURIComponent(chatId)}`);
        if (!Array.isArray(serverImages) || !serverImages.length) return;

        // Build a map of message_index -> image list from server
        /** @type {Map<number, Array<{image_url: string, task_id?: string, prompt?: string, marker_key?: string, markerKey?: string}>>} */
        const serverMap = new Map();
        for (const img of serverImages) {
            const idx = Number.parseInt(String(img.message_index), 10);
            if (!Number.isInteger(idx) || !img.image_url) continue;
            if (!serverMap.has(idx)) serverMap.set(idx, []);
            serverMap.get(idx).push(img);
        }

        for (const msgIdx of messagesNeedingRestore) {
            const serverImageList = serverMap.get(msgIdx);
            if (!serverImageList?.length) continue;

            const mesEl = getMessageElement(msgIdx);
            const mesBody = getMessageBody(mesEl);
            if (!mesEl.length || !mesBody.length) continue;

            const messageText = String(chat[msgIdx]?.mes || '');
            if (messageText) {
                showGenerateTrigger(mesEl, messageText, msgIdx);
            }

            for (const serverImg of serverImageList) {
                const imageUrl = serverImg.image_url;
                const taskId = serverImg.task_id || '';
                const prompt = serverImg.prompt || '';
                const markerKey = serverImg.marker_key || serverImg.markerKey || '';

                insertImageIntoMessage(
                    mesEl,
                    imageUrl,
                    taskId,
                    prompt,
                    msgIdx,
                    { markerKey },
                );
                saveImageToExtra(msgIdx, imageUrl, taskId, prompt, markerKey);
            }
            processedMessages.add(msgIdx);
        }
    } catch (err) {
        console.warn('[PixAI] Failed to restore images from server:', err.message);
    }
}
// ============ Context Helpers ============

/**
 * Get the current chat ID from SillyTavern context.
 * @returns {string|null}
 */
function getCurrentChatId() {
    const context = getContext();
    return context.chatId || null;
}

/**
 * Get the current character name.
 * @returns {string}
 */
function getCurrentCharacterName() {
    const context = getContext();
    return context.name2 || '';
}

/**
 * Get the jQuery element for a message by its index.
 * @param {number} messageIndex
 * @returns {JQuery}
 */
function getMessageElement(messageIndex) {
    return $(`.mes[mesid="${messageIndex}"]`);
}

/**
 * Resolve the message body element. Prefer visible `.mes_text` when duplicates exist.
 * @param {JQuery} mesEl
 * @returns {JQuery}
 */
function getMessageBody(mesEl) {
    if (!mesEl?.length) return $();
    const visible = mesEl.find('.mes_text:visible').first();
    if (visible.length) return visible;
    // Fallback: choose the most likely active body instead of returning empty.
    const candidates = mesEl.find('.mes_text').filter((_, el) =>
        !$(el).closest('[aria-hidden="true"], .hidden, .displayNone, .st-hidden').length,
    );
    if (candidates.length) return candidates.last();
    return mesEl.find('.mes_text').last();
}

// ============ Story Share ============

/**
 * Collect story segments from the current chat conversation.
 * Only include image-related segments to avoid uploading full chat history.
 * @returns {Array<{text: string, image_url?: string, image_prompt?: string}>}
 */
function collectStorySegments() {
    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return [];

    const triggerRegex = buildTriggerRegex(true);

    /** @type {Array<{text: string, image_url?: string, image_prompt?: string}>} */
    const segments = [];
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        const rawText = String(msg?.mes || '');
        if (!rawText) continue;

        // Prefer new multi-image storage, fallback to legacy single-image field.
        const storedImages = getStoredImagesForMessage(msg);
        if (!storedImages.length) continue;

        const relatedText = rawText
            .replace(triggerRegex, '')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, MAX_STORY_TEXT_LENGTH);

        for (const img of storedImages) {
            if (!img?.url) continue;
            segments.push({
                text: relatedText || (img.prompt || '').substring(0, MAX_STORY_TEXT_LENGTH),
                image_url: img.url,
                image_prompt: img.prompt || '',
            });
        }
    }
    return segments;
}

/**
 * Share the current conversation as a story via the backend API.
 * Submits the story for async generation and begins polling for completion.
 */
async function shareStory() {
    const settings = extension_settings[MODULE_NAME];
    const chatId = getCurrentChatId();
    if (!chatId) {
        if (typeof toastr !== 'undefined') {
            toastr.warning('No active chat');
        }
        return;
    }

    const segments = collectStorySegments();
    if (segments.length === 0) {
        if (typeof toastr !== 'undefined') {
            toastr.warning('当前聊天没有已生成图片内容可分享');
        }
        return;
    }

    const characterName = getCurrentCharacterName();
    const title = /** @type {string} */ ($('#pixai_story_title').val())?.trim()
        || `${characterName} - ${new Date().toLocaleDateString()}`;

    const statusEl = $('#pixai_share_status');
    statusEl.show().html('<span style="color: var(--pixai-cyan);">Creating story page...</span>');
    $('#pixai_share_btn').prop('disabled', true);

    try {
        const result = await apiCall('POST', '/v1/stories', {
            title,
            character_name: characterName,
            chat_id: chatId,
            segments,
        });

        const shareToken = result.share_token;
        const shareUrl = `${settings.serverUrl}/shared/${shareToken}`;

        // Add to HUD for tracking (if HUD is available)
        if (hud) {
            hud.addStoryTask(shareToken, title);
        }

        // Start polling for completion
        pollStoryStatus(shareToken, shareUrl, statusEl);
    } catch (err) {
        statusEl.html(`<span style="color: var(--pixai-danger);">${escapeHtml(err.message)}</span>`);
        $('#pixai_share_btn').prop('disabled', false);
    }
}

/**
 * Poll the story generation status until completed, failed, or timed out.
 * @param {string} shareToken - The story's share token
 * @param {string} shareUrl - The full URL for the story page
 * @param {JQuery} statusEl - jQuery element to show status updates
 */
async function pollStoryStatus(shareToken, shareUrl, statusEl) {
    const maxAttempts = 60; // 5 minutes max at 5s intervals
    for (let i = 0; i < maxAttempts; i++) {
        await delay(5000); // Poll every 5 seconds

        try {
            const result = await apiCall('GET', `/v1/stories/${shareToken}/status`);

            if (result.status === 'completed') {
                statusEl.html(`
                    <div style="color: var(--pixai-success);">Story page ready!</div>
                    <a href="${escapeAttr(shareUrl)}" target="_blank" class="pixai-btn" style="display:inline-block; margin-top:6px; text-decoration:none;">
                        Open Story
                    </a>
                    <button class="pixai-btn pixai-copy-link" data-url="${escapeAttr(shareUrl)}" style="margin-top:6px;">
                        Copy Link
                    </button>
                `);
                $('#pixai_share_btn').prop('disabled', false);

                // Update HUD
                if (hud) {
                    hud.updateStoryTask(shareToken, 'completed', shareUrl);
                }

                if (typeof toastr !== 'undefined') {
                    toastr.success('Story page is ready!');
                }
                return;
            }

            if (result.status === 'failed') {
                statusEl.html('<span style="color: var(--pixai-danger);">Generation failed. Try again.</span>');
                $('#pixai_share_btn').prop('disabled', false);
                if (hud) {
                    hud.updateStoryTask(shareToken, 'failed');
                }
                return;
            }

            // Still pending -- update elapsed time indicator
            const elapsed = (i + 1) * 5;
            statusEl.html(`<span style="color: var(--pixai-cyan);">AI is creating your story page... (${elapsed}s)</span>`);
        } catch (err) {
            // Network error -- keep polling, don't abort
            console.warn('[PixAI] Poll story status error:', err);
        }
    }

    statusEl.html('<span style="color: var(--pixai-warning);">Timed out. Check "My Stories" page later.</span>');
    $('#pixai_share_btn').prop('disabled', false);
}

// ============ UI Helpers ============

/**
 * Build the loading spinner HTML.
 * @returns {string}
 */
function buildLoadingHtml() {
    return `
        <div class="pixai-loading-spinner">
            <div class="pixai-spinner-ring"></div>
            <div class="pixai-loading-text">GENERATING...</div>
        </div>
    `;
}

/**
 * Show an error message in a message body near a reference element, or at the end.
 * @param {JQuery} mesBody
 * @param {string} message
 * @param {JQuery} [nearEl] - Optional element to insert the error near (after).
 */
function showError(mesBody, message, nearEl) {
    const errorEl = $(`<div class="pixai-error">⚠ ${escapeHtml(message)}</div>`);
    if (nearEl?.length && nearEl.closest(mesBody).length) {
        nearEl.after(errorEl);
    } else {
        mesBody.append(errorEl);
    }
}

/**
 * Escape HTML entities.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/**
 * Escape a string for use in HTML attributes.
 * @param {string} str
 * @returns {string}
 */
function escapeAttr(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Escape literal text for use in RegExp source.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
    return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Promise-based delay.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Reset processed state (e.g., on chat change).
 */
function resetProcessedState() {
    processedMessages.clear();
}

/**
 * Ensure a standalone mobile entry button exists for opening the HUD.
 * This is an inline-style fallback in case theme CSS hides the default HUD badge.
 * @param {HUDManager|null} hudInstance
 */
function ensureMobileHudEntryButton(hudInstance) {
    const isTouchLike = window.matchMedia('(hover: none), (pointer: coarse)').matches || window.innerWidth <= 900;
    const id = 'pixai-mobile-hud-entry';
    const existing = $(`#${id}`);

    if (!isTouchLike) {
        existing.remove();
        return;
    }

    /** @type {JQuery} */
    let btn = existing;
    if (!btn.length) {
        btn = $(`<button id="${id}" type="button" aria-label="打开生图面板">生图面板</button>`);
        $('body').append(btn);
        btn.on('click', () => {
            if (!hudInstance || !hudInstance.el?.length) {
                if (typeof toastr !== 'undefined') {
                    toastr.warning('生图面板未初始化，请刷新页面');
                }
                return;
            }
            hudInstance.toggle();
        });
    }

    btn.css({
        position: 'fixed',
        right: 'calc(env(safe-area-inset-right, 0px) + 12px)',
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 128px)',
        zIndex: '2147483640',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: '104px',
        height: '40px',
        padding: '0 12px',
        borderRadius: '999px',
        border: '1px solid #00f0ff',
        background: 'rgba(10, 10, 26, 0.92)',
        color: '#e0e0f0',
        fontSize: '13px',
        fontWeight: '600',
        letterSpacing: '0.2px',
        boxShadow: '0 0 14px rgba(0, 240, 255, 0.35)',
        backdropFilter: 'blur(8px)',
        opacity: '1',
        visibility: 'visible',
        pointerEvents: 'auto',
    });
}

// ============ HUD Panel ============

/**
 * HUDManager — Cyberpunk floating heads-up display.
 * Shows real-time balance, preset cost, and multi-task queue status.
 */
class HUDManager {
    constructor() {
        /** @type {Map<string, {prompt: string, status: string, imageUrl: string|null, addedAt: number}>} */
        this.tasks = new Map();
        /** @type {number} */
        this.balance = -1;
        /** @type {number} */
        this.presetCost = 0;
        /** @type {boolean} */
        this.expanded = false;
        /** @type {JQuery|null} */
        this.el = null;
        this._createDOM();
    }

    /** Build and inject the HUD DOM into the page body. */
    _createDOM() {
        const hudHtml = `
            <div id="pixai-hud" class="pixai-hud pixai-hud-collapsed">
                <div class="pixai-hud-badge" title="PixAI HUD">
                    <span class="pixai-hud-badge-icon">AI</span>
                    <span class="pixai-hud-badge-label">生图</span>
                    <span class="pixai-hud-balance">--</span>
                    <span class="pixai-hud-ring"></span>
                </div>
                <div class="pixai-hud-panel">
                    <div class="pixai-hud-header">
                        <span>⚡ 绘图酒馆</span>
                        <button class="pixai-hud-close">✕</button>
                    </div>
                    <div class="pixai-hud-stats">
                        <div class="pixai-hud-stat">
                            <span class="pixai-hud-stat-label">余额</span>
                            <span class="pixai-hud-stat-value pixai-hud-balance-display">--</span>
                        </div>
                        <div class="pixai-hud-stat">
                            <span class="pixai-hud-stat-label">本预设</span>
                            <span class="pixai-hud-stat-value pixai-hud-cost-display">-- 积分/张</span>
                        </div>
                    </div>
                    <div class="pixai-hud-queue">
                        <div class="pixai-hud-queue-empty">暂无任务</div>
                    </div>
                </div>
            </div>
        `;
        const hudEl = $(hudHtml);
        $('body').append(hudEl);
        this.el = hudEl;
        this.el.removeClass('pixai-hud-expanded').addClass('pixai-hud-collapsed');

        // Mobile fallback: enforce visible anchor position even when theme CSS overrides extension styles.
        if (window.matchMedia('(hover: none), (pointer: coarse)').matches) {
            this.el.css({
                bottom: 'calc(env(safe-area-inset-bottom, 0px) + 72px)',
                right: 'calc(env(safe-area-inset-right, 0px) + 10px)',
                zIndex: '2147483000',
                display: 'block',
                opacity: '1',
                visibility: 'visible',
            });
        }

        // Badge click -> expand
        hudEl.find('.pixai-hud-badge').on('click', () => this.toggle());
        // Close button -> collapse
        hudEl.find('.pixai-hud-close').on('click', () => this.collapse());
    }

    /** Toggle between expanded and collapsed states. */
    toggle() {
        this.expanded ? this.collapse() : this.expand();
    }

    /** Expand the panel (hides badge). */
    expand() {
        if (!this.el) return;
        this.el.removeClass('pixai-hud-collapsed').addClass('pixai-hud-expanded');
        this.el.css({ display: 'block', visibility: 'visible', opacity: '1' });
        this.expanded = true;
        $('#pixai-mobile-hud-entry').hide();
    }

    /** Collapse to badge (hides panel). */
    collapse() {
        if (!this.el) return;
        this.el.removeClass('pixai-hud-expanded').addClass('pixai-hud-collapsed');
        this.el.css({ display: 'block', visibility: 'visible', opacity: '1' });
        this.expanded = false;
        $('#pixai-mobile-hud-entry').show();
    }

    /**
     * Update the displayed balance.
     * @param {number} balance - Balance in points (-1 = unlimited)
     */
    updateBalance(balance) {
        this.balance = balance;
        if (!this.el) return;
        this.el.find('.pixai-hud-balance').text(balance >= 0 ? balance : '∞');
        this.el.find('.pixai-hud-balance-display').text(balance >= 0 ? `${balance} 积分` : '无限');
    }

    /**
     * Update the displayed preset cost.
     * @param {number} cost - Cost per generation in points
     */
    updatePresetCost(cost) {
        this.presetCost = cost;
        if (!this.el) return;
        this.el.find('.pixai-hud-cost-display').text(`${cost} 积分/张`);
    }

    /**
     * Register a new task in the HUD queue.
     * @param {string} taskId
     * @param {string} prompt
     */
    addTask(taskId, prompt) {
        this.tasks.set(taskId, { prompt, status: 'queued', imageUrl: null, addedAt: Date.now() });
        this._renderQueue();
        if (this.el) {
            this.el.find('.pixai-hud-ring').addClass('pixai-hud-ring-active');
        }
    }

    /**
     * Update a task's status in the HUD queue.
     * @param {string} taskId
     * @param {'queued'|'generating'|'completed'|'failed'} status
     * @param {string|null} [imageUrl]
     */
    updateTask(taskId, status, imageUrl = null) {
        const task = this.tasks.get(taskId);
        if (!task) return;
        task.status = status;
        if (imageUrl) task.imageUrl = imageUrl;
        this._renderQueue();

        // Auto-remove completed tasks after 5 seconds
        if (status === 'completed') {
            setTimeout(() => {
                this.tasks.delete(taskId);
                this._renderQueue();
            }, 5000);
        }

        // Update ring animation based on whether any tasks are active
        const hasActive = [...this.tasks.values()].some(
            t => t.status === 'queued' || t.status === 'generating',
        );
        if (!hasActive && this.el) {
            this.el.find('.pixai-hud-ring').removeClass('pixai-hud-ring-active');
        }
    }

    /**
     * Register a story generation task in the HUD queue.
     * @param {string} shareToken - The story's share token
     * @param {string} title - The story title
     */
    addStoryTask(shareToken, title) {
        const displayLabel = `[Story] ${title}`;
        this.tasks.set(`story-${shareToken}`, {
            prompt: displayLabel,
            status: 'generating',
            imageUrl: null,
            addedAt: Date.now(),
        });
        this._renderQueue();
        if (this.el) {
            this.el.find('.pixai-hud-ring').addClass('pixai-hud-ring-active');
        }
    }

    /**
     * Update a story task's status in the HUD queue.
     * @param {string} shareToken - The story's share token
     * @param {'completed'|'failed'} status
     * @param {string|null} [shareUrl]
     */
    updateStoryTask(shareToken, status, shareUrl = null) {
        this.updateTask(`story-${shareToken}`, status, shareUrl);
    }

    /** Re-render the task queue list. */
    _renderQueue() {
        if (!this.el) return;
        const queue = this.el.find('.pixai-hud-queue');

        if (this.tasks.size === 0) {
            queue.html('<div class="pixai-hud-queue-empty">暂无任务</div>');
            return;
        }

        /** @type {Record<string, string>} */
        const statusIcons = { queued: '⏳', generating: '⚡', completed: '✅', failed: '❌' };
        let html = '';
        for (const [taskId, task] of this.tasks) {
            const icon = statusIcons[task.status] || '❓';
            const statusClass = `pixai-hud-task-${task.status}`;
            const promptShort = task.prompt.length > 20
                ? task.prompt.substring(0, 20) + '...'
                : task.prompt;
            html += `<div class="pixai-hud-task ${statusClass}" data-task-id="${escapeAttr(taskId)}">
                <span class="pixai-hud-task-icon">${icon}</span>
                <span class="pixai-hud-task-prompt">${escapeHtml(promptShort)}</span>
            </div>`;
        }
        queue.html(html);
    }
}

/**
 * Fetch real generation cost for a preset from the backend pricing engine.
 * @param {{id: number}} preset
 * @returns {Promise<number>}
 */
async function fetchPresetCost(preset) {
    try {
        const data = await apiCall('GET', `/v1/presets/${preset.id}/cost`);
        return data.estimated_cost ?? 0;
    } catch (e) {
        console.warn('[PixAI] Failed to fetch preset cost:', e);
        return 0;
    }
}

// ============ Update Check ============

/**
 * Compare two semver strings (e.g. "1.0.0" vs "1.1.0").
 * @returns {number} positive if a > b, negative if a < b, 0 if equal
 */
function compareSemver(a, b) {
    const pa = String(a || '0').split('.').map(Number);
    const pb = String(b || '0').split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/**
 * Check GitHub for a newer version and show a NEW badge if available.
 */
async function checkForUpdate() {
    try {
        const resp = await fetch(UPDATE_CHECK_URL, { cache: 'no-store' });
        if (!resp.ok) return;
        const remote = await resp.json();
        const remoteVersion = remote?.version;
        if (!remoteVersion || compareSemver(remoteVersion, LOCAL_VERSION) <= 0) return;

        // Show NEW badge next to the header
        const header = $('.pixai-header');
        if (header.length && !header.find('.pixai-update-badge').length) {
            header.append(
                `<span class="pixai-update-badge" title="有新版本 v${remoteVersion} 可用" ` +
                `style="margin-left:6px;padding:1px 6px;font-size:10px;font-weight:700;` +
                `border-radius:4px;background:linear-gradient(135deg,#ff00aa,#8b5cf6);` +
                `color:#fff;vertical-align:middle;cursor:default;animation:neonPulse 2s ease-in-out infinite">` +
                `NEW</span>`,
            );
        }
        console.log(`[PixAI] Update available: v${LOCAL_VERSION} → v${remoteVersion}`);
    } catch {
        // Non-critical: silently ignore update check failures
    }
}

// ============ Initialization ============

jQuery(async () => {
    console.log('[PixAI] 绘图酒馆 extension loading...');

    // Initialize settings
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...defaultSettings };
    }
    const settings = getSettings();

    // Load settings HTML into SillyTavern settings panel
    try {
        const html = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings').append(html);
    } catch (err) {
        console.error('[PixAI] Failed to load settings panel:', err);
        if (typeof toastr !== 'undefined') {
            toastr.error('绘图酒馆: 加载设置面板失败');
        }
        return;
    }

    // ---- Initialize HUD ----
    hud = new HUDManager();
    console.log('[PixAI] HUD panel initialized');
    ensureMobileHudEntryButton(hud);
    $(window).on('resize orientationchange', () => ensureMobileHudEntryButton(hud));

    // ---- Bind UI elements to settings ----

    // Server URL
    $('#pixai_server_url')
        .val(settings.serverUrl)
        .on('input', function () {
            settings.serverUrl = $(this).val();
            saveSettingsDebounced();
        });

    // API Key
    $('#pixai_api_key')
        .val(settings.apiKey)
        .on('input', function () {
            settings.apiKey = $(this).val();
            saveSettingsDebounced();
        });

    // Enabled toggle
    $('#pixai_enabled')
        .prop('checked', settings.enabled)
        .on('change', function () {
            settings.enabled = $(this).prop('checked');
            saveSettingsDebounced();
        });

    // Global positive prompt
    $('#pixai_global_positive')
        .val(settings.globalPositivePrompt)
        .on('input', function () {
            settings.globalPositivePrompt = $(this).val();
            saveSettingsDebounced();
        });

    // Global negative prompt
    $('#pixai_global_negative')
        .val(settings.globalNegativePrompt)
        .on('input', function () {
            settings.globalNegativePrompt = $(this).val();
            saveSettingsDebounced();
        });

    // Trigger regex
    $('#pixai_trigger_regex')
        .val(settings.triggerRegex)
        .on('input', function () {
            settings.triggerRegex = $(this).val();
            saveSettingsDebounced();
        });

    // Preset selection
    $('#pixai_preset_select').on('change', function () {
        settings.selectedPresetId = parseInt($(this).val()) || null;
        saveSettingsDebounced();

        // Update HUD preset cost
        if (hud && settings.selectedPresetId) {
            const preset = presetsCache.find(p => p.id === settings.selectedPresetId);
            if (preset) {
                fetchPresetCost(preset).then(cost => hud.updatePresetCost(cost));
            }
        } else if (hud) {
            hud.updatePresetCost(0);
        }
    });

    // ---- Action Buttons ----

    // Validate connection
    $('#pixai_validate_btn').on('click', async () => {
        const valid = await validateConnection();
        if (valid) {
            await loadPresets();
            recoverPendingTasks().catch(err => {
                console.warn('[PixAI] Pending task recovery failed:', err);
            });
            if (typeof toastr !== 'undefined') {
                toastr.success('连接验证成功');
            }
        }
    });

    // Refresh presets
    $('#pixai_preset_refresh').on('click', async () => {
        await loadPresets();
        if (typeof toastr !== 'undefined') {
            toastr.success(`已刷新预设列表 (${presetsCache.length} 个)`);
        }
    });

    // Share story button
    $('#pixai_share_btn').on('click', shareStory);

    // Generate trigger button (delegated to survive message re-renders)
    $(document).on('click', '.pixai-generate-trigger', async function () {
        const $btn = $(this);
        if ($btn.data('pixaiBusy')) return;

        const prompt = String($btn.attr('data-prompt') || '').trim();
        const messageIndex = Number.parseInt($btn.attr('data-mesid') || '', 10);
        const markerKey = String($btn.attr('data-marker-key') || '');
        if (!prompt || !Number.isInteger(messageIndex)) return;

        const mesEl = getMessageElement(messageIndex);
        if (!mesEl.length) return;

        $btn.data('pixaiBusy', true);
        $btn.prop('disabled', true).text('⏳ 生成中...');

        // doGenerate handles button reset on error internally
        await doGenerate(mesEl, prompt, messageIndex, { triggerButton: $btn, markerKey });
    });

    // ---- Delegated Event Handlers for Image Action Buttons ----

    // Regenerate button — same prompt, same preset, re-generate
    $(document).on('click', '.pixai-btn-regen', async function () {
        const container = $(this).closest('.pixai-image-container');
        const prompt = container.data('prompt');
        const messageIndex = parseInt(container.data('mesid'));
        const markerKey = String(container.attr('data-marker-key') || '');
        const originChatId = getCurrentChatId();

        if (inFlightByMessage.has(messageIndex)) return;
        inFlightByMessage.add(messageIndex);

        container.addClass('pixai-loading');
        container.find('.pixai-btn-regen, .pixai-btn-variant').prop('disabled', true);

        try {
            const result = await generateImage(prompt, messageIndex);
            const pollResult = await pollTask(result.task_id);

            if (pollResult.status === 'completed' && pollResult.image_urls?.length) {
                const newUrl = pollResult.image_urls[0];
                if (getCurrentChatId() !== originChatId) {
                    // Wrong chat — skip save to avoid corruption
                    console.warn('[PixAI] Chat changed during regen, skipping');
                } else {
                    saveImageToExtra(messageIndex, newUrl, result.task_id, prompt, markerKey);
                    const freshContainer = getMessageElement(messageIndex)
                        .find(`.pixai-image-container[data-marker-key="${markerKey}"]`).first();
                    const target = freshContainer.length ? freshContainer : container;
                    target.find('img').attr('src', newUrl);
                    target.attr('data-task-id', result.task_id);
                }
                if (typeof toastr !== 'undefined') {
                    toastr.success('重新生成完成');
                }
            }
        } catch (err) {
            console.error('[PixAI] Regeneration failed:', err);
            if (typeof toastr !== 'undefined') {
                toastr.error('重新生成失败: ' + err.message);
            }
        } finally {
            inFlightByMessage.delete(messageIndex);
            container.removeClass('pixai-loading');
            container.find('.pixai-btn-regen, .pixai-btn-variant').prop('disabled', false);
        }
    });

    // Variant button — uses preset but forces seed=-1 for randomness
    $(document).on('click', '.pixai-btn-variant', async function () {
        const container = $(this).closest('.pixai-image-container');
        const prompt = container.data('prompt');
        const messageIndex = parseInt(container.data('mesid'));
        const markerKey = String(container.attr('data-marker-key') || '');
        const originChatId = getCurrentChatId();

        if (inFlightByMessage.has(messageIndex)) return;
        inFlightByMessage.add(messageIndex);

        container.addClass('pixai-loading');
        container.find('.pixai-btn-regen, .pixai-btn-variant').prop('disabled', true);

        try {
            const result = await generateVariant(prompt, messageIndex);
            const pollResult = await pollTask(result.task_id);

            if (pollResult.status === 'completed' && pollResult.image_urls?.length) {
                const newUrl = pollResult.image_urls[0];
                if (getCurrentChatId() !== originChatId) {
                    console.warn('[PixAI] Chat changed during variant, skipping');
                } else {
                    saveImageToExtra(messageIndex, newUrl, result.task_id, prompt, markerKey);
                    const freshContainer = getMessageElement(messageIndex)
                        .find(`.pixai-image-container[data-marker-key="${markerKey}"]`).first();
                    const target = freshContainer.length ? freshContainer : container;
                    target.find('img').attr('src', newUrl);
                    target.attr('data-task-id', result.task_id);
                }
                if (typeof toastr !== 'undefined') {
                    toastr.success('变体生成完成');
                }
            }
        } catch (err) {
            console.error('[PixAI] Variant generation failed:', err);
            if (typeof toastr !== 'undefined') {
                toastr.error('变体生成失败: ' + err.message);
            }
        } finally {
            inFlightByMessage.delete(messageIndex);
            container.removeClass('pixai-loading');
            container.find('.pixai-btn-regen, .pixai-btn-variant').prop('disabled', false);
        }
    });

    // Copy link button (delegated, for story share results)
    $(document).on('click', '.pixai-copy-link', function () {
        const url = $(this).data('url');
        navigator.clipboard.writeText(url).then(() => {
            if (typeof toastr !== 'undefined') {
                toastr.success('Link copied!');
            }
        });
    });

    // ---- Register SillyTavern Events ----

    const { eventSource, event_types } = getContext();

    // Process new character messages for trigger regex
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messagePayload) => {
        setTimeout(() => {
            onMessageRendered(messagePayload).catch(err => {
                console.error('[PixAI] onMessageRendered error:', err);
            });
        }, 300);
    });

    // Also handle user messages (in case user pastes trigger text)
    eventSource.on(event_types.USER_MESSAGE_RENDERED, (messagePayload) => {
        setTimeout(() => {
            onMessageRendered(messagePayload).catch(err => {
                console.error('[PixAI] onMessageRendered error:', err);
            });
        }, 300);
    });

    // Restore images when chat changes
    eventSource.on(event_types.CHAT_CHANGED, () => {
        resetProcessedState();
        const chatId = getCurrentChatId();
        if (chatId) {
            setTimeout(() => {
                restoreImagesForChat(chatId).catch(err => {
                    console.warn('[PixAI] restoreImagesForChat error:', err);
                });
            }, 500);
        }
    });

    // Handle message edits — re-process the edited message
    eventSource.on(event_types.MESSAGE_EDITED, (messagePayload) => {
        const messageId = normalizeMessageIndex(messagePayload);
        if (messageId == null) {
            console.warn('[PixAI] MESSAGE_EDITED without resolvable id, fallback to recent message reprocess');
            setTimeout(() => reprocessRecentMessages(40, 60), 250);
            setTimeout(() => reprocessRecentMessages(40, 60), 900);
            return;
        }

        // Some edit flows render twice; run a delayed second pass to avoid marker rollback.
        processedMessages.delete(messageId);
        setTimeout(() => {
            onMessageRendered(messageId).catch(err => {
                console.error('[PixAI] onMessageRendered error:', err);
            });
        }, 220);
        setTimeout(() => {
            processedMessages.delete(messageId);
            onMessageRendered(messageId).catch(err => {
                console.error('[PixAI] onMessageRendered error:', err);
            });
        }, 900);
    });

    // Compatibility: some ST versions emit MESSAGE_UPDATED instead of MESSAGE_EDITED.
    if (event_types.MESSAGE_UPDATED) {
        eventSource.on(event_types.MESSAGE_UPDATED, (messagePayload) => {
            const messageId = normalizeMessageIndex(messagePayload);
            if (messageId == null) {
                setTimeout(() => reprocessRecentMessages(40, 60), 250);
                return;
            }
            processedMessages.delete(messageId);
            setTimeout(() => {
                onMessageRendered(messageId).catch(err => {
                    console.error('[PixAI] onMessageRendered error:', err);
                });
            }, 260);
        });
    }

    // Handle message swipes — reset and re-process
    eventSource.on(event_types.MESSAGE_SWIPED, () => {
        resetProcessedState();
        const context = getContext();
        if (context.chat?.length) {
            const lastIdx = context.chat.length - 1;
            setTimeout(() => {
                onMessageRendered(lastIdx).catch(err => {
                    console.error('[PixAI] onMessageRendered error:', err);
                });
            }, 300);
        }
    });

    // ---- Auto-Validate on Load ----

    if (settings.apiKey && settings.serverUrl) {
        try {
            const valid = await validateConnection();
            if (valid) {
                await loadPresets();
                // Recover any tasks interrupted by page refresh / browser close
                recoverPendingTasks().catch(err => {
                    console.warn('[PixAI] Pending task recovery failed:', err);
                });
            }
        } catch (err) {
            console.warn('[PixAI] Auto-validate failed:', err);
        }
    }

    // ---- Check for updates ----
    checkForUpdate();

    console.log('[PixAI] 绘图酒馆 extension loaded successfully');
});

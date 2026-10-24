/**
 * Omni API Tracker for SillyTavern (v1.6.0 自由悬浮胶囊与全域向量版)
 * 以模型资产为中心（Model-First），支持可拖拽悬浮胶囊、全域向量/重排统计 + 冒险者公会手账
 * 
 * @author ymf2317-tech & @黎吧啦
 * @version 1.6.0
 */

import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const EXTENSION_NAME = 'st-omni-api-tracker';
const LEGACY_USAGE_KEY = 'st_usage_tracker_local';
const HEARTBEAT_INTERVAL = 15000; // 15秒活跃心跳

// --- 顶层状态机哨兵（捕获酒馆官方生成生命周期）---
let currentGenerationState = {
    isGenerating: false,
    type: null,
    startTime: 0,
};

if (typeof eventSource !== 'undefined' && typeof event_types !== 'undefined') {
    try {
        eventSource.on(event_types.GENERATION_STARTED, (type, params, dryRun) => {
            if (dryRun) return;
            currentGenerationState.isGenerating = true;
            currentGenerationState.type = (typeof type === 'string') ? type.toLowerCase() : 'normal';
            currentGenerationState.startTime = Date.now();
        });

        eventSource.on(event_types.GENERATION_STOPPED, () => {
            currentGenerationState.isGenerating = false;
            currentGenerationState.type = null;
        });

        eventSource.on(event_types.MESSAGE_RECEIVED, () => {
            currentGenerationState.isGenerating = false;
            currentGenerationState.type = null;
        });
    } catch (e) {
        console.warn('[OmniTracker] Event listener init warn:', e);
    }
}

// --- RPG 冒险者等级与成就配置 ---
const RPG_CONFIG = {
    titles: [
        { h: 0, t: "迷途旅人", desc: "初次踏入这间赛博酒馆，一切都是未知的。" },
        { h: 20, t: "酒馆常客", desc: "老板娘已经记住了你喜欢的饮品。" },
        { h: 50, t: "见习编剧", desc: "你开始试图掌控角色的命运走向。" },
        { h: 100, t: "角色塑造者", desc: "你的文字赋予了纸片人灵魂。" },
        { h: 200, t: "世界架构师", desc: "世界书的条目在你的脑海中构建成型。" },
        { h: 400, t: "提示词大师", desc: "你掌握了与机魂沟通的咒语。" },
        { h: 700, t: "破壁人", desc: "第四面墙对你来说形同虚设。" },
        { h: 1000, t: "时间领主", desc: "你可以随意回溯时间，修改因果。" },
        { h: 1500, t: "虚空行者", desc: "你游走在上下文的边缘，窥视代码的深渊。" },
        { h: 2000, t: "奇点见证者", desc: "你即是这片虚拟宇宙的终极主宰。" }
    ],
    achievements: [
        { id: 'first_step', name: '初次链接', desc: '累计活跃时长达到 10 小时', check: (d, total) => total >= 10 },
        { id: 'immersion', name: '沉浸体验', desc: '累计活跃时长达到 50 小时', check: (d, total) => total >= 50 },
        { id: 'addicted', name: '赛博依赖', desc: '累计活跃时长达到 200 小时', check: (d, total) => total >= 200 },
        { id: 'ascension', name: '数字飞升', desc: '累计活跃时长达到 1000 小时', check: (d, total) => total >= 1000 },
        { id: 'marathon', name: '马拉松选手', desc: '单日在线活跃超过 8 小时', check: (entries) => entries.some(e => e.hours >= 8) },
        { id: 'limit_break', name: '极限肝帝', desc: '单日在线活跃超过 16 小时', check: (entries) => entries.some(e => e.hours >= 16) },
        { id: 'weekend', name: '周末狂欢', desc: '周末总时长占比 > 40% (需总时长>50h)', check: (entries, total) => {
            const we = entries.filter(e => e.day === 0 || e.day === 6).reduce((s, i) => s + i.hours, 0);
            return total > 50 && (we / total > 0.4);
        }},
        { id: 'streak_5', name: '无限续杯', desc: '连续 5 天每天超过 2 小时', check: (entries) => {
            let streak = 0;
            for (let e of entries) {
                if (e.hours >= 2) streak++; else streak = 0;
                if (streak >= 5) return true;
            }
            return false;
        }},
        { id: 'streak_14', name: '命运羁绊', desc: '连续 14 天每天超过 1 小时', check: (entries) => {
            let streak = 0;
            for (let e of entries) {
                if (e.hours >= 1) streak++; else streak = 0;
                if (streak >= 14) return true;
            }
            return false;
        }},
        { id: 'long_term', name: '细水长流', desc: '活跃天数超过 30 天', check: (entries) => entries.length >= 30 }
    ]
};

// 4大客观通道定义
const CATEGORY_MAP = {
    chat: { label: '主聊对话', color: '#38bdf8', icon: 'fa-comment-dots' },
    scripts: { label: '扩展/预设/后台', color: '#f59e0b', icon: 'fa-bolt' },
    tts: { label: '语音合成(TTS)', color: '#14b8a6', icon: 'fa-volume-high' },
    vectors: { label: '向量与重排', color: '#10b981', icon: 'fa-database' },
};

// 默认存储结构
const defaultSettings = {
    enabled: true,
    showInTopBar: true,
    badgeMode: 'floating', // 'floating' (自由悬浮胶囊) | 'topbar' (顶栏内嵌)
    badgePos: null, // { top: number, left: number }
    totals: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0 },
    today: { date: getTodayDateString(), prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0 },
    session: { startTime: Date.now(), prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0 },
    byCategory: {
        chat: { label: '主聊对话', prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0, color: '#38bdf8' },
        scripts: { label: '扩展/预设/后台', prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0, color: '#f59e0b' },
        tts: { label: '语音合成(TTS)', prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0, color: '#14b8a6' },
        vectors: { label: '向量与重排', prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0, color: '#10b981' },
    },
    byModel: {}, // { modelName: { prompt_tokens, completion_tokens, total_tokens, requests, byCategory: { ... } } }
    recentLogs: [],
    activeTime: {
        daily: {},
        totalMs: 0,
    }
};

let settings = null;

function getTodayDateString() {
    return new Date().toISOString().slice(0, 10);
}

function loadSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = JSON.parse(JSON.stringify(defaultSettings));
    }
    settings = extension_settings[EXTENSION_NAME];

    for (const key of Object.keys(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = JSON.parse(JSON.stringify(defaultSettings[key]));
        }
    }

    if (settings.badgeMode === undefined) {
        settings.badgeMode = 'floating';
    }

    // 确保 4 大通道存在
    for (const [ck, cv] of Object.entries(defaultSettings.byCategory)) {
        if (!settings.byCategory[ck]) {
            settings.byCategory[ck] = JSON.parse(JSON.stringify(cv));
        }
    }

    if (!settings.activeTime) {
        settings.activeTime = { daily: {}, totalMs: 0 };
    }

    migrateLegacyActiveTime();

    const today = getTodayDateString();
    if (settings.today.date !== today) {
        settings.today = {
            date: today,
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            requests: 0,
        };
        safeSaveSettings();
    }
}

function migrateLegacyActiveTime() {
    try {
        let legacy = localStorage.getItem(LEGACY_USAGE_KEY);
        if (!legacy && window.extension_settings && window.extension_settings[LEGACY_USAGE_KEY]) {
            legacy = JSON.stringify(window.extension_settings[LEGACY_USAGE_KEY]);
        }
        if (legacy) {
            const parsed = JSON.parse(legacy);
            if (typeof parsed === 'object') {
                let mergedAny = false;
                for (const [day, ms] of Object.entries(parsed)) {
                    if (typeof ms === 'number') {
                        if (!settings.activeTime.daily[day] || settings.activeTime.daily[day] < ms) {
                            settings.activeTime.daily[day] = ms;
                            mergedAny = true;
                        }
                    }
                }
                if (mergedAny) {
                    recalculateTotalActiveMs();
                    safeSaveSettings();
                }
            }
        }
    } catch (e) {
        console.warn('[OmniTracker] Legacy time migration:', e);
    }
}

/**
 * 智能清洗与去水函数（修复旧版本误抓产生的虚假数据）
 * 100% 保护：真实回复 (Completion)、TTS语音、向量/重排模型 (Vectors)、RPG活跃时长与成就
 */
function cleanHistoricalWaterData() {
    if (!settings || !settings.byModel) return { cleanedTokens: 0, removedModels: [] };

    let removedFakeModels = [];
    let adjustedPromptTokens = 0;
    const bm = settings.byModel;

    // 1. 扫描并清除无任何输出且非向量/TTS的纯假模型
    for (const [m, v] of Object.entries(bm)) {
        const ml = m.toLowerCase();
        if (m === 'Unknown' || ml.includes('tts') || ml.includes('mimo')) continue;

        // 保护向量模型：向量模型天生无 completion_tokens
        const isVectorModel = v.byCategory?.vectors ||
            ml.includes('embed') ||
            ml.includes('rerank') ||
            ml.includes('bge') ||
            ml.includes('vector');
        if (isVectorModel) continue;

        const c = v.completion_tokens || 0;
        const p = v.prompt_tokens || 0;

        if (c === 0 && p > 0) {
            removedFakeModels.push(m);
            delete bm[m];
        }
    }

    // 2. 校准被正则修剪严重注水的真实文本模型（输入输出比畸形 > 60:1）
    for (const [m, v] of Object.entries(bm)) {
        const ml = m.toLowerCase();
        if (ml.includes('tts') || ml.includes('mimo') || ml.includes('embed') || ml.includes('rerank') || ml.includes('bge') || v.byCategory?.vectors) continue;
        const c = v.completion_tokens || 0;
        const p = v.prompt_tokens || 0;

        if (c > 0 && p > 0) {
            const ratio = p / c;
            if (ratio > 60) {
                const realisticPrompt = Math.round(c * 25);
                if (p > realisticPrompt) {
                    adjustedPromptTokens += (p - realisticPrompt);
                    v.prompt_tokens = realisticPrompt;
                    v.total_tokens = realisticPrompt + c;
                    v.requests = Math.max(1, Math.round(c / 1500));

                    if (v.byCategory && v.byCategory.chat) {
                        v.byCategory.chat.prompt_tokens = realisticPrompt;
                        v.byCategory.chat.total_tokens = realisticPrompt + c;
                        v.byCategory.chat.requests = v.requests;
                    }
                }
            }
        }
    }

    // 3. 清理 recentLogs 中的假记录（保留真实回复、TTS与向量检索）
    const oldLogs = settings.recentLogs || [];
    const cleanLogs = oldLogs.filter(r => (r.completion_tokens > 0 || r.category === 'tts' || r.category === 'vectors'));
    settings.recentLogs = cleanLogs;

    // 4. 重新聚合 totals
    let totP = 0, totC = 0, totReq = 0;
    for (const v of Object.values(bm)) {
        totP += (v.prompt_tokens || 0);
        totC += (v.completion_tokens || 0);
        totReq += (v.requests || 0);
    }

    settings.totals = {
        prompt_tokens: totP,
        completion_tokens: totC,
        total_tokens: totP + totC,
        requests: totReq,
    };

    // 5. 重新分配 byCategory
    for (const catKey of Object.keys(settings.byCategory)) {
        settings.byCategory[catKey].prompt_tokens = 0;
        settings.byCategory[catKey].completion_tokens = 0;
        settings.byCategory[catKey].total_tokens = 0;
        settings.byCategory[catKey].requests = 0;
    }

    for (const [m, v] of Object.entries(bm)) {
        const ml = m.toLowerCase();
        const isTTS = ml.includes('tts') || ml.includes('mimo');
        const isVec = ml.includes('embed') || ml.includes('rerank') || ml.includes('bge') || v.byCategory?.vectors;
        const catKey = isTTS ? 'tts' : (isVec ? 'vectors' : 'chat');
        const target = settings.byCategory[catKey];
        target.prompt_tokens += (v.prompt_tokens || 0);
        target.completion_tokens += (v.completion_tokens || 0);
        target.total_tokens += (v.total_tokens || 0);
        target.requests += (v.requests || 0);
    }

    if (settings.today) {
        settings.today.prompt_tokens = Math.min(settings.today.prompt_tokens, settings.totals.prompt_tokens);
        settings.today.completion_tokens = Math.min(settings.today.completion_tokens, settings.totals.completion_tokens);
        settings.today.total_tokens = settings.today.prompt_tokens + settings.today.completion_tokens;
    }

    safeSaveSettings();
    updateTopBarUI();

    return {
        removedModels: removedFakeModels,
        cleanedTokens: adjustedPromptTokens,
        newTotal: settings.totals.total_tokens,
    };
}

function recalculateTotalActiveMs() {
    let sum = 0;
    for (const ms of Object.values(settings.activeTime.daily)) {
        sum += (ms || 0);
    }
    settings.activeTime.totalMs = sum;
}

function safeSaveSettings() {
    try {
        if (typeof saveSettingsDebounced === 'function') {
            saveSettingsDebounced();
        }
    } catch (_) {}
}

function formatTokens(num) {
    if (!num) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return Number(num).toLocaleString();
}

function msToHourMin(ms) {
    const totalMin = Math.floor((ms || 0) / 60000);
    const hours = Math.floor(totalMin / 60);
    const minutes = totalMin % 60;
    return { hours, minutes };
}

function formatDuration(ms) {
    const { hours, minutes } = msToHourMin(ms);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

// --- 活跃时长心跳 ---
let isWindowActive = true;
window.addEventListener('focus', () => { isWindowActive = true; });
window.addEventListener('blur', () => { isWindowActive = false; });
document.addEventListener('visibilitychange', () => { isWindowActive = !document.hidden; });

function addActiveDuration(ms) {
    if (!settings || !settings.activeTime) return;
    const today = getTodayDateString();
    if (!settings.activeTime.daily[today]) {
        settings.activeTime.daily[today] = 0;
    }
    settings.activeTime.daily[today] += ms;
    settings.activeTime.totalMs = (settings.activeTime.totalMs || 0) + ms;

    try {
        localStorage.setItem(LEGACY_USAGE_KEY, JSON.stringify(settings.activeTime.daily));
    } catch (_) {}

    safeSaveSettings();
    updateTopBarUI();
}

setInterval(() => {
    if (isWindowActive && !document.hidden) {
        addActiveDuration(HEARTBEAT_INTERVAL);
    }
}, HEARTBEAT_INTERVAL);

/**
 * 现代大模型高精度分词估算器（BPE/cl100k 标准）
 */
function estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    const chineseChars = (text.match(/[\u4e00-\u9fa5\u3000-\u303f\uff01-\uff5e]/g) || []).length;
    const otherChars = text.length - chineseChars;
    const newlines = (text.match(/\n/g) || []).length;
    const estimated = Math.round(chineseChars * 1.05 + (otherChars / 3.2) + (newlines * 0.5));
    return Math.max(1, estimated);
}

/**
 * 通用多层模型探测器：支持大模型、向量模型与重排模型
 */
function extractModelName(obj, url) {
    if (obj && typeof obj === 'object') {
        const candidates = [
            obj.model,
            obj.model_name,
            obj.engine,
            obj.embedding_model,
            obj.rerank_model,
            obj.sourceSettings?.model,
            obj.sourceSettings?.ollama_model,
            obj.sourceSettings?.embedding_model,
            obj.generate_data?.model,
            obj.api?.model,
            obj.overrides?.model,
            obj.settings?.model,
            obj.request?.model,
            obj.payload?.model,
            obj.body?.model,
        ];
        for (const c of candidates) {
            if (typeof c === 'string' && c.trim()) return c.trim();
        }
    }

    if (url) {
        try {
            const urlObj = new URL(url, 'http://dummy.local');
            const mParam = urlObj.searchParams.get('model');
            if (mParam) return mParam.trim();
        } catch (_) {}
    }

    // 向量端点默认兜底
    if (url) {
        const u = String(url).toLowerCase();
        if (u.includes('/rerank')) return 'bge-reranker';
        if (u.includes('/embed') || u.includes('/embeddings')) return 'embedding-model';
    }

    return '';
}

/**
 * 统一 Token 用量解析（兼容 OpenAI/Claude/Gemini/Ollama/Cohere/BGE）
 */
function applyUsageFrom(trackerItem, usageObj) {
    if (!usageObj || typeof usageObj !== 'object') return false;

    const pIn = usageObj.prompt_tokens ?? usageObj.input_tokens ?? usageObj.promptTokenCount ?? usageObj.prompt_token_count ?? usageObj.prompt_eval_count;
    const cOut = usageObj.completion_tokens ?? usageObj.output_tokens ?? usageObj.candidatesTokenCount ?? usageObj.candidates_token_count ?? usageObj.eval_count;
    const tot = usageObj.total_tokens ?? usageObj.totalTokenCount ?? usageObj.total_token_count;

    let hit = false;
    if (typeof pIn === 'number' && pIn > 0) { trackerItem.prompt_tokens = pIn; hit = true; }
    if (typeof cOut === 'number' && cOut > 0) { trackerItem.completion_tokens = cOut; hit = true; }
    // 向量/重排通常只有 total_tokens 且无 completion，直接归入 prompt_tokens
    if (!hit && typeof tot === 'number' && tot > 0) {
        trackerItem.prompt_tokens = tot;
        hit = true;
    }
    return hit;
}

/**
 * 统一提取输出文本
 */
function extractOutputText(data) {
    if (!data || typeof data !== 'object') return '';

    const candidates = [
        data?.choices?.[0]?.message?.content,
        data?.choices?.[0]?.text,
        data?.choices?.[0]?.delta?.content,
        data?.message?.content,
        data?.content?.[0]?.text,
        data?.content,
        data?.candidates?.[0]?.content?.parts?.[0]?.text,
        data?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join(''),
        data?.output_text,
        data?.response,
        data?.text,
    ];

    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c;
        if (Array.isArray(c)) {
            const joined = c.map(x => (typeof x === 'string' ? x : '')).join('');
            if (joined.trim()) return joined;
        }
    }
    return '';
}

/**
 * 通用精准拦截探针：只拦截真正的 LLM 生成、向量、重排与语音端点
 */
function isTargetLLMApi(url, options) {
    if (!url) return false;
    let urlStr = '';
    if (typeof url === 'string') urlStr = url;
    else if (url instanceof URL) urlStr = url.href;
    else if (url && url.url) urlStr = url.url;
    urlStr = urlStr.toLowerCase();

    // 1. 排除酒馆内部纯数据传输与本地处理
    if (urlStr.includes('/chat-completions/process') ||
        urlStr.includes('/chat-completions/bias') ||
        urlStr.includes('/chat-completions/status') ||
        urlStr.includes('/tokenizers/') ||
        urlStr.includes('/token-count') ||
        urlStr.includes('/api/chats/') ||
        urlStr.includes('/api/plugins/')) {
        return false;
    }

    // 2. 酒馆官方生成出口
    if (urlStr.includes('/api/backends/chat-completions/generate') ||
        urlStr.includes('/api/backends/text-completions/generate') ||
        urlStr.includes('/api/backends/kobold/generate') ||
        urlStr.includes('/api/novelai/generate')) {
        return true;
    }

    // 3. 外部直连大模型生成端点
    if (urlStr.includes('/chat/completions') ||
        urlStr.endsWith('/completions') ||
        urlStr.includes('/completions?')) {
        if (urlStr.includes('/models')) return false;
        return true;
    }

    // 4. 向量嵌入与 Rerank 端点（涵盖 狐忆 / 玄狐台 / Ollama / 硅基流动 / ST原生向量 / 自建 /embed）
    if (urlStr.includes('/embeddings') ||
        urlStr.includes('/embed') ||
        urlStr.includes('/rerank') ||
        urlStr.includes('/api/vector/')) {
        return true;
    }

    // 5. 语音合成 (TTS)
    if (urlStr.includes('/audio/speech') ||
        urlStr.includes('/api/backends/tts') ||
        urlStr.includes('/tts')) {
        return true;
    }

    return false;
}

/**
 * 客观轻量归因（4大客观通道）
 */
function classifyRequest(stack, url, reqBodyParsed, isStream, modelName) {
    const s = (stack || '').toLowerCase();
    const u = (url || '').toLowerCase();
    const m = (modelName || '').toLowerCase();

    // 1. 语音合成 (TTS)
    if (m.includes('tts') || m.includes('mimo') || m.includes('voice') || m.includes('speech') || u.includes('/audio/') || u.includes('/tts')) {
        return { category: 'tts', caller: '语音合成' };
    }

    // 2. 向量检索与重排 (Embeddings / Rerank)
    if (u.includes('/embeddings') || u.includes('/embed') || u.includes('/rerank') || u.includes('/api/vector') || m.includes('embed') || m.includes('rerank') || m.includes('bge') || m.includes('qwen3-embed')) {
        let caller = '向量检索';
        if (u.includes('/rerank') || m.includes('rerank')) caller = 'Rerank精排';
        else if (u.includes('/embed') || u.includes('/embeddings') || m.includes('embed')) caller = 'Embedding嵌入';
        else if (u.includes('/api/vector')) caller = 'ST原生向量';
        return { category: 'vectors', caller };
    }

    // 3. 官方主聊正文判断（凭证：官方请求体 type）
    const reqType = (typeof reqBodyParsed?.type === 'string') ? reqBodyParsed.type.toLowerCase() : '';
    const MAIN_CHAT_TYPES = ['normal', 'regenerate', 'swipe', 'continue', 'impersonate', 'first_message'];

    if (MAIN_CHAT_TYPES.includes(reqType)) {
        return { category: 'chat', caller: '主聊对话' };
    }

    // 4. 其余所有的 LLM 调用归入“扩展/预设/后台”
    let caller = '扩展与预设';
    if (reqType === 'quiet') caller = '后台静默(quiet)';
    else if (s.includes('slash')) caller = 'Slash命令/宏';
    else if (s.includes('prompt-template')) caller = '提示词模板';
    else if (s.includes('call-generate-service')) caller = '预设生成服务';
    else if (s.includes('translate')) caller = '翻译工具';
    else if (s.includes('summary') || s.includes('summar')) caller = '文本摘要';

    return { category: 'scripts', caller };
}

/**
 * 记录用量并持久化
 */
function recordApiUsage(item) {
    if (!settings || !settings.enabled) return;

    const pTokens = Math.max(0, parseInt(item.prompt_tokens) || 0);
    const cTokens = Math.max(0, parseInt(item.completion_tokens) || 0);
    const tTokens = pTokens + cTokens;

    const today = getTodayDateString();
    if (settings.today.date !== today) {
        settings.today = { date: today, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0 };
    }

    settings.totals.prompt_tokens += pTokens;
    settings.totals.completion_tokens += cTokens;
    settings.totals.total_tokens += tTokens;
    settings.totals.requests += 1;

    settings.today.prompt_tokens += pTokens;
    settings.today.completion_tokens += cTokens;
    settings.today.total_tokens += tTokens;
    settings.today.requests += 1;

    settings.session.prompt_tokens += pTokens;
    settings.session.completion_tokens += cTokens;
    settings.session.total_tokens += tTokens;
    settings.session.requests += 1;

    const cat = settings.byCategory[item.category] || settings.byCategory.scripts;
    cat.prompt_tokens += pTokens;
    cat.completion_tokens += cTokens;
    cat.total_tokens += tTokens;
    cat.requests += 1;

    const mName = item.model || 'Unknown';
    if (!settings.byModel[mName]) {
        settings.byModel[mName] = {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            requests: 0,
            byCategory: {},
        };
    }
    const mObj = settings.byModel[mName];
    mObj.prompt_tokens += pTokens;
    mObj.completion_tokens += cTokens;
    mObj.total_tokens += tTokens;
    mObj.requests += 1;

    if (!mObj.byCategory) mObj.byCategory = {};
    if (!mObj.byCategory[item.category]) {
        mObj.byCategory[item.category] = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0 };
    }
    const mCat = mObj.byCategory[item.category];
    mCat.prompt_tokens += pTokens;
    mCat.completion_tokens += cTokens;
    mCat.total_tokens += tTokens;
    mCat.requests += 1;

    const logEntry = {
        id: Date.now() + Math.random().toString(36).substring(2, 6),
        time: new Date().toLocaleTimeString(),
        category: item.category,
        caller: item.caller,
        model: mName,
        prompt_tokens: pTokens,
        completion_tokens: cTokens,
        total_tokens: tTokens,
        duration_ms: item.duration_ms,
        is_stream: item.is_stream,
    };

    settings.recentLogs.unshift(logEntry);
    if (settings.recentLogs.length > 100) {
        settings.recentLogs.pop();
    }

    safeSaveSettings();
    updateTopBarUI();
    if (window.$ && $('#omni_tracker_modal').is(':visible')) {
        renderDashboardUI();
    }
}

/**
 * 全局 Fetch 代理拦截器
 */
function installFetchHook() {
    const originalFetch = window.fetch;

    window.fetch = async function (...args) {
        const url = args[0];
        const options = args[1] || {};

        if (!isTargetLLMApi(url, options)) {
            return originalFetch.apply(this, args);
        }

        let trackerItem = {
            url: typeof url === 'string' ? url : (url.url || ''),
            model: 'Unknown',
            prompt_tokens: 0,
            completion_tokens: 0,
            category: 'scripts',
            caller: '未知任务',
            is_stream: false,
            duration_ms: 0,
        };

        const startTime = performance.now();

        try {
            let parsedReq = null;
            const reqBody = options.body;
            if (reqBody && typeof reqBody === 'string') {
                try {
                    parsedReq = JSON.parse(reqBody);
                    const detectedModel = extractModelName(parsedReq, trackerItem.url);
                    if (detectedModel) trackerItem.model = detectedModel;
                    trackerItem.is_stream = !!parsedReq.stream;

                    // 估算输入 Token（覆盖对话、单句、批量向量、Rerank、原生向量）
                    if (Array.isArray(parsedReq.messages)) {
                        let combinedText = '';
                        for (const m of parsedReq.messages) {
                            if (typeof m.content === 'string') combinedText += m.content + '\n';
                        }
                        trackerItem.prompt_tokens = estimateTokens(combinedText);
                    } else if (typeof parsedReq.prompt === 'string') {
                        trackerItem.prompt_tokens = estimateTokens(parsedReq.prompt);
                    } else if (typeof parsedReq.input === 'string') {
                        trackerItem.prompt_tokens = estimateTokens(parsedReq.input);
                    } else if (Array.isArray(parsedReq.input)) {
                        // 向量批量嵌入输入
                        let combined = '';
                        for (const it of parsedReq.input) {
                            if (typeof it === 'string') combined += it + ' ';
                            else if (it?.text) combined += it.text + ' ';
                        }
                        trackerItem.prompt_tokens = estimateTokens(combined);
                    } else if (typeof parsedReq.query === 'string' && Array.isArray(parsedReq.documents)) {
                        // Rerank 结构 {"query": "...", "documents": ["...", ...]}
                        let combined = parsedReq.query + '\n';
                        for (const doc of parsedReq.documents) {
                            if (typeof doc === 'string') combined += doc + '\n';
                            else if (doc?.text) combined += doc.text + '\n';
                        }
                        trackerItem.prompt_tokens = estimateTokens(combined);
                    } else if (typeof parsedReq.searchText === 'string') {
                        // 酒馆原生向量检索
                        trackerItem.prompt_tokens = estimateTokens(parsedReq.searchText);
                    } else if (Array.isArray(parsedReq.items)) {
                        // 酒馆原生向量插入
                        let combined = '';
                        for (const it of parsedReq.items) {
                            if (typeof it?.text === 'string') combined += it.text + ' ';
                        }
                        trackerItem.prompt_tokens = estimateTokens(combined);
                    }
                } catch (_) {}
            }

            const stack = (new Error()).stack || '';
            const classification = classifyRequest(stack, trackerItem.url, parsedReq, trackerItem.is_stream, trackerItem.model);
            trackerItem.category = classification.category;
            trackerItem.caller = classification.caller;
        } catch (prepErr) {
            console.warn('[OmniTracker] Request inspect error:', prepErr);
        }

        triggerTopBarPulse();

        let response;
        try {
            response = await originalFetch.apply(this, args);
        } catch (fetchErr) {
            throw fetchErr;
        }

        try {
            if (response && response.ok) {
                const contentType = (response.headers?.get('content-type') || '').toLowerCase();
                const isSSE = contentType.includes('text/event-stream') || trackerItem.is_stream;

                if (isSSE && response.body && typeof response.body.tee === 'function') {
                    trackerItem.is_stream = true;
                    const [streamMain, streamTracker] = response.body.tee();
                    consumeStreamForMetrics(streamTracker, trackerItem, startTime);

                    return new Response(streamMain, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers,
                    });
                } else {
                    trackerItem.duration_ms = Math.round(performance.now() - startTime);
                    const cloned = response.clone();

                    cloned.text().then(rawText => {
                        try {
                            const data = JSON.parse(rawText);
                            const respModel = extractModelName(data, trackerItem.url);
                            if ((!trackerItem.model || trackerItem.model === 'Unknown') && respModel) {
                                trackerItem.model = respModel;
                            }

                            let hitUsage = false;
                            if (data && typeof data === 'object') {
                                hitUsage = applyUsageFrom(trackerItem, data.usage)
                                    || applyUsageFrom(trackerItem, data.usageMetadata)
                                    || applyUsageFrom(trackerItem, data.usage_metadata)
                                    || applyUsageFrom(trackerItem, data); // 很多向量接口 (Ollama) 直接将 prompt_eval_count 放在根级
                            }

                            // 仅对非向量生成类接口兜底提取输出文本
                            if (!hitUsage && trackerItem.category !== 'vectors') {
                                const outText = extractOutputText(data);
                                if (outText) trackerItem.completion_tokens = estimateTokens(outText);
                            }
                        } catch (_) {
                            if (rawText && rawText.length > 0 && !contentType.includes('audio') && trackerItem.category !== 'vectors') {
                                trackerItem.completion_tokens = estimateTokens(rawText);
                            }
                        }
                        recordApiUsage(trackerItem);
                    }).catch(() => {
                        recordApiUsage(trackerItem);
                    });
                }
            }
        } catch (resErr) {
            console.warn('[OmniTracker] Response intercept error:', resErr);
        }

        return response;
    };

    console.log('[OmniTracker] 自由悬浮与全域向量拦截器已就绪 (v1.6.0)');
}

async function consumeStreamForMetrics(stream, trackerItem, startTime) {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let accumulatedText = '';
    let officialUsage = null;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const dataStr = trimmed.slice(5).trim();
                if (dataStr === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(dataStr);

                    if ((!trackerItem.model || trackerItem.model === 'Unknown') && typeof parsed.model === 'string' && parsed.model.trim()) {
                        trackerItem.model = parsed.model.trim();
                    }

                    if (parsed.usage) officialUsage = parsed.usage;
                    else if (parsed.usageMetadata) officialUsage = parsed.usageMetadata;
                    else if (parsed.usage_metadata) officialUsage = parsed.usage_metadata;

                    const chunk = parsed.choices?.[0]?.delta?.content
                        || parsed.choices?.[0]?.text
                        || parsed.delta
                        || parsed.candidates?.[0]?.content?.parts?.[0]?.text
                        || parsed.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('');
                    if (typeof chunk === 'string' && chunk) {
                        accumulatedText += chunk;
                    }
                } catch (_) {}
            }
        }
    } catch (e) {
    } finally {
        trackerItem.duration_ms = Math.round(performance.now() - startTime);

        let usageHit = false;
        if (officialUsage) {
            usageHit = applyUsageFrom(trackerItem, officialUsage);
        }
        if (!usageHit && trackerItem.category !== 'vectors') {
            trackerItem.completion_tokens = estimateTokens(accumulatedText);
        }

        recordApiUsage(trackerItem);
    }
}

/**
 * 赋予胶囊自由拖拽与位置记忆能力（兼容手机触屏与电脑鼠标）
 */
function makePillDraggable($el) {
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;
    let hasMoved = false;

    // 载入保存的位置
    const savedPos = settings.badgePos || JSON.parse(localStorage.getItem('omni_badge_pos') || 'null');
    if (savedPos && savedPos.top !== undefined && savedPos.left !== undefined) {
        const clampTop = Math.min(window.innerHeight - 36, Math.max(10, savedPos.top));
        const clampLeft = Math.min(window.innerWidth - 80, Math.max(10, savedPos.left));
        $el.css({
            top: clampTop + 'px',
            left: clampLeft + 'px',
            right: 'auto',
            bottom: 'auto',
        });
    }

    function onPointerDown(e) {
        if (e.type === 'mousedown' && e.button !== 0) return;
        isDragging = true;
        hasMoved = false;

        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        startX = clientX;
        startY = clientY;

        const rect = $el[0].getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        $(document).on('mousemove.omni touchmove.omni', onPointerMove);
        $(document).on('mouseup.omni touchend.omni', onPointerUp);
    }

    function onPointerMove(e) {
        if (!isDragging) return;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const dx = clientX - startX;
        const dy = clientY - startY;

        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
            hasMoved = true;
        }

        if (hasMoved) {
            if (e.cancelable) e.preventDefault();
            const w = $el.outerWidth() || 90;
            const h = $el.outerHeight() || 28;
            const newLeft = Math.max(5, Math.min(window.innerWidth - w - 5, initialLeft + dx));
            const newTop = Math.max(5, Math.min(window.innerHeight - h - 5, initialTop + dy));
            $el.css({ left: newLeft + 'px', top: newTop + 'px', right: 'auto', bottom: 'auto' });
        }
    }

    function onPointerUp(e) {
        if (!isDragging) return;
        isDragging = false;
        $(document).off('.omni');

        if (hasMoved) {
            const rect = $el[0].getBoundingClientRect();
            const pos = { top: Math.round(rect.top), left: Math.round(rect.left) };
            settings.badgePos = pos;
            localStorage.setItem('omni_badge_pos', JSON.stringify(pos));
            safeSaveSettings();
        }
    }

    $el.off('mousedown.omni touchstart.omni').on('mousedown.omni touchstart.omni', onPointerDown);

    // 点击事件过滤：若拖拽发生则阻止弹窗触发
    $el.off('click.omni').on('click.omni', function (e) {
        if (hasMoved) {
            e.stopImmediatePropagation();
            e.preventDefault();
            hasMoved = false;
            return;
        }
        showDashboardModal();
    });
}

// --- UI 挂载与渲染 ---
function tryMountUI() {
    if (!window.$) {
        setTimeout(tryMountUI, 300);
        return;
    }

    $('#omni_tracker_topbar_btn').remove();

    if (settings && settings.showInTopBar) {
        const isFloating = (settings.badgeMode !== 'topbar');
        const btnHtml = `
            <div id="omni_tracker_topbar_btn" class="${isFloating ? 'omni-floating' : ''}" title="Omni API Tracker: 点击打开通用模型账本 (拖动可挪位置)">
                <i class="fa-solid fa-bolt"></i>
                <span id="omni_tracker_topbar_text">0</span>
            </div>
        `;

        if (isFloating) {
            $('body').append(btnHtml);
            makePillDraggable($('#omni_tracker_topbar_btn'));
        } else {
            if ($('#top-bar').length) {
                $('#top-bar').append(btnHtml);
            } else if ($('#chat_header').length) {
                $('#chat_header').append(btnHtml);
            }
            $('#omni_tracker_topbar_btn').on('click', showDashboardModal);
        }

        $('#omni_tracker_topbar_btn').on('contextmenu', function (e) {
            e.preventDefault();
            if (confirm('是否隐藏快捷指示器？\n（可随时在右侧扩展列表中重新开启，或在设置中切换为顶栏内嵌）')) {
                settings.showInTopBar = false;
                safeSaveSettings();
                $('#omni_tracker_topbar_btn').remove();
                syncDrawerCheckbox();
            }
        });
    }

    mountExtensionSettingsDrawer();
    updateTopBarUI();
}

function mountExtensionSettingsDrawer() {
    if ($('#extensions_settings').length === 0 || $('#omni_tracker_extension_settings').length) {
        syncDrawerCheckbox();
        return;
    }

    const drawerHtml = `
        <div id="omni_tracker_extension_settings" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><i class="fa-solid fa-bolt" style="color:#34d399;"></i> Omni 通用模型账本与公会手账</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content" style="padding: 12px; background: rgba(0,0,0,0.25); border-radius: 6px;">
                    <p style="font-size:12px; color:#cbd5e1; margin-bottom: 12px; line-height: 1.5;">
                        通用全量监听：分模型核算主聊对话、预设/后台脚本、TTS语音、向量/重排检索；内置可拖拽悬浮胶囊与公会手账。
                    </p>

                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding:8px 10px; background:rgba(255,255,255,0.05); border-radius:6px;">
                        <span style="font-size:12px; font-weight:700; color:#fff;">显示快捷指示器胶囊</span>
                        <label class="omni-switch">
                            <input type="checkbox" id="omni_drawer_toggle_topbar" ${settings?.showInTopBar ? 'checked' : ''}>
                            <span class="omni-slider"></span>
                        </label>
                    </div>

                    <div style="display:flex; gap:10px;">
                        <button class="menu_button" id="omni_open_dashboard_from_settings">
                            <i class="fa-solid fa-chart-pie"></i> 打开通用模型账本
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
    $('#extensions_settings').append(drawerHtml);
    $('#omni_open_dashboard_from_settings').on('click', showDashboardModal);

    $('#omni_drawer_toggle_topbar').on('change', function () {
        const isChecked = $(this).prop('checked');
        settings.showInTopBar = isChecked;
        safeSaveSettings();
        tryMountUI();
    });
}

function syncDrawerCheckbox() {
    if (!settings) return;
    $('#omni_drawer_toggle_topbar').prop('checked', !!settings.showInTopBar);
    $('#omni_modal_toggle_topbar').prop('checked', !!settings.showInTopBar);
    $('#omni_badge_mode_select').val(settings.badgeMode || 'floating');
}

function triggerTopBarPulse() {
    if (!window.$) return;
    const $btn = $('#omni_tracker_topbar_btn');
    if ($btn.length) {
        $btn.addClass('pulse-active');
        setTimeout(() => $btn.removeClass('pulse-active'), 800);
    }
}

function updateTopBarUI() {
    if (!settings || !window.$) return;
    const tokenStr = formatTokens(settings.today?.total_tokens || 0);
    const today = getTodayDateString();
    const todayMs = settings.activeTime?.daily?.[today] || 0;
    const timeStr = formatDuration(todayMs);

    $('#omni_tracker_topbar_text').text(`${tokenStr} | ${timeStr}`);
}

function showDashboardModal() {
    if ($('#omni_tracker_modal').length) {
        $('#omni_tracker_modal').show();
        renderDashboardUI();
        return;
    }

    const modalHtml = `
        <div id="omni_tracker_modal" class="omni-modal-overlay">
            <div class="omni-modal-content">
                <div class="omni-modal-header">
                    <h3><i class="fa-solid fa-cube" style="color:#34d399;"></i> Omni 通用模型账本</h3>
                    <button class="omni-close-btn" id="omni_close_modal_btn" title="关闭"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="omni-tabs">
                    <button class="omni-tab-btn active" data-tab="models">🤖 模型总览</button>
                    <button class="omni-tab-btn" data-tab="rpg">🏰 陪伴手账</button>
                    <button class="omni-tab-btn" data-tab="logs">📜 实时流水</button>
                    <button class="omni-tab-btn" data-tab="settings">⚙️ 设置维护</button>
                </div>
                <div class="omni-tab-panel" id="omni_tab_content">
                </div>
            </div>
        </div>
    `;

    $('body').append(modalHtml);

    $('#omni_close_modal_btn').on('click', () => $('#omni_tracker_modal').hide());
    $('#omni_tracker_modal').on('click', function (e) {
        if ($(e.target).hasClass('omni-modal-overlay')) {
            $(this).hide();
        }
    });

    $('.omni-tab-btn').on('click', function () {
        $('.omni-tab-btn').removeClass('active');
        $(this).addClass('active');
        renderDashboardUI($(this).data('tab'));
    });

    renderDashboardUI('models');
}

function renderDashboardUI(activeTab) {
    if (!activeTab) {
        activeTab = $('.omni-tab-btn.active').data('tab') || 'models';
    }

    const $panel = $('#omni_tab_content');
    if (!settings) return;

    if (activeTab === 'models') {
        const today = settings.today;
        const total = settings.totals;
        const todayActiveMs = settings.activeTime?.daily?.[getTodayDateString()] || 0;

        const models = settings.byModel || {};
        const mKeys = Object.keys(models).sort((a, b) => (models[b].total_tokens || 0) - (models[a].total_tokens || 0));

        let modelCardsHtml = '';
        if (mKeys.length === 0) {
            modelCardsHtml = '<div style="text-align:center; padding: 40px 20px; color:#94a3b8; font-size:13px;">暂无模型调用数据。开始对话、触发预设或向量检索后将在此呈现。</div>';
        } else {
            const grandTotalTokens = Math.max(1, mKeys.reduce((acc, k) => acc + (models[k].total_tokens || 0), 0));

            for (const m of mKeys) {
                const data = models[m];
                const modelTotal = Math.max(1, data.total_tokens || 0);
                const shareOfAll = ((data.total_tokens || 0) / grandTotalTokens * 100).toFixed(1);

                const catMap = data.byCategory || {};
                const catEntries = Object.entries(catMap).sort((a, b) => (b[1].total_tokens || 0) - (a[1].total_tokens || 0));

                let segsHtml = '';
                let rowsHtml = '';

                if (catEntries.length === 0) {
                    rowsHtml = '<div style="font-size:11px; color:#94a3b8; padding:6px 0;">（新发起的调用将在此清晰展示主聊 vs 预设/向量比例）</div>';
                }

                for (const [ck, cv] of catEntries) {
                    const meta = CATEGORY_MAP[ck] || { label: ck, color: '#8b5cf6', icon: 'fa-cube' };
                    const pct = ((cv.total_tokens || 0) / modelTotal) * 100;
                    if (pct <= 0 && cv.requests <= 0) continue;

                    segsHtml += `<div style="width:${Math.max(2, pct)}%; background:${meta.color};" title="${meta.label}: ${pct.toFixed(1)}%"></div>`;
                    rowsHtml += `
                        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; font-size:11px; padding:6px 0; border-top:1px dashed #26263a;">
                            <span style="color:#e2e8f0; flex:1; white-space:nowrap; display:flex; align-items:center; gap:6px;">
                                <i class="fa-solid ${meta.icon}" style="color:${meta.color};"></i>
                                <strong>${meta.label}</strong>
                            </span>
                            <span style="color:#94a3b8; white-space:nowrap;">${cv.requests}次 · 入 ${formatTokens(cv.prompt_tokens)} / 出 ${formatTokens(cv.completion_tokens)}</span>
                            <span style="color:#f8fafc; font-weight:700; white-space:nowrap; min-width:80px; text-align:right;">
                                ${formatTokens(cv.total_tokens)} <span style="color:${meta.color}; font-size:10px;">${pct.toFixed(1)}%</span>
                            </span>
                        </div>
                    `;
                }

                modelCardsHtml += `
                    <div class="omni-category-card" style="padding:12px 14px; margin-bottom:12px;">
                        <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px;">
                            <span style="font-weight:800; color:#38bdf8; font-size:14px; word-break:break-all;">
                                <i class="fa-solid fa-microchip" style="margin-right:6px; color:#34d399;"></i>${m}
                            </span>
                            <span style="color:#34d399; font-weight:800; font-size:14px; white-space:nowrap;">${formatTokens(data.total_tokens)}</span>
                        </div>
                        <div style="display:flex; justify-content:space-between; font-size:11px; color:#94a3b8; margin-bottom:8px;">
                            <span>共调用 ${data.requests} 次 (入 ${formatTokens(data.prompt_tokens)} / 出 ${formatTokens(data.completion_tokens)})</span>
                            <span>占总用量 ${shareOfAll}%</span>
                        </div>
                        <div style="display:flex; height:7px; border-radius:4px; overflow:hidden; background:#0f0f17; border:1px solid #222232;">
                            ${segsHtml}
                        </div>
                        <div style="margin-top:8px;">
                            ${rowsHtml}
                        </div>
                    </div>
                `;
            }
        }

        $panel.html(`
            <div class="omni-stat-grid">
                <div class="omni-stat-card">
                    <div class="omni-stat-title">今日总用量</div>
                    <div class="omni-stat-value">${formatTokens(today.total_tokens)}</div>
                    <div class="omni-stat-sub">${today.requests} 次交互 (入 ${formatTokens(today.prompt_tokens)} / 出 ${formatTokens(today.completion_tokens)})</div>
                </div>
                <div class="omni-stat-card">
                    <div class="omni-stat-title">今日活跃时长</div>
                    <div class="omni-stat-value" style="color:#fbbf24 !important;">${formatDuration(todayActiveMs)}</div>
                    <div class="omni-stat-sub">累计投入: ${formatDuration(settings.activeTime?.totalMs || 0)}</div>
                </div>
                <div class="omni-stat-card">
                    <div class="omni-stat-title">历史累计消耗</div>
                    <div class="omni-stat-value" style="color:#c084fc !important;">${formatTokens(total.total_tokens)}</div>
                    <div class="omni-stat-sub">总计 ${total.requests} 次调用</div>
                </div>
            </div>

            <div class="omni-section-title">
                <i class="fa-solid fa-cubes-stacked" style="color:#38bdf8;"></i> 模型用量明细 (按模型归集，清晰展示主聊、预设与向量比例)
            </div>
            ${modelCardsHtml}
        `);
    } else if (activeTab === 'rpg') {
        const daily = settings.activeTime?.daily || {};
        const entries = Object.keys(daily).map(d => ({
            date: d,
            hours: (daily[d] || 0) / 3600000,
            day: new Date(d).getDay(),
        })).sort((a, b) => a.date.localeCompare(b.date));

        const totalHours = (settings.activeTime?.totalMs || 0) / 3600000;
        const level = Math.floor(totalHours / 10) + 1;
        const currentExp = totalHours % 10;
        const expPct = Math.min(100, (currentExp / 10) * 100).toFixed(1);

        let myTitle = RPG_CONFIG.titles[0];
        for (let t of RPG_CONFIG.titles) {
            if (totalHours >= t.h) myTitle = t;
        }

        let achieveHtml = '';
        RPG_CONFIG.achievements.forEach(ach => {
            const unlocked = ach.check(entries, totalHours);
            achieveHtml += `
                <div class="omni-achieve-card ${unlocked ? 'unlocked' : ''}">
                    <div class="omni-achieve-name">
                        <span>${ach.name}</span>
                        <span>${unlocked ? '🏆' : '🔒'}</span>
                    </div>
                    <div class="omni-achieve-desc">${ach.desc}</div>
                </div>
            `;
        });

        const top5 = [...entries].sort((a, b) => b.hours - a.hours).slice(0, 5);
        const weekMap = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        let top5Rows = '';
        top5.forEach(e => {
            top5Rows += `
                <tr>
                    <td style="color:#ffffff;">${e.date}</td>
                    <td style="color:#94a3b8;">${weekMap[e.day]}</td>
                    <td style="font-weight:700; color:#fbbf24;">${e.hours.toFixed(1)} 小时</td>
                </tr>
            `;
        });

        const recent7 = entries.slice(-7);
        let maxH = Math.max(1, ...recent7.map(e => e.hours));
        let svgBars = '';
        recent7.forEach((e, idx) => {
            const h = (e.hours / maxH) * 80;
            const x = idx * 42 + 20;
            const y = 95 - h;
            svgBars += `
                <rect x="${x}" y="${y}" width="24" height="${h}" rx="3" fill="#34d399" opacity="0.85"></rect>
                <text x="${x + 12}" y="${y - 4}" fill="#fbbf24" font-size="9" text-anchor="middle">${e.hours.toFixed(1)}h</text>
                <text x="${x + 12}" y="112" fill="#94a3b8" font-size="9" text-anchor="middle">${e.date.slice(5)}</text>
            `;
        });

        $panel.html(`
            <div class="omni-rpg-hero">
                <div class="omni-rpg-header">
                    <div>
                        <div style="font-size:11px; color:#fbbf24; font-weight:700; text-transform:uppercase;">当前称号</div>
                        <div class="omni-rpg-title-text">${myTitle.t}</div>
                    </div>
                    <div class="omni-rpg-level-badge">
                        <span style="font-size:9px; opacity:0.8;">LV</span>
                        <span style="font-size:16px;">${level}</span>
                    </div>
                </div>
                <div style="font-size:12px; color:#94a3b8; font-style:italic; margin-bottom:8px;">"${myTitle.desc}"</div>
                
                <div style="display:flex; justify-content:space-between; font-size:12px; font-weight:700; margin-top:10px;">
                    <span style="color:#ffffff;">总潜行时长: ${totalHours.toFixed(1)} Hours</span>
                    <span style="color:#fbbf24;">进度: ${currentExp.toFixed(1)} / 10 h (${expPct}%)</span>
                </div>
                <div class="omni-rpg-exp-bar">
                    <div class="omni-rpg-exp-fill" style="width: ${expPct}%;"></div>
                </div>
            </div>

            <div class="omni-section-title"><i class="fa-solid fa-chart-column" style="color:#34d399;"></i> 最近活跃趋势 (7 Days)</div>
            <div class="omni-chart-box">
                ${recent7.length ? `
                    <svg viewBox="0 0 320 120" style="width:100%; height:130px; display:block;">
                        ${svgBars}
                    </svg>
                ` : '<div style="text-align:center; padding:30px; color:#94a3b8; font-size:12px;">暂无历史活跃天数记录</div>'}
            </div>

            <div class="omni-section-title"><i class="fa-solid fa-trophy" style="color:#fbbf24;"></i> 成就图鉴</div>
            <div class="omni-achieve-grid">
                ${achieveHtml}
            </div>

            <div class="omni-section-title"><i class="fa-solid fa-crown" style="color:#f59e0b;"></i> 肝帝时刻 Top 5</div>
            <div class="omni-table-wrap" style="background:#1b1b28; border-radius:8px; border:1px solid #28283c;">
                <table class="omni-log-table">
                    <thead>
                        <tr><th>日期</th><th>星期</th><th>单日活跃时长</th></tr>
                    </thead>
                    <tbody>
                        ${top5Rows || '<tr><td colspan="3" style="text-align:center; color:#94a3b8;">暂无数据</td></tr>'}
                    </tbody>
                </table>
            </div>
        `);
    } else if (activeTab === 'logs') {
        const logs = settings.recentLogs || [];
        if (logs.length === 0) {
            $panel.html('<div style="text-align:center; padding: 50px 20px; color:#94a3b8; font-size:13px;">暂无调用记录。与酒馆对话、触发预设、TTS或向量检索时将在此实时显示。</div>');
            return;
        }

        let rowsHtml = '';
        for (const log of logs) {
            const catMeta = CATEGORY_MAP[log.category] || { label: log.category, color: '#8b5cf6' };
            rowsHtml += `
                <tr>
                    <td style="color:#94a3b8;">${log.time}</td>
                    <td><span class="omni-badge omni-badge-${log.category || 'scripts'}">${catMeta.label}</span></td>
                    <td style="color:#f8fafc; font-weight:600; max-width:130px; overflow:hidden; text-overflow:ellipsis;">${log.caller || '-'}</td>
                    <td style="color:#38bdf8; max-width:150px; overflow:hidden; text-overflow:ellipsis;" title="${log.model}">${log.model || '-'}</td>
                    <td>${formatTokens(log.prompt_tokens)}</td>
                    <td>${formatTokens(log.completion_tokens)}</td>
                    <td style="font-weight:700; color:#34d399;">${formatTokens(log.total_tokens)}</td>
                    <td style="color:#94a3b8;">${log.duration_ms ? log.duration_ms + 'ms' : '-'}</td>
                </tr>
            `;
        }

        $panel.html(`
            <div class="omni-table-wrap">
                <table class="omni-log-table">
                    <thead>
                        <tr>
                            <th>时间</th>
                            <th>通道</th>
                            <th>任务说明</th>
                            <th>模型</th>
                            <th>Prompt</th>
                            <th>Completion</th>
                            <th>Total</th>
                            <th>耗时</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                    </tbody>
                </table>
            </div>
        `);
    } else if (activeTab === 'settings') {
        const isFloating = (settings.badgeMode !== 'topbar');

        $panel.html(`
            <div style="font-size: 13px; line-height: 1.8;">
                <div class="omni-setting-row">
                    <div>
                        <div class="omni-setting-label">显示快捷指示器胶囊</div>
                        <div class="omni-setting-desc">显示 ⚡ 今日消耗与活跃时长（关闭后更清爽，可随时在此重新开启）</div>
                    </div>
                    <label class="omni-switch">
                        <input type="checkbox" id="omni_modal_toggle_topbar" ${settings.showInTopBar ? 'checked' : ''}>
                        <span class="omni-slider"></span>
                    </label>
                </div>

                <div class="omni-setting-row">
                    <div>
                        <div class="omni-setting-label">胶囊展示形态</div>
                        <div class="omni-setting-desc">推荐「自由悬浮胶囊」：可在屏幕任意拖动，触屏/鼠标松手自动记忆位置，绝不遮挡预设按钮</div>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <select id="omni_badge_mode_select" style="background:#28283c; color:#fff; border:1px solid #3c3c52; padding:5px 8px; border-radius:6px; font-size:12px;">
                            <option value="floating" ${isFloating ? 'selected' : ''}>🧲 自由悬浮胶囊 (可拖动记忆)</option>
                            <option value="topbar" ${!isFloating ? 'selected' : ''}>📌 顶栏内嵌模式</option>
                        </select>
                        <button class="menu_button" id="omni_btn_reset_badge_pos" style="padding:4px 8px; font-size:11px;" title="将悬浮胶囊恢复到默认右上角位置">复位位置</button>
                    </div>
                </div>

                <div class="omni-actions" style="margin-top:20px;">
                    <button class="menu_button" id="omni_btn_reset_session"><i class="fa-solid fa-arrows-rotate"></i> 重置本次会话</button>
                    <button class="menu_button" id="omni_btn_reset_today"><i class="fa-solid fa-calendar-xmark"></i> 清空今日统计</button>
                    <button class="menu_button" id="omni_btn_clean_water" style="background:#065f46 !important; color:#6ee7b7 !important;"><i class="fa-solid fa-broom"></i> 智能去水清洗 (修复旧版虚高)</button>
                    <button class="menu_button" id="omni_btn_export_json"><i class="fa-solid fa-file-export"></i> 导出完整数据 (JSON)</button>
                    <button class="menu_button" id="omni_btn_import_trigger"><i class="fa-solid fa-file-import"></i> 导入数据 (支持旧时长文件)</button>
                    <input type="file" id="omni_file_input" accept=".json" style="display:none;">
                    <button class="menu_button" id="omni_btn_clear_all" style="background:#7f1d1d !important; color:#fca5a5 !important;"><i class="fa-solid fa-trash"></i> 清空全部历史数据</button>
                </div>
            </div>
        `);

        $('#omni_modal_toggle_topbar').on('change', function () {
            const isChecked = $(this).prop('checked');
            settings.showInTopBar = isChecked;
            safeSaveSettings();
            syncDrawerCheckbox();

            if (isChecked) {
                tryMountUI();
                if (window.toastr) toastr.success('已开启指示器胶囊');
            } else {
                $('#omni_tracker_topbar_btn').remove();
                if (window.toastr) toastr.info('已隐藏指示器胶囊');
            }
        });

        $('#omni_badge_mode_select').on('change', function () {
            const mode = $(this).val();
            settings.badgeMode = mode;
            safeSaveSettings();
            tryMountUI();
            if (window.toastr) toastr.success(mode === 'floating' ? '已切换为自由悬浮胶囊模式（可随意拖动）' : '已切换为顶栏内嵌模式');
        });

        $('#omni_btn_reset_badge_pos').on('click', () => {
            settings.badgePos = { top: 75, left: window.innerWidth - 110 };
            localStorage.removeItem('omni_badge_pos');
            safeSaveSettings();
            tryMountUI();
            if (window.toastr) toastr.success('悬浮胶囊位置已复位到右上角！');
        });

        $('#omni_btn_reset_session').on('click', () => {
            settings.session = { startTime: Date.now(), prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0 };
            safeSaveSettings();
            renderDashboardUI('settings');
            updateTopBarUI();
            if (window.toastr) toastr.success('本次会话统计已重置');
        });

        $('#omni_btn_reset_today').on('click', () => {
            settings.today = { date: getTodayDateString(), prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0 };
            safeSaveSettings();
            renderDashboardUI('settings');
            updateTopBarUI();
            if (window.toastr) toastr.success('今日用量统计已重置');
        });

        $('#omni_btn_clean_water').on('click', () => {
            let estimatedWater = 0;
            const bm = settings.byModel || {};
            for (const [m, v] of Object.entries(bm)) {
                const ml = m.toLowerCase();
                if (ml.includes('tts') || ml.includes('mimo') || ml.includes('embed') || ml.includes('rerank') || ml.includes('bge') || v.byCategory?.vectors) continue;
                const c = v.completion_tokens || 0;
                const p = v.prompt_tokens || 0;
                if (c === 0 && p > 0) estimatedWater += p;
                else if (c > 0 && p / c > 60) {
                    estimatedWater += Math.max(0, p - Math.round(c * 25));
                }
            }

            if (estimatedWater < 10000) {
                if (window.toastr) toastr.info('数据非常健康，未检测到异常虚高的注水数据！');
                return;
            }

            const waterStr = formatTokens(estimatedWater);
            if (confirm(`【智能去水清洗诊断】\n\n检测到历史数据存在约 ${waterStr} 的异常注水 Tokens（通常由旧版本误抓酒馆内部正则修剪产生）。\n\n- 保留：全部真实 AI 回复 (Completion)\n- 保留：全部语音朗读 (TTS)\n- 保留：全部向量与重排检索 (Vectors)\n- 保留：全部 RPG 冒险者时长与成就\n- 剔除：内部数据传输产生的虚高 Prompt\n\n是否立即执行一键去水校准？`)) {
                const res = cleanHistoricalWaterData();
                renderDashboardUI('settings');
                updateTopBarUI();
                if (window.toastr) toastr.success(`去水成功！已校准约 ${formatTokens(res.cleanedTokens)} 虚高数据，账本已回归真实！`);
            }
        });

        $('#omni_btn_export_json').on('click', () => {
            const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(settings, null, 2));
            const dlAnchor = document.createElement('a');
            dlAnchor.setAttribute('href', dataStr);
            dlAnchor.setAttribute('download', `omni-tracker-backup-${getTodayDateString()}.json`);
            dlAnchor.click();
        });

        $('#omni_btn_import_trigger').on('click', () => $('#omni_file_input').click());
        $('#omni_file_input').on('change', function (e) {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function (evt) {
                try {
                    const data = JSON.parse(evt.target.result);
                    if (data && typeof data === 'object') {
                        const isDailyTimeFormat = Object.keys(data).some(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && typeof data[k] === 'number');

                        if (isDailyTimeFormat) {
                            for (const [day, ms] of Object.entries(data)) {
                                if (typeof ms === 'number') {
                                    settings.activeTime.daily[day] = Math.max(settings.activeTime.daily[day] || 0, ms);
                                }
                            }
                            recalculateTotalActiveMs();
                            if (window.toastr) toastr.success('成功合并历史活跃时长数据！');
                        } else if (data.totals || data.activeTime) {
                            Object.assign(settings, data);
                            recalculateTotalActiveMs();
                            if (window.toastr) toastr.success('成功恢复 OmniTracker 完整数据！');
                        }
                        safeSaveSettings();
                        renderDashboardUI('settings');
                        updateTopBarUI();
                    }
                } catch (err) {
                    if (window.toastr) toastr.error('导入失败：无效的 JSON 格式');
                } finally {
                    e.target.value = '';
                }
            };
            reader.readAsText(file);
        });

        $('#omni_btn_clear_all').on('click', () => {
            if (confirm('确定要清空全部 API 调用审计与活跃时长记录吗？该操作不可撤销。')) {
                extension_settings[EXTENSION_NAME] = JSON.parse(JSON.stringify(defaultSettings));
                settings = extension_settings[EXTENSION_NAME];
                localStorage.removeItem(LEGACY_USAGE_KEY);
                safeSaveSettings();
                renderDashboardUI('settings');
                updateTopBarUI();
                if (window.toastr) toastr.success('所有统计与时长数据已清空');
            }
        });
    }
}

// 扩展初始化入口
(function () {
    loadSettings();
    installFetchHook();

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(tryMountUI, 100);
    } else {
        document.addEventListener('DOMContentLoaded', tryMountUI);
    }
})();

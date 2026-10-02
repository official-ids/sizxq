/**
 * ============================================================================
 * FILESHARE TELEGRAM BOT v1.0.0
 * ============================================================================
 * 
 * Telegram-бот файлообменник на Vercel Serverless + KV + Blob
 * 
 * ФУНКЦИОНАЛ:
 * - Загрузка файлов (документ, фото, видео, аудио, голос, стикер, гиф)
 * - Генерация короткого кода (например: AB12CD) для доступа к файлу
 * - Получение файла по коду: /get CODE
 * - Список своих файлов: /myfiles
 * - Удаление своих файлов: /delete CODE
 * - Поиск по имени: /search ЗАПРОС
 * - Теги для файлов (для группировки)
 * - Срок жизни файла (expires: 1ч / 1д / 7д / 30д / вечно)
 * - Публичные и приватные файлы (публичные видны в /top)
 * - Топ популярных файлов
 * - Статистика пользователя
 * - Реферальная система
 * - Система бейджей
 * 
 * АДМИН-ФУНКЦИИ:
 * - /admin — панель
 * - /stats — статистика системы
 * - /ban, /unban, /mute, /unmute
 * - /userinfo ID — инфо о юзере
 * - /broadcast ТЕКСТ — рассылка
 * - /clearexpired — очистка истёкших файлов
 * - /backup — бэкап метаданных
 * - /logs — последние действия
 * 
 * ОГРАНИЧЕНИЯ (учтены):
 * - Bot API: download до 20MB, upload до 50MB
 * - Vercel KV: до 1MB на значение → используем для метаданных
 * - Vercel Blob: файлы хранятся здесь
 * - Vercel Function: timeout 10s (Hobby) / 60s (Pro)
 * 
 * @version 1.0.0
 */

const { kv } = require("@vercel/kv");
const { put, del, list } = require("@vercel/blob");

// ============================================================================
// 1. КОНФИГУРАЦИЯ
// ============================================================================

const CONFIG = {
  BOT_TOKEN: process.env.FL_BOT_TOKEN,
  WEBHOOK_SECRET: process.env.FL_WEBHOOK_SECRET || "",
  ADMIN_IDS: String(process.env.FL_ADMIN_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
  BOT_USERNAME: process.env.FL_BOT_USERNAME || "FileShareBot",
  LOG_CHANNEL_ID: process.env.FL_LOG_CHANNEL_ID || "",
  
  MAX_FILE_SIZE_MB: parseInt(process.env.FL_MAX_FILE_SIZE_MB || "50", 10),
  MAX_FILES_PER_DAY: parseInt(process.env.FL_MAX_FILES_PER_DAY || "50", 10),
  MAX_STORAGE_MB: parseInt(process.env.FL_MAX_STORAGE_MB || "500", 10),
  
  FETCH_TIMEOUT: 8000,
  RATE_LIMIT_WINDOW: 60000,
  RATE_LIMIT_MAX: 20,
  
  MAX_CAPTION_LENGTH: 1024,
  MAX_MESSAGE_LENGTH: 4000,
};

const TG_API = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}`;

// Сроки жизни файлов
const EXPIRY_OPTIONS = {
  "1h": { label: "1 час", ms: 60 * 60 * 1000, emoji: "⏱️" },
  "1d": { label: "1 день", ms: 24 * 60 * 60 * 1000, emoji: "📅" },
  "7d": { label: "7 дней", ms: 7 * 24 * 60 * 60 * 1000, emoji: "📆" },
  "30d": { label: "30 дней", ms: 30 * 24 * 60 * 60 * 1000, emoji: "🗓️" },
  "never": { label: "Бессрочно", ms: 0, emoji: "♾️" },
};

// Типы файлов
const FILE_TYPES = {
  document: { emoji: "📄", label: "Документ" },
  photo: { emoji: "🖼️", label: "Фото" },
  video: { emoji: "🎬", label: "Видео" },
  audio: { emoji: "🎵", label: "Аудио" },
  voice: { emoji: "🎤", label: "Голосовое" },
  video_note: { emoji: "⭕", label: "Видеосообщение" },
  sticker: { emoji: "🎨", label: "Стикер" },
  animation: { emoji: "🎞️", label: "Гифка" },
};

// Бейджи
const BADGES = {
  FIRST_UPLOAD: { id: "first_upload", emoji: "🎯", name: "Первый файл", desc: "Загрузил первый файл" },
  UPLOADS_10: { id: "uploads_10", emoji: "📤", name: "Активист", desc: "Загрузил 10 файлов" },
  UPLOADS_50: { id: "uploads_50", emoji: "💎", name: "Коллекционер", desc: "Загрузил 50 файлов" },
  UPLOADS_100: { id: "uploads_100", emoji: "👑", name: "Легенда", desc: "Загрузил 100 файлов" },
  POPULAR: { id: "popular", emoji: "🔥", name: "Популярный", desc: "Файл скачали 100 раз" },
  SHARED_10: { id: "shared_10", emoji: "📢", name: "Подельщик", desc: "Поделился 10 файлами" },
  REFERRER_1: { id: "referrer_1", emoji: "🌱", name: "Новичок", desc: "Пригласил 1 друга" },
  REFERRER_5: { id: "referrer_5", emoji: "👥", name: "Реферрал-мастер", desc: "Пригласил 5 друзей" },
};

// Префиксы KV
const KV_PREFIXES = {
  FILE: "fl:file:",
  FILE_CODE: "fl:code:",       // code → fileId
  USER_FILES: "fl:user_files:", // userId → set of fileIds
  USER: "fl:user:",
  ALL_USERS: "fl:all_users",
  ALL_FILES: "fl:all_files",
  BAN_LIST: "fl:banned",
  MUTE_LIST: "fl:muted",
  LOGS: "fl:logs",
  STATS: "fl:stats",
  RATE: "fl:rate:",
  DAILY: "fl:daily:",
  BADGES: "fl:badges:",
  REFERRALS: "fl:referrals:",
  REFERRED_BY: "fl:referred_by:",
  STATE: "fl:state:",
};

// ============================================================================
// 2. УТИЛИТЫ
// ============================================================================

function isAdmin(userId) {
  return CONFIG.ADMIN_IDS.includes(String(userId));
}

function isNumeric(str) {
  return /^\d+$/.test(String(str));
}

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function truncate(str, maxLen = 50) {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}

function generateCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // без O, 0, I, 1
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDate(timestamp) {
  if (!timestamp) return "—";
  const d = new Date(timestamp);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  return `${day}.${month}.${year} ${hour}:${minute}`;
}

function timeAgo(timestamp) {
  if (!timestamp) return "—";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "только что";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин. назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч. назад`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} дн. назад`;
  const months = Math.floor(days / 30);
  return `${months} мес. назад`;
}

function getSafeUserName(user) {
  if (!user) return "Неизвестный";
  if (user.username) return `@${user.username}`;
  if (user.first_name || user.last_name) {
    return `${user.first_name || ""} ${user.last_name || ""}`.trim();
  }
  return `User_${user.id}`;
}

function parseCommand(text) {
  const parts = text.trim().split(/\s+/);
  return {
    command: parts[0].toLowerCase().split("@")[0],
    args: parts.slice(1),
  };
}

function getWordForm(num, forms) {
  const n = Math.abs(num) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

// ============================================================================
// 3. TELEGRAM API
// ============================================================================

async function telegram(method, body = {}, retries = 2) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT);
  
  try {
    const response = await fetch(`${TG_API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    
    const data = await response.json();
    
    if (!data.ok) {
      console.error(`[TG ERROR] ${method}:`, data.description);
      if (retries > 0 && response.status >= 500) {
        await new Promise(r => setTimeout(r, 1000));
        return telegram(method, body, retries - 1);
      }
    }
    
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error(`[TG FETCH ERROR] ${method}:`, error.message);
    if (retries > 0 && error.name !== "AbortError") {
      await new Promise(r => setTimeout(r, 1000));
      return telegram(method, body, retries - 1);
    }
    return { ok: false, error: error.message };
  }
}

async function sendMessage(chatId, text, extra = {}) {
  if (!text) return { ok: false };
  if (text.length > CONFIG.MAX_MESSAGE_LENGTH) {
    text = text.substring(0, CONFIG.MAX_MESSAGE_LENGTH - 3) + "...";
  }
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    parse_mode: "HTML",
    ...extra,
  });
}

async function sendInline(chatId, text, keyboard, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: keyboard },
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function editMessage(chatId, messageId, text, extra = {}) {
  return telegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function editKeyboard(chatId, messageId, keyboard) {
  return telegram("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function answerCallback(callbackId, text = "", showAlert = false) {
  return telegram("answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
    show_alert: showAlert,
  });
}

async function sendChatAction(chatId, action = "typing") {
  return telegram("sendChatAction", { chat_id: chatId, action });
}

/**
 * Отправка файла (документ/фото/видео/аудио) по file_id
 */
async function sendDocument(chatId, document, caption = "", extra = {}) {
  return telegram("sendDocument", {
    chat_id: chatId,
    document,
    caption,
    parse_mode: "HTML",
    ...extra,
  });
}

async function sendPhoto(chatId, photo, caption = "", extra = {}) {
  return telegram("sendPhoto", {
    chat_id: chatId,
    photo,
    caption,
    parse_mode: "HTML",
    ...extra,
  });
}

async function sendVideo(chatId, video, caption = "", extra = {}) {
  return telegram("sendVideo", {
    chat_id: chatId,
    video,
    caption,
    parse_mode: "HTML",
    ...extra,
  });
}

async function sendAudio(chatId, audio, caption = "", extra = {}) {
  return telegram("sendAudio", {
    chat_id: chatId,
    audio,
    caption,
    parse_mode: "HTML",
    ...extra,
  });
}

async function sendVoice(chatId, voice, caption = "", extra = {}) {
  return telegram("sendVoice", {
    chat_id: chatId,
    voice,
    caption,
    parse_mode: "HTML",
    ...extra,
  });
}

async function sendAnimation(chatId, animation, caption = "", extra = {}) {
  return telegram("sendAnimation", {
    chat_id: chatId,
    animation,
    caption,
    parse_mode: "HTML",
    ...extra,
  });
}

async function sendSticker(chatId, sticker, extra = {}) {
  return telegram("sendSticker", {
    chat_id: chatId,
    sticker,
    ...extra,
  });
}

async function sendVideoNote(chatId, videoNote, extra = {}) {
  return telegram("sendVideoNote", {
    chat_id: chatId,
    video_note: videoNote,
    ...extra,
  });
}

/**
 * Получение file path из Telegram
 */
async function getFile(fileId) {
  const result = await telegram("getFile", { file_id: fileId });
  if (!result.ok) return null;
  return {
    fileId: result.result.file_id,
    filePath: result.result.file_path,
    fileSize: result.result.file_size,
  };
}

/**
 * Скачивание файла из Telegram
 */
async function downloadFile(filePath) {
  try {
    const url = `https://api.telegram.org/file/bot${CONFIG.BOT_TOKEN}/${filePath}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.arrayBuffer();
  } catch (error) {
    console.error("[DOWNLOAD ERROR]", error.message);
    return null;
  }
}

/**
 * Загрузка файла в Vercel Blob
 */
async function uploadToBlob(path, buffer, contentType = "application/octet-stream") {
  try {
    const blob = await put(path, buffer, {
      access: "public",
      contentType,
    });
    return blob.url;
  } catch (error) {
    console.error("[BLOB UPLOAD ERROR]", error.message);
    return null;
  }
}

/**
 * Удаление файла из Vercel Blob
 */
async function deleteFromBlob(url) {
  try {
    await del(url);
    return true;
  } catch (error) {
    console.error("[BLOB DELETE ERROR]", error.message);
    return false;
  }
}

// ============================================================================
// 4. KV WRAPPERS
// ============================================================================

async function kvGet(key) {
  try { return await kv.get(key); } catch (e) { console.error(`[KV GET] ${key}:`, e.message); return null; }
}

async function kvSet(key, value, options = {}) {
  try {
    if (options.ex) return await kv.set(key, value, { ex: options.ex });
    return await kv.set(key, value);
  } catch (e) { console.error(`[KV SET] ${key}:`, e.message); return false; }
}

async function kvDel(key) {
  try { return await kv.del(key); } catch (e) { console.error(`[KV DEL] ${key}:`, e.message); return false; }
}

async function kvSadd(key, member) {
  try { return await kv.sadd(key, member); } catch (e) { return false; }
}

async function kvSrem(key, member) {
  try { return await kv.srem(key, member); } catch (e) { return false; }
}

async function kvSmembers(key) {
  try { return (await kv.smembers(key)) || []; } catch (e) { return []; }
}

// ============================================================================
// 5. USERS
// ============================================================================

async function getUser(userId) {
  const key = `${KV_PREFIXES.USER}${userId}`;
  return (await kvGet(key)) || {
    userId: String(userId),
    username: null,
    uploads: 0,
    downloads: 0,
    totalBytes: 0,
    badges: [],
    createdAt: null,
    lastSeen: null,
    referredBy: null,
    referrals: [],
  };
}

async function saveUser(userId, data = {}, username = null) {
  const key = `${KV_PREFIXES.USER}${userId}`;
  const old = (await kvGet(key)) || {};
  const isNew = !old.createdAt;
  
  await kvSet(key, {
    ...old,
    userId: String(userId),
    username: username || old.username || null,
    ...data,
    createdAt: old.createdAt || Date.now(),
    lastSeen: Date.now(),
  });
  
  if (isNew) {
    await kvSadd(KV_PREFIXES.ALL_USERS, String(userId));
    await incrementStat("total_users", 1);
  }
}

async function getAllUsers() {
  return await kvSmembers(KV_PREFIXES.ALL_USERS);
}

async function isBanned(userId) {
  const list = await kvSmembers(KV_PREFIXES.BAN_LIST);
  return list.includes(String(userId));
}

async function isMuted(userId) {
  const data = await kvGet(`${KV_PREFIXES.MUTE_LIST}:${userId}`);
  if (!data) return false;
  if (data.expiresAt && Date.now() > data.expiresAt) {
    await kvDel(`${KV_PREFIXES.MUTE_LIST}:${userId}`);
    return false;
  }
  return true;
}

async function banUser(userId, reason = "") {
  await kvSadd(KV_PREFIXES.BAN_LIST, String(userId));
  await saveUser(userId, { banned: true, banReason: reason });
}

async function unbanUser(userId) {
  await kvSrem(KV_PREFIXES.BAN_LIST, String(userId));
  await saveUser(userId, { banned: false, banReason: null });
}

async function muteUser(userId, durationMs = 86400000) {
  await kvSet(`${KV_PREFIXES.MUTE_LIST}:${userId}`, {
    until: Date.now() + durationMs,
    expiresAt: Date.now() + durationMs,
  }, { ex: Math.ceil(durationMs / 1000) + 60 });
}

async function unmuteUser(userId) {
  await kvDel(`${KV_PREFIXES.MUTE_LIST}:${userId}`);
}

// ============================================================================
// 6. FILES
// ============================================================================

async function getFileById(fileId) {
  return await kvGet(`${KV_PREFIXES.FILE}${fileId}`);
}

async function saveFile(fileId, data) {
  await kvSet(`${KV_PREFIXES.FILE}${fileId}`, data);
  await kvSadd(KV_PREFIXES.ALL_FILES, fileId);
}

async function deleteFile(fileId) {
  const file = await getFileById(fileId);
  if (!file) return false;
  
  // Удаляем из Blob (если есть URL)
  if (file.blobUrl) {
    await deleteFromBlob(file.blobUrl);
  }
  
  // Удаляем из KV
  await kvDel(`${KV_PREFIXES.FILE}${fileId}`);
  await kvDel(`${KV_PREFIXES.FILE_CODE}${file.code}`);
  await kvSrem(KV_PREFIXES.ALL_FILES, fileId);
  await kvSrem(`${KV_PREFIXES.USER_FILES}${file.ownerId}`, fileId);
  
  return true;
}

async function getFileByCode(code) {
  const fileId = await kvGet(`${KV_PREFIXES.FILE_CODE}${code.toUpperCase()}`);
  if (!fileId) return null;
  return await getFileById(fileId);
}

async function getUserFiles(userId) {
  const fileIds = await kvSmembers(`${KV_PREFIXES.USER_FILES}${userId}`);
  const files = [];
  for (const id of fileIds) {
    const file = await getFileById(id);
    if (file) files.push(file);
  }
  return files.sort((a, b) => b.createdAt - a.createdAt);
}

async function getUserStorageBytes(userId) {
  const files = await getUserFiles(userId);
  return files.reduce((sum, f) => sum + (f.fileSize || 0), 0);
}

async function getUserDailyUploads(userId) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const count = await kvGet(`${KV_PREFIXES.DAILY}${userId}:${dateKey}`);
  return parseInt(count) || 0;
}

async function incrementDailyUploads(userId) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const key = `${KV_PREFIXES.DAILY}${userId}:${dateKey}`;
  const count = parseInt(await kvGet(key)) || 0;
  await kvSet(key, count + 1, { ex: 86400 * 2 });
  return count + 1;
}

// ============================================================================
// 7. BADGES
// ============================================================================

async function awardBadge(userId, badgeId) {
  const key = `${KV_PREFIXES.BADGES}${userId}`;
  const badges = (await kvGet(key)) || [];
  
  if (badges.includes(badgeId)) return false;
  
  badges.push(badgeId);
  await kvSet(key, badges);
  
  const badge = BADGES[badgeId];
  if (badge) {
    await sendMessage(
      userId,
      `🏆 <b>Новый бейдж!</b>\n\n${badge.emoji} <b>${badge.name}</b>\n<i>${badge.desc}</i>`
    );
  }
  return true;
}

async function getUserBadges(userId) {
  const badgeIds = (await kvGet(`${KV_PREFIXES.BADGES}${userId}`)) || [];
  return badgeIds.map(id => BADGES[id]).filter(Boolean);
}

async function checkUploadBadges(userId, totalUploads) {
  if (totalUploads === 1) await awardBadge(userId, "FIRST_UPLOAD");
  if (totalUploads === 10) await awardBadge(userId, "UPLOADS_10");
  if (totalUploads === 50) await awardBadge(userId, "UPLOADS_50");
  if (totalUploads === 100) await awardBadge(userId, "UPLOADS_100");
}

// ============================================================================
// 8. REFERRALS
// ============================================================================

async function processReferral(newUserId, referrerId) {
  if (!referrerId || String(newUserId) === String(referrerId)) return false;
  
  const existing = await kvGet(`${KV_PREFIXES.REFERRED_BY}${newUserId}`);
  if (existing) return false;
  
  const referrer = await getUser(referrerId);
  if (!referrer.createdAt) return false;
  
  await kvSet(`${KV_PREFIXES.REFERRED_BY}${newUserId}`, referrerId);
  
  const referrals = (await kvGet(`${KV_PREFIXES.REFERRALS}${referrerId}`)) || [];
  referrals.push({ userId: String(newUserId), date: Date.now() });
  await kvSet(`${KV_PREFIXES.REFERRALS}${referrerId}`, referrals);
  
  const count = referrals.length;
  await sendMessage(
    referrerId,
    `🎉 <b>Новый реферал!</b>\n\nТы пригласил ${count} ${getWordForm(count, ["человека", "человек", "человек"])}.`
  );
  
  if (count === 1) await awardBadge(referrerId, "REFERRER_1");
  if (count === 5) await awardBadge(referrerId, "REFERRER_5");
  
  return true;
}

// ============================================================================
// 9. STATS & LOGS
// ============================================================================

async function incrementStat(key, increment = 1) {
  const stats = (await kvGet(KV_PREFIXES.STATS)) || {};
  stats[key] = (stats[key] || 0) + increment;
  await kvSet(KV_PREFIXES.STATS, stats);
}

async function getStats() {
  return (await kvGet(KV_PREFIXES.STATS)) || {};
}

async function logAction(action, details = {}) {
  try {
    const entry = { id: Date.now().toString(36), timestamp: Date.now(), action, ...details };
    const logs = (await kvGet(KV_PREFIXES.LOGS)) || [];
    logs.unshift(entry);
    if (logs.length > 300) logs.length = 300;
    await kvSet(KV_PREFIXES.LOGS, logs);
    
    if (CONFIG.LOG_CHANNEL_ID) {
      await sendMessage(
        CONFIG.LOG_CHANNEL_ID,
        `📋 <b>${action.toUpperCase()}</b>\n` +
        `${details.userId ? `👤 <code>${details.userId}</code>\n` : ""}` +
        `${details.details ? `📝 ${escapeHtml(details.details)}\n` : ""}` +
        `🕒 ${formatDate(Date.now())}`
      );
    }
  } catch (e) {
    console.error("[LOG ERROR]", e.message);
  }
}

async function getLogs(limit = 30) {
  const logs = (await kvGet(KV_PREFIXES.LOGS)) || [];
  return logs.slice(0, limit);
}

// ============================================================================
// 10. RATE LIMIT
// ============================================================================

async function checkRateLimit(userId, action = "default") {
  const key = `${KV_PREFIXES.RATE}${userId}:${action}`;
  const now = Date.now();
  let data = await kvGet(key);
  
  if (!data || now - data.start > CONFIG.RATE_LIMIT_WINDOW) {
    data = { count: 1, start: now };
    await kvSet(key, data, { ex: 120 });
    return true;
  }
  
  if (data.count >= CONFIG.RATE_LIMIT_MAX) return false;
  
  data.count++;
  await kvSet(key, data, { ex: 120 });
  return true;
}

// ============================================================================
// 11. ГЛАВНОЕ МЕНЮ
// ============================================================================

function getMainKeyboard(userId) {
  const kb = [
    [
      { text: "📤 Загрузить файл", callback_data: "upload_help" },
      { text: "📁 Мои файлы", callback_data: "my_files" },
    ],
    [
      { text: "🔍 Найти по коду", callback_data: "search_code" },
      { text: "🔥 Топ файлов", callback_data: "top_files" },
    ],
    [
      { text: "👤 Профиль", callback_data: "profile" },
      { text: "🏆 Бейджи", callback_data: "badges" },
    ],
    [
      { text: "🔗 Пригласить друга", callback_data: "referral" },
      { text: "❓ Помощь", callback_data: "help" },
    ],
  ];
  
  if (isAdmin(userId)) {
    kb.unshift([{ text: "👑 Админ-панель", callback_data: "admin_panel" }]);
  }
  
  return kb;
}

async function sendMainMenu(chatId, userId, username) {
  await saveUser(userId, {}, username);
  
  const user = await getUser(userId);
  const stats = await getStats();
  const isNew = !user.createdAt || Date.now() - (user.createdAt || 0) < 5000;
  
  let greeting = isNew ? "👋 <b>Добро пожаловать в FileShare Bot!</b>" : "📦 <b>FileShare Bot</b>";
  
  const text =
    `${greeting}\n\n` +
    `Обменивайся файлами легко: загружай, получай короткий код, делись с друзьями.\n\n` +
    `📊 <b>Статистика:</b>\n` +
    `• Файлов всего: ${stats.total_files || 0}\n` +
    `• Пользователей: ${stats.total_users || 0}\n` +
    `• Загрузок: ${stats.total_downloads || 0}\n\n` +
    `Выбери действие:`;
  
  return sendInline(chatId, text, getMainKeyboard(userId));
}

// ============================================================================
// 12. ЗАГРУЗКА ФАЙЛОВ
// ============================================================================

/**
 * Определяет тип и информацию о файле из сообщения
 */
function extractFileInfo(message) {
  if (message.document) {
    return {
      type: "document",
      fileId: message.document.file_id,
      fileName: message.document.file_name || "document",
      fileSize: message.document.file_size || 0,
      mimeType: message.document.mime_type || "application/octet-stream",
    };
  }
  if (message.photo && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1];
    return {
      type: "photo",
      fileId: photo.file_id,
      fileName: "photo.jpg",
      fileSize: photo.file_size || 0,
      mimeType: "image/jpeg",
    };
  }
  if (message.video) {
    return {
      type: "video",
      fileId: message.video.file_id,
      fileName: message.video.file_name || "video.mp4",
      fileSize: message.video.file_size || 0,
      mimeType: message.video.mime_type || "video/mp4",
    };
  }
  if (message.audio) {
    return {
      type: "audio",
      fileId: message.audio.file_id,
      fileName: message.audio.file_name || "audio.mp3",
      fileSize: message.audio.file_size || 0,
      mimeType: message.audio.mime_type || "audio/mpeg",
    };
  }
  if (message.voice) {
    return {
      type: "voice",
      fileId: message.voice.file_id,
      fileName: "voice.ogg",
      fileSize: message.voice.file_size || 0,
      mimeType: message.voice.mime_type || "audio/ogg",
    };
  }
  if (message.video_note) {
    return {
      type: "video_note",
      fileId: message.video_note.file_id,
      fileName: "video_note.mp4",
      fileSize: message.video_note.file_size || 0,
      mimeType: "video/mp4",
    };
  }
  if (message.sticker) {
    return {
      type: "sticker",
      fileId: message.sticker.file_id,
      fileName: "sticker.webp",
      fileSize: message.sticker.file_size || 0,
      mimeType: "image/webp",
    };
  }
  if (message.animation) {
    return {
      type: "animation",
      fileId: message.animation.file_id,
      fileName: message.animation.file_name || "animation.mp4",
      fileSize: message.animation.file_size || 0,
      mimeType: message.animation.mime_type || "video/mp4",
    };
  }
  return null;
}

/**
 * Обрабатывает загрузку файла пользователем
 */
async function handleFileUpload(message, fileInfo) {
  const userId = String(message.from.id);
  const username = message.from.username;
  const chatId = message.chat.id;
  
  // Проверки
  if (await isBanned(userId)) {
    return sendMessage(chatId, "🚫 Вы заблокированы и не можете загружать файлы.");
  }
  if (await isMuted(userId)) {
    return sendMessage(chatId, "🔇 Вы замьючены и не можете загружать файлы.");
  }
  if (!isAdmin(userId) && !await checkRateLimit(userId, "upload")) {
    return sendMessage(chatId, "⏳ Слишком много загрузок. Подождите минуту.");
  }
  
  // Проверка размера
  const maxSize = CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024;
  if (fileInfo.fileSize > maxSize) {
    return sendMessage(
      chatId,
      `❌ <b>Файл слишком большой</b>\n\n` +
      `Размер: ${formatBytes(fileInfo.fileSize)}\n` +
      `Максимум: ${CONFIG.MAX_FILE_SIZE_MB} MB`
    );
  }
  
  // Проверка дневного лимита
  if (!isAdmin(userId)) {
    const dailyUploads = await getUserDailyUploads(userId);
    if (dailyUploads >= CONFIG.MAX_FILES_PER_DAY) {
      return sendMessage(
        chatId,
        `📊 <b>Дневной лимит исчерпан</b>\n\n` +
        `Вы загрузили ${dailyUploads} файлов за сутки.\n` +
        `Лимит: ${CONFIG.MAX_FILES_PER_DAY}/день`
      );
    }
    
    // Проверка лимита хранилища
    const usedBytes = await getUserStorageBytes(userId);
    const maxStorage = CONFIG.MAX_STORAGE_MB * 1024 * 1024;
    if (usedBytes + fileInfo.fileSize > maxStorage) {
      return sendMessage(
        chatId,
        `💾 <b>Недостаточно места</b>\n\n` +
        `Использовано: ${formatBytes(usedBytes)}\n` +
        `Лимит: ${CONFIG.MAX_STORAGE_MB} MB\n\n` +
        `Удалите старые файлы: /myfiles`
      );
    }
  }
  
  await sendChatAction(chatId, "typing");
  
  // Генерируем уникальный код
  let code = generateCode();
  let attempts = 0;
  while (await kvGet(`${KV_PREFIXES.FILE_CODE}${code}`) && attempts < 10) {
    code = generateCode();
    attempts++;
  }
  
  // Получаем информацию о файле из Telegram
  const tgFile = await getFile(fileInfo.fileId);
  if (!tgFile) {
    return sendMessage(chatId, "❌ Не удалось получить информацию о файле от Telegram.");
  }
  
  // Скачиваем файл
  const fileBuffer = await downloadFile(tgFile.filePath);
  if (!fileBuffer) {
    return sendMessage(chatId, "❌ Не удалось скачать файл.");
  }
  
  // Загружаем в Blob
  const blobPath = `files/${userId}/${Date.now()}_${fileInfo.fileName}`;
  const blobUrl = await uploadToBlob(blobPath, fileBuffer, fileInfo.mimeType);
  
  if (!blobUrl) {
    return sendMessage(chatId, "❌ Не удалось сохранить файл на сервере.");
  }
  
  // Формируем fileId (внутренний)
  const internalFileId = `${Date.now().toString(36)}${Math.random().toString(36).substr(2, 6)}`;
  
  // Данные файла
  const fileData = {
    id: internalFileId,
    code: code,
    ownerId: userId,
    ownerName: getSafeUserName(message.from),
    fileName: fileInfo.fileName,
    fileSize: fileInfo.fileSize,
    mimeType: fileInfo.mimeType,
    type: fileInfo.type,
    telegramFileId: fileInfo.fileId, // для быстрой пересылки
    blobUrl: blobUrl,
    caption: message.caption || "",
    tags: [],
    downloads: 0,
    isPublic: true,
    createdAt: Date.now(),
    expiresAt: null, // установим ниже
  };
  
  // Сохраняем
  await saveFile(internalFileId, fileData);
  await kvSet(`${KV_PREFIXES.FILE_CODE}${code}`, internalFileId);
  await kvSadd(`${KV_PREFIXES.USER_FILES}${userId}`, internalFileId);
  
  // Обновляем статистику
  await saveUser(userId, {
    uploads: (await getUser(userId)).uploads + 1,
    totalBytes: (await getUser(userId)).totalBytes + fileInfo.fileSize,
  }, username);
  
  await incrementDailyUploads(userId);
  await incrementStat("total_files", 1);
  await incrementStat("total_bytes", fileInfo.fileSize);
  
  // Проверяем бейджи
  const user = await getUser(userId);
  await checkUploadBadges(userId, user.uploads || 1);
  
  await logAction("file_upload", { userId, details: `${fileInfo.fileName} (${code})` });
  
  // Отправляем сообщение с кодом
  const typeInfo = FILE_TYPES[fileInfo.type] || FILE_TYPES.document;
  
  const text =
    `✅ <b>Файл загружен!</b>\n\n` +
    `${typeInfo.emoji} <b>Имя:</b> <code>${escapeHtml(fileInfo.fileName)}</code>\n` +
    `📦 <b>Размер:</b> ${formatBytes(fileInfo.fileSize)}\n` +
    `🔑 <b>Код доступа:</b> <code>${code}</code>\n\n` +
    `<b>Как получить файл:</b>\n` +
    `• Отправь другу код <code>${code}</code>\n` +
    `• Или команду <code>/get ${code}</code>\n\n` +
    `🔗 <b>Ссылка:</b> https://t.me/${CONFIG.BOT_USERNAME}?start=get_${code}`;
  
  const kb = [
    [{ text: "📤 Загрузить ещё", callback_data: "upload_help" }],
    [{ text: "📁 Мои файлы", callback_data: "my_files" }],
  ];
  
  return sendInline(chatId, text, kb);
}

/**
 * Выдаёт файл по коду
 */
async function sendFileByCode(chatId, userId, code) {
  const file = await getFileByCode(code);
  
  if (!file) {
    return sendMessage(chatId, `❌ Файл с кодом <code>${escapeHtml(code)}</code> не найден.`);
  }
  
  // Проверка истечения
  if (file.expiresAt && Date.now() > file.expiresAt) {
    return sendMessage(chatId, `⏰ Файл с кодом <code>${escapeHtml(code)}</code> истёк.`);
  }
  
  // Увеличиваем счётчик
  file.downloads = (file.downloads || 0) + 1;
  await saveFile(file.id, file);
  await incrementStat("total_downloads", 1);
  
  // Бейдж популяности владельцу
  if (file.downloads === 100) {
    await awardBadge(file.ownerId, "POPULAR");
  }
  
  // Обновляем счётчик скачиваний у юзера
  const user = await getUser(userId);
  await saveUser(userId, { downloads: (user.downloads || 0) + 1 });
  
  // Отправляем файл
  const typeInfo = FILE_TYPES[file.type] || FILE_TYPES.document;
  const caption =
    `${typeInfo.emoji} <b>${escapeHtml(file.fileName)}</b>\n\n` +
    `📦 Размер: ${formatBytes(file.fileSize)}\n` +
    `📥 Скачиваний: ${file.downloads}\n` +
    `👤 Загрузил: ${escapeHtml(file.ownerName)}`;
  
  const extra = { caption, parse_mode: "HTML" };
  
  try {
    if (file.type === "photo") {
      return await sendPhoto(chatId, file.telegramFileId, caption, { parse_mode: "HTML" });
    } else if (file.type === "video") {
      return await sendVideo(chatId, file.telegramFileId, caption, { parse_mode: "HTML" });
    } else if (file.type === "audio") {
      return await sendAudio(chatId, file.telegramFileId, caption, { parse_mode: "HTML" });
    } else if (file.type === "voice") {
      return await sendVoice(chatId, file.telegramFileId, caption, { parse_mode: "HTML" });
    } else if (file.type === "animation") {
      return await sendAnimation(chatId, file.telegramFileId, caption, { parse_mode: "HTML" });
    } else if (file.type === "sticker") {
      return await sendSticker(chatId, file.telegramFileId);
    } else if (file.type === "video_note") {
      return await sendVideoNote(chatId, file.telegramFileId);
    } else {
      return await sendDocument(chatId, file.telegramFileId, caption, { parse_mode: "HTML" });
    }
  } catch (error) {
    console.error("[SEND FILE ERROR]", error.message);
    // Fallback: даём ссылку на Blob
    return sendMessage(
      chatId,
      `⚠️ Не удалось отправить файл через Telegram.\n\n` +
      `🔗 <a href="${file.blobUrl}">Скачать напрямую</a>`
    );
  }
}

// ============================================================================
// 13. МОИ ФАЙЛЫ
// ============================================================================

async function showMyFiles(chatId, userId, page = 0) {
  const files = await getUserFiles(userId);
  
  if (files.length === 0) {
    return sendInline(
      chatId,
      `📁 <b>У тебя пока нет загруженных файлов</b>\n\n` +
      `Отправь любой файл в чат — я сохраню его и дам короткий код!`,
      [[{ text: "📤 Загрузить", callback_data: "upload_help" }], [{ text: "⬅️ Назад", callback_data: "home" }]]
    );
  }
  
  const perPage = 5;
  const totalPages = Math.ceil(files.length / perPage);
  const current = Math.min(page, totalPages - 1);
  const pageFiles = files.slice(current * perPage, (current + 1) * perPage);
  
  let text = `📁 <b>Мои файлы</b> (${files.length})\n`;
  text += `Страница ${current + 1}/${totalPages}\n\n`;
  
  const kb = [];
  
  for (const file of pageFiles) {
    const typeInfo = FILE_TYPES[file.type] || FILE_TYPES.document;
    const expiresIn = file.expiresAt
      ? `⏰ ${formatDate(file.expiresAt)}`
      : "♾️ бессрочно";
    
    text += `${typeInfo.emoji} <code>${file.code}</code> — <b>${escapeHtml(truncate(file.fileName, 30))}</b>\n`;
    text += `   📦 ${formatBytes(file.fileSize)} • 📥 ${file.downloads || 0} • ${expiresIn}\n\n`;
    
    kb.push([{ text: `📥 ${file.code} — ${truncate(file.fileName, 20)}`, callback_data: `get_file_${file.code}` }]);
  }
  
  // Навигация
  const navRow = [];
  if (current > 0) navRow.push({ text: "⬅️", callback_data: `my_files_${current - 1}` });
  navRow.push({ text: `${current + 1}/${totalPages}`, callback_data: "ignore" });
  if (current < totalPages - 1) navRow.push({ text: "➡️", callback_data: `my_files_${current + 1}` });
  if (navRow.length > 1) kb.push(navRow);
  
  kb.push([{ text: "⬅️ Назад", callback_data: "home" }]);
  
  return sendInline(chatId, text, kb);
}

// ============================================================================
// 14. ПРОФИЛЬ
// ============================================================================

async function showProfile(chatId, userId) {
  const user = await getUser(userId);
  const badges = await getUserBadges(userId);
  const referrals = (await kvGet(`${KV_PREFIXES.REFERRALS}${userId}`)) || [];
  const files = await getUserFiles(userId);
  const usedBytes = files.reduce((sum, f) => sum + (f.fileSize || 0), 0);
  
  const badgesText = badges.length > 0
    ? badges.map(b => `${b.emoji} ${b.name}`).join(", ")
    : "Нет бейджей";
  
  const text =
    `👤 <b>Профиль</b>\n\n` +
    `🆔 ID: <code>${userId}</code>\n` +
    `📛 Username: ${user.username ? `@${escapeHtml(user.username)}` : "не указан"}\n` +
    `📅 Регистрация: ${formatDate(user.createdAt)}\n` +
    `🕒 Был: ${timeAgo(user.lastSeen)}\n\n` +
    `📊 <b>Статистика:</b>\n` +
    `• Загрузок: <b>${user.uploads || 0}</b>\n` +
    `• Скачиваний: <b>${user.downloads || 0}</b>\n` +
    `• Занято: <b>${formatBytes(usedBytes)}</b> из ${CONFIG.MAX_STORAGE_MB} MB\n` +
    `• Приглашено: <b>${referrals.length}</b>\n\n` +
    `🏅 <b>Бейджи:</b> ${badgesText}`;
  
  const kb = [
    [
      { text: "📁 Мои файлы", callback_data: "my_files" },
      { text: "🏆 Бейджи", callback_data: "badges" },
    ],
    [
      { text: "🔗 Пригласить", callback_data: "referral" },
      { text: "⬅️ Назад", callback_data: "home" },
    ],
  ];
  
  return sendInline(chatId, text, kb);
}

async function showBadges(chatId, userId) {
  const userBadges = await getUserBadges(userId);
  const allBadges = Object.values(BADGES);
  
  let text = `🏆 <b>Мои бейджи (${userBadges.length}/${allBadges.length})</b>\n\n`;
  
  for (const badge of allBadges) {
    const has = userBadges.some(b => b.id === badge.id);
    text += `${has ? "✅" : "⬜"} ${badge.emoji} <b>${badge.name}</b>\n`;
    text += `   <i>${badge.desc}</i>\n\n`;
  }
  
  return sendInline(chatId, text, [[{ text: "⬅️ Назад", callback_data: "home" }]]);
}

async function showReferral(chatId, userId) {
  const referrals = (await kvGet(`${KV_PREFIXES.REFERRALS}${userId}`)) || [];
  const refLink = `https://t.me/${CONFIG.BOT_USERNAME}?start=ref_${userId}`;
  const shareText = encodeURIComponent(`📦 Крутой бот-файлообменник! Загружай файлы и делись ими по короткому коду: ${refLink}`);
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${shareText}`;
  
  const text =
    `🔗 <b>Пригласи друга</b>\n\n` +
    `За каждого приглашённого — бейджи и бонусы!\n\n` +
    `<b>Твоя ссылка:</b>\n<code>${refLink}</code>\n\n` +
    `👥 Приглашено: <b>${referrals.length}</b>\n\n` +
    `<b>Награды:</b>\n` +
    `🌱 1 друг — Новичок\n` +
    `👥 5 друзей — Реферрал-мастер`;
  
  const kb = [
    [{ text: "📤 Поделиться", url: shareUrl }],
    [{ text: "⬅️ Назад", callback_data: "home" }],
  ];
  
  return sendInline(chatId, text, kb);
}

async function showHelp(chatId, isAdminUser = false) {
  let text =
    `📖 <b>Справка</b>\n\n` +
    `<b>Основные команды:</b>\n` +
    `/start — Меню\n` +
    `/get КОД — Скачать файл по коду\n` +
    `/myfiles — Мои файлы\n` +
    `/delete КОД — Удалить файл\n` +
    `/search ЗАПРОС — Поиск по имени\n` +
    `/top — Топ популярных файлов\n` +
    `/profile — Профиль\n` +
    `/badges — Бейджи\n` +
    `/share — Пригласить друга\n` +
    `/help — Эта справка\n\n` +
    `<b>Как загружать файлы:</b>\n` +
    `Просто отправь боту любой файл — я сохраню и дам короткий код.\n\n` +
    `<b>Ограничения:</b>\n` +
    `• Макс. размер файла: ${CONFIG.MAX_FILE_SIZE_MB} MB\n` +
    `• Макс. загрузок в день: ${CONFIG.MAX_FILES_PER_DAY}\n` +
    `• Макс. хранилище: ${CONFIG.MAX_STORAGE_MB} MB`;
  
  if (isAdminUser) {
    text +=
      `\n\n<b>👑 Админ-команды:</b>\n` +
      `/admin — Панель\n` +
      `/stats — Статистика\n` +
      `/logs — Логи\n` +
      `/ban ID — Забанить\n` +
      `/unban ID — Разбанить\n` +
      `/mute ID [часы] — Замьютить\n` +
      `/unmute ID — Размьютить\n` +
      `/userinfo ID — Инфо о юзере\n` +
      `/broadcast ТЕКСТ — Рассылка\n` +
      `/clearexpired — Очистить истёкшие`;
  }
  
  return sendInline(chatId, text, [[{ text: "⬅️ Назад", callback_data: "home" }]]);
}

async function showTopFiles(chatId) {
  const allFileIds = await kvSmembers(KV_PREFIXES.ALL_FILES);
  const files = [];
  
  for (const id of allFileIds) {
    const f = await getFileById(id);
    if (f && f.isPublic && (!f.expiresAt || f.expiresAt > Date.now())) {
      files.push(f);
    }
  }
  
  if (files.length === 0) {
    return sendInline(chatId, `📭 Пока нет публичных файлов.`, [[{ text: "⬅️ Назад", callback_data: "home" }]]);
  }
  
  files.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
  const top = files.slice(0, 10);
  
  let text = `🔥 <b>Топ файлов</b>\n\n`;
  const kb = [];
  
  top.forEach((file, i) => {
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
    const typeInfo = FILE_TYPES[file.type] || FILE_TYPES.document;
    text += `${medal} ${typeInfo.emoji} <code>${file.code}</code> — <b>${escapeHtml(truncate(file.fileName, 25))}</b>\n`;
    text += `   📥 ${file.downloads || 0} скачиваний\n\n`;
    kb.push([{ text: `📥 ${file.code} — ${truncate(file.fileName, 20)}`, callback_data: `get_file_${file.code}` }]);
  });
  
  kb.push([{ text: "⬅️ Назад", callback_data: "home" }]);
  
  return sendInline(chatId, text, kb);
}

async function searchFiles(chatId, userId, query) {
  const allFileIds = await kvSmembers(KV_PREFIXES.ALL_FILES);
  const results = [];
  const q = query.toLowerCase();
  
  for (const id of allFileIds) {
    const f = await getFileById(id);
    if (!f) continue;
    // Только свои + публичные
    if (f.ownerId !== userId && !f.isPublic) continue;
    if (f.fileName.toLowerCase().includes(q)) {
      results.push(f);
    }
  }
  
  if (results.length === 0) {
    return sendInline(chatId, `🔍 Ничего не найдено по запросу <b>${escapeHtml(query)}</b>`, [[{ text: "⬅️ Назад", callback_data: "home" }]]);
  }
  
  results.sort((a, b) => b.createdAt - a.createdAt);
  const top = results.slice(0, 10);
  
  let text = `🔍 <b>Найдено: ${results.length}</b>\n\n`;
  const kb = [];
  
  for (const file of top) {
    const typeInfo = FILE_TYPES[file.type] || FILE_TYPES.document;
    text += `${typeInfo.emoji} <code>${file.code}</code> — <b>${escapeHtml(truncate(file.fileName, 30))}</b>\n`;
    text += `   📦 ${formatBytes(file.fileSize)} • 📥 ${file.downloads || 0}\n\n`;
    kb.push([{ text: `📥 ${file.code} — ${truncate(file.fileName, 20)}`, callback_data: `get_file_${file.code}` }]);
  }
  
  kb.push([{ text: "⬅️ Назад", callback_data: "home" }]);
  
  return sendInline(chatId, text, kb);
}

// ============================================================================
// 15. АДМИН-ПАНЕЛЬ
// ============================================================================

async function showAdminPanel(chatId, userId) {
  if (!isAdmin(userId)) return;
  
  const stats = await getStats();
  const allFiles = await kvSmembers(KV_PREFIXES.ALL_FILES);
  const allUsers = await kvSmembers(KV_PREFIXES.ALL_USERS);
  const banned = await kvSmembers(KV_PREFIXES.BAN_LIST);
  
  const text =
    `👑 <b>Админ-панель</b>\n\n` +
    `📦 Файлов: <b>${allFiles.length}</b>\n` +
    `👥 Пользователей: <b>${allUsers.length}</b>\n` +
    `📥 Скачиваний: <b>${stats.total_downloads || 0}</b>\n` +
    `🚫 Забанено: <b>${banned.length}</b>\n` +
    `💾 Объём: <b>${formatBytes(stats.total_bytes || 0)}</b>\n\n` +
    `Выбери действие:`;
  
  const kb = [
    [
      { text: "📊 Статистика", callback_data: "admin_stats" },
      { text: "📝 Логи", callback_data: "admin_logs" },
    ],
    [
      { text: "🚫 Забаненные", callback_data: "admin_banned" },
      { text: "👥 Пользователи", callback_data: "admin_users_0" },
    ],
    [
      { text: "📢 Рассылка", callback_data: "admin_broadcast_help" },
      { text: "🧹 Очистить истёкшие", callback_data: "admin_cleanup" },
    ],
    [
      { text: "⬅️ Назад", callback_data: "home" },
    ],
  ];
  
  return sendInline(chatId, text, kb);
}

async function showAdminStats(chatId, userId) {
  if (!isAdmin(userId)) return;
  
  const stats = await getStats();
  const allFiles = await kvSmembers(KV_PREFIXES.ALL_FILES);
  const allUsers = await kvSmembers(KV_PREFIXES.ALL_USERS);
  
  let activeFiles = 0;
  let expiredFiles = 0;
  let totalSize = 0;
  
  for (const id of allFiles) {
    const f = await getFileById(id);
    if (!f) continue;
    if (f.expiresAt && f.expiresAt < Date.now()) {
      expiredFiles++;
    } else {
      activeFiles++;
    }
    totalSize += f.fileSize || 0;
  }
  
  const text =
    `📊 <b>Статистика системы</b>\n\n` +
    `<b>📦 Файлы:</b>\n` +
    `• Всего: ${allFiles.length}\n` +
    `• Активных: ${activeFiles}\n` +
    `• Истёкших: ${expiredFiles}\n` +
    `• Объём: ${formatBytes(totalSize)}\n\n` +
    `<b>👥 Пользователи:</b>\n` +
    `• Всего: ${allUsers.length}\n\n` +
    `<b>📥 Скачивания:</b> ${stats.total_downloads || 0}\n\n` +
    `<b>⚙️ Конфигурация:</b>\n` +
    `• Макс. размер: ${CONFIG.MAX_FILE_SIZE_MB} MB\n` +
    `• Лимит загрузок/день: ${CONFIG.MAX_FILES_PER_DAY}\n` +
    `• Лимит хранилища: ${CONFIG.MAX_STORAGE_MB} MB`;
  
  return sendInline(chatId, text, [
    [{ text: "🔄 Обновить", callback_data: "admin_stats" }],
    [{ text: "⬅️ Назад", callback_data: "admin_panel" }],
  ]);
}

async function showAdminLogs(chatId, userId) {
  if (!isAdmin(userId)) return;
  
  const logs = await getLogs(30);
  
  if (logs.length === 0) {
    return sendInline(chatId, "📭 Логи пусты.", [[{ text: "⬅️ Назад", callback_data: "admin_panel" }]]);
  }
  
  let text = `📝 <b>Последние действия (${logs.length})</b>\n\n`;
  
  for (const entry of logs) {
    text += `• ${formatDate(entry.timestamp)} — <b>${entry.action}</b>`;
    if (entry.userId) text += ` [<code>${entry.userId}</code>]`;
    if (entry.details) text += `\n  <i>${escapeHtml(truncate(entry.details, 60))}</i>`;
    text += "\n";
  }
  
  return sendInline(chatId, text, [[{ text: "⬅️ Назад", callback_data: "admin_panel" }]]);
}

async function showAdminBanned(chatId, userId) {
  if (!isAdmin(userId)) return;
  
  const banned = await kvSmembers(KV_PREFIXES.BAN_LIST);
  
  if (banned.length === 0) {
    return sendInline(chatId, "📭 Нет забаненных.", [[{ text: "⬅️ Назад", callback_data: "admin_panel" }]]);
  }
  
  let text = `🚫 <b>Забаненные (${banned.length})</b>\n\n`;
  const kb = [];
  
  for (const uid of banned.slice(0, 15)) {
    const u = await getUser(uid);
    text += `👤 <code>${uid}</code> — ${u.username ? `@${u.username}` : "no username"}\n`;
    kb.push([{ text: `✅ Разбанить ${uid}`, callback_data: `admin_unban_${uid}` }]);
  }
  
  kb.push([{ text: "⬅️ Назад", callback_data: "admin_panel" }]);
  
  return sendInline(chatId, text, kb);
}

async function showAdminUsers(chatId, userId, page = 0) {
  if (!isAdmin(userId)) return;
  
  const allUsers = await kvSmembers(KV_PREFIXES.ALL_USERS);
  
  if (allUsers.length === 0) {
    return sendInline(chatId, "📭 Нет пользователей.", [[{ text: "⬅️ Назад", callback_data: "admin_panel" }]]);
  }
  
  const perPage = 10;
  const totalPages = Math.ceil(allUsers.length / perPage);
  const current = Math.min(page, totalPages - 1);
  const pageUsers = allUsers.slice(current * perPage, (current + 1) * perPage);
  
  let text = `👥 <b>Пользователи (${allUsers.length})</b>\n`;
  text += `Страница ${current + 1}/${totalPages}\n\n`;
  
  for (const uid of pageUsers) {
    const u = await getUser(uid);
    const banned = await isBanned(uid);
    const flag = banned ? "🚫" : "✅";
    text += `${flag} <code>${uid}</code> — ${u.username ? `@${u.username}` : "—"}\n`;
    text += `   📤 ${u.uploads || 0} • 📥 ${u.downloads || 0} • 🕒 ${timeAgo(u.lastSeen)}\n`;
  }
  
  const kb = [];
  const navRow = [];
  if (current > 0) navRow.push({ text: "⬅️", callback_data: `admin_users_${current - 1}` });
  navRow.push({ text: `${current + 1}/${totalPages}`, callback_data: "ignore" });
  if (current < totalPages - 1) navRow.push({ text: "➡️", callback_data: `admin_users_${current + 1}` });
  if (navRow.length > 1) kb.push(navRow);
  
  kb.push([{ text: "⬅️ Назад", callback_data: "admin_panel" }]);
  
  return sendInline(chatId, text, kb);
}

async function cleanExpiredFiles() {
  const allFiles = await kvSmembers(KV_PREFIXES.ALL_FILES);
  let deleted = 0;
  
  for (const id of allFiles) {
    const f = await getFileById(id);
    if (!f) continue;
    if (f.expiresAt && f.expiresAt < Date.now()) {
      await deleteFile(id);
      deleted++;
    }
  }
  
  return deleted;
}

// ============================================================================
// 16. ОБРАБОТКА КОМАНД
// ============================================================================

async function processCommand(message, text) {
  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const username = message.from.username;
  const { command, args } = parseCommand(text);
  
  // Сохраняем юзера
  await saveUser(userId, {}, username);
  
  // Проверки
  if (await isBanned(userId) && !isAdmin(userId)) {
    return sendMessage(chatId, "🚫 Вы заблокированы.");
  }
  
  // Основные команды
  if (command === "/start") {
    // Реф
    if (args[0] && args[0].startsWith("ref_")) {
      const referrerId = args[0].replace("ref_", "");
      const wasNew = await processReferral(userId, referrerId);
      if (wasNew) {
        await sendMessage(chatId, `✅ <b>Ты зарегистрирован по реферальной ссылке!</b>`);
      }
    }
    // Быстрый доступ к файлу
    if (args[0] && args[0].startsWith("get_")) {
      const code = args[0].replace("get_", "");
      return sendFileByCode(chatId, userId, code);
    }
    return sendMainMenu(chatId, userId, username);
  }
  
  if (command === "/help") return showHelp(chatId, isAdmin(userId));
  
  if (command === "/get") {
    if (!args[0]) return sendMessage(chatId, "❌ Использование: <code>/get КОД</code>");
    return sendFileByCode(chatId, userId, args[0].toUpperCase());
  }
  
  if (command === "/myfiles") return showMyFiles(chatId, userId);
  
  if (command === "/delete") {
    if (!args[0]) return sendMessage(chatId, "❌ Использование: <code>/delete КОД</code>");
    const file = await getFileByCode(args[0]);
    if (!file) return sendMessage(chatId, "❌ Файл не найден.");
    if (file.ownerId !== userId && !isAdmin(userId)) {
      return sendMessage(chatId, "❌ Это не твой файл.");
    }
    await deleteFile(file.id);
    await logAction("file_delete", { userId, details: `${file.code}` });
    return sendMessage(chatId, `✅ Файл <code>${file.code}</code> удалён.`);
  }
  
  if (command === "/search") {
    if (!args[0]) return sendMessage(chatId, "❌ Использование: <code>/search ЗАПРОС</code>");
    return searchFiles(chatId, userId, args.join(" "));
  }
  
  if (command === "/top") return showTopFiles(chatId);
  if (command === "/profile") return showProfile(chatId, userId);
  if (command === "/badges") return showBadges(chatId, userId);
  if (command === "/share") return showReferral(chatId, userId);
  
  // Админ-команды
  if (command === "/admin") return showAdminPanel(chatId, userId);
  if (command === "/stats") {
    if (!isAdmin(userId)) return;
    return showAdminStats(chatId, userId);
  }
  if (command === "/logs") {
    if (!isAdmin(userId)) return;
    return showAdminLogs(chatId, userId);
  }
  if (command === "/ban") {
    if (!isAdmin(userId)) return;
    if (!args[0] || !isNumeric(args[0])) return sendMessage(chatId, "❌ <code>/ban ID [причина]</code>");
    if (isAdmin(args[0])) return sendMessage(chatId, "❌ Нельзя забанить админа.");
    const reason = args.slice(1).join(" ") || "—";
    await banUser(args[0], reason);
    await logAction("ban", { userId, details: `${args[0]}: ${reason}` });
    return sendMessage(chatId, `✅ <code>${args[0]}</code> забанен.\nПричина: ${escapeHtml(reason)}`);
  }
  if (command === "/unban") {
    if (!isAdmin(userId)) return;
    if (!args[0] || !isNumeric(args[0])) return sendMessage(chatId, "❌ <code>/unban ID</code>");
    await unbanUser(args[0]);
    return sendMessage(chatId, `✅ <code>${args[0]}</code> разбанен.`);
  }
  if (command === "/mute") {
    if (!isAdmin(userId)) return;
    if (!args[0] || !isNumeric(args[0])) return sendMessage(chatId, "❌ <code>/mute ID [часы]</code>");
    const hours = parseInt(args[1]) || 24;
    await muteUser(args[0], hours * 3600000);
    return sendMessage(chatId, `🔇 <code>${args[0]}</code> замьючен на ${hours}ч.`);
  }
  if (command === "/unmute") {
    if (!isAdmin(userId)) return;
    if (!args[0] || !isNumeric(args[0])) return sendMessage(chatId, "❌ <code>/unmute ID</code>");
    await unmuteUser(args[0]);
    return sendMessage(chatId, `🔊 <code>${args[0]}</code> размьючен.`);
  }
  if (command === "/userinfo") {
    if (!isAdmin(userId)) return;
    if (!args[0] || !isNumeric(args[0])) return sendMessage(chatId, "❌ <code>/userinfo ID</code>");
    const u = await getUser(args[0]);
    const badges = await getUserBadges(args[0]);
    const files = await getUserFiles(args[0]);
    const banned = await isBanned(args[0]);
    const muted = await isMuted(args[0]);
    
    const text =
      `👤 <b>Инфо о пользователе</b>\n\n` +
      `🆔 <code>${args[0]}</code>\n` +
      `📛 ${u.username ? `@${u.username}` : "—"}\n` +
      `📅 Регистрация: ${formatDate(u.createdAt)}\n` +
      `🕒 Был: ${timeAgo(u.lastSeen)}\n` +
      `🚫 Бан: ${banned ? "Да" : "Нет"}\n` +
      `🔇 Мут: ${muted ? "Да" : "Нет"}\n\n` +
      `📤 Загрузок: ${u.uploads || 0}\n` +
      `📥 Скачиваний: ${u.downloads || 0}\n` +
      `📦 Занято: ${formatBytes(u.totalBytes || 0)}\n\n` +
      `🏆 Бейджи: ${badges.length > 0 ? badges.map(b => b.emoji).join(" ") : "нет"}`;
    return sendMessage(chatId, text);
  }
  if (command === "/broadcast") {
    if (!isAdmin(userId)) return;
    const text = args.join(" ");
    if (!text) return sendMessage(chatId, "❌ <code>/broadcast ТЕКСТ</code>");
    
    const users = await getAllUsers();
    let sent = 0;
    for (const uid of users) {
      try {
        await sendMessage(uid, `📢 <b>Сообщение от админа:</b>\n\n${text}`);
        sent++;
        await new Promise(r => setTimeout(r, 50));
      } catch (e) {}
    }
    return sendMessage(chatId, `✅ Разослано ${sent}/${users.length}.`);
  }
  if (command === "/clearexpired") {
    if (!isAdmin(userId)) return;
    const deleted = await cleanExpiredFiles();
    return sendMessage(chatId, `🧹 Удалено истёкших файлов: ${deleted}.`);
  }
  
  return sendMessage(chatId, "❓ Неизвестная команда. /help");
}

// ============================================================================
// 17. CALLBACK QUERY
// ============================================================================

async function processCallback(callback) {
  const chatId = callback.message.chat.id;
  const userId = String(callback.from.id);
  const messageId = callback.message.message_id;
  const data = callback.data;
  const username = callback.from.username;
  
  await answerCallback(callback.id);
  await saveUser(userId, {}, username);
  
  if (data === "home") {
    return sendMainMenu(chatId, userId, username);
  }
  if (data === "help") return showHelp(chatId, isAdmin(userId));
  if (data === "profile") return showProfile(chatId, userId);
  if (data === "badges") return showBadges(chatId, userId);
  if (data === "referral") return showReferral(chatId, userId);
  if (data === "my_files") return showMyFiles(chatId, userId, 0);
  if (data === "top_files") return showTopFiles(chatId);
  if (data === "upload_help") {
    return editMessage(chatId, messageId,
      `📤 <b>Как загрузить файл</b>\n\n` +
      `Просто <b>отправь мне любой файл</b> прямо в чат:\n\n` +
      `• 📄 Документ\n` +
      `• 🖼️ Фото\n` +
      `• 🎬 Видео\n` +
      `• 🎵 Аудио\n` +
      `• 🎤 Голосовое\n` +
      `• 🎨 Стикер\n` +
      `• 🎞️ Гифка\n\n` +
      `Макс. размер: <b>${CONFIG.MAX_FILE_SIZE_MB} MB</b>\n\n` +
      `В ответ ты получишь короткий код для доступа к файлу.`,
      [[{ text: "⬅️ Назад", callback_data: "home" }]]
    );
  }
  if (data === "search_code") {
    return editMessage(chatId, messageId,
      `🔍 <b>Поиск по коду</b>\n\n` +
      `Отправь команду:\n<code>/get КОД</code>\n\n` +
      `Например: <code>/get AB12CD</code>`,
      [[{ text: "⬅️ Назад", callback_data: "home" }]]
    );
  }
  if (data.startsWith("get_file_")) {
    const code = data.replace("get_file_", "");
    return sendFileByCode(chatId, userId, code);
  }
  if (data.startsWith("my_files_")) {
    const page = parseInt(data.replace("my_files_", ""));
    return showMyFiles(chatId, userId, page);
  }
  if (data === "ignore") return;
  
  // Админ-коллбеки
  if (data === "admin_panel") return showAdminPanel(chatId, userId);
  if (data === "admin_stats") return showAdminStats(chatId, userId);
  if (data === "admin_logs") return showAdminLogs(chatId, userId);
  if (data === "admin_banned") return showAdminBanned(chatId, userId);
  if (data.startsWith("admin_users_")) {
    const page = parseInt(data.replace("admin_users_", ""));
    return showAdminUsers(chatId, userId, page);
  }
  if (data.startsWith("admin_unban_")) {
    if (!isAdmin(userId)) return;
    const uid = data.replace("admin_unban_", "");
    await unbanUser(uid);
    return showAdminBanned(chatId, userId);
  }
  if (data === "admin_broadcast_help") {
    return editMessage(chatId, messageId,
      `📢 <b>Рассылка</b>\n\n<code>/broadcast ТЕКСТ</code>`,
      [[{ text: "⬅️ Назад", callback_data: "admin_panel" }]]
    );
  }
  if (data === "admin_cleanup") {
    if (!isAdmin(userId)) return;
    const deleted = await cleanExpiredFiles();
    return editMessage(chatId, messageId, `🧹 Удалено: ${deleted}`, [[{ text: "⬅️ Назад", callback_data: "admin_panel" }]]);
  }
}

// ============================================================================
// 18. MAIN HANDLER
// ============================================================================

module.exports = async function handler(req, res) {
  // Health check
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "FileShare Bot",
      version: "1.0.0",
      maxFileSizeMB: CONFIG.MAX_FILE_SIZE_MB,
      maxFilesPerDay: CONFIG.MAX_FILES_PER_DAY,
      maxStorageMB: CONFIG.MAX_STORAGE_MB,
    });
  }
  
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  
  if (CONFIG.WEBHOOK_SECRET && req.headers["x-telegram-bot-api-secret-token"] !== CONFIG.WEBHOOK_SECRET) {
    return res.status(403).json({ ok: false, error: "Invalid secret" });
  }
  
  try {
    const update = req.body;
    
    // Callback
    if (update.callback_query) {
      await processCallback(update.callback_query);
    }
    // Message
    else if (update.message && update.message.chat.type === "private") {
      const message = update.message;
      
      // Файл?
      const fileInfo = extractFileInfo(message);
      if (fileInfo) {
        await handleFileUpload(message, fileInfo);
      }
      // Команда / текст?
      else if (message.text) {
        await processCommand(message, message.text);
      }
    }
    
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[CRITICAL ERROR]", error);
    return res.status(200).json({ ok: false, error: error.message });
  }
};

// ============================================================================
// ЭКСПОРТ
// ============================================================================

module.exports.CONFIG = CONFIG;
module.exports.BADGES = BADGES;
module.exports.FILE_TYPES = FILE_TYPES;
module.exports.EXPIRY_OPTIONS = EXPIRY_OPTIONS;
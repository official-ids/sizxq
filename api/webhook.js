const { Bot, InlineKeyboard, InputFile } = require("grammy");
const crypto = require("node:crypto");

const {
  getVersions,
  findVersion,
  isValidFileUrl,
} = require("../lib/api");

const {
  START_TEXT,
  HELP_TEXT,
  ABOUT_TEXT,
  VERSIONS_TEXT,
  ERROR_MESSAGES,
  escapeHtml,
} = require("../lib/messages");

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

let botInitPromise;

function ensureBotInitialized() {
  if (!botInitPromise) {
    botInitPromise = bot.init();
  }

  return botInitPromise;
}

const MAX_FILE_SIZE_BYTES =
  Number(process.env.MAX_FILE_SIZE_MB || 50) * 1024 * 1024;

const FILE_DOWNLOAD_TIMEOUT_MS = Number(
  process.env.FILE_DOWNLOAD_TIMEOUT_MS || 45_000
);

function versionKey(version) {
  return crypto
    .createHash("sha256")
    .update(String(version))
    .digest("hex")
    .slice(0, 16);
}

function buildMainKeyboard() {
  return new InlineKeyboard().text(
    "⬇️ Посмотреть версии",
    "show_versions"
  );
}

function buildVersionsKeyboard(versions) {
  const keyboard = new InlineKeyboard();

  versions.forEach((item, index) => {
    keyboard.text(
      `⬇️ Скачать ${item.version}`,
      `download:${versionKey(item.version)}`
    );

    // Две кнопки в одном ряду, затем перенос.
    if (index % 2 === 1) {
      keyboard.row();
    }
  });

  if (versions.length % 2 === 1) {
    keyboard.row();
  }

  keyboard.text("🔄 Обновить версии", "refresh_versions");

  return keyboard;
}

function getTelegramErrorMessage(error) {
  const message = String(error?.message || "").toLowerCase();

  if (
    message.includes("file is too big") ||
    message.includes("request entity too large") ||
    message.includes("413")
  ) {
    return ERROR_MESSAGES.FILE_TOO_LARGE;
  }

  return ERROR_MESSAGES.FILE_SEND_FAILED;
}

function isTimeoutError(error) {
  return (
    error?.name === "AbortError" ||
    String(error?.message || "").toLowerCase().includes("timeout")
  );
}

async function fetchFileBuffer(url) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, FILE_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "UnderCur-Telegram-Bot/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`File server returned HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get("content-length") || 0);

    if (contentLength > MAX_FILE_SIZE_BYTES) {
      const error = new Error("File is too large");
      error.code = "FILE_TOO_LARGE";
      throw error;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      const error = new Error("File is too large");
      error.code = "FILE_TOO_LARGE";
      throw error;
    }

    return buffer;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendGameFile(ctx, versionItem) {
  const version = versionItem.version;
  const fileUrl = versionItem.url;

  if (!isValidFileUrl(fileUrl)) {
    throw new Error("Invalid file URL");
  }

  const fileName = `UnderCur-${version}.ppsx`;

  // Сначала пробуем передать Telegram прямую ссылку.
  try {
    await ctx.replyWithDocument(new InputFile(fileUrl, fileName));
    return;
  } catch (directUrlError) {
    console.error("Telegram failed to fetch file by URL:", {
      message: directUrlError.message,
      version,
    });
  }

  // Если Telegram не смог скачать файл самостоятельно,
  // загружаем его через Vercel Function и передаём Buffer.
  try {
    const buffer = await fetchFileBuffer(fileUrl);

    await ctx.replyWithDocument(
      new InputFile(buffer, fileName)
    );
  } catch (bufferError) {
    if (bufferError.code === "FILE_TOO_LARGE") {
      throw bufferError;
    }

    if (isTimeoutError(bufferError)) {
      bufferError.code = "FILE_TIMEOUT";
    }

    console.error("Failed to download/send file:", {
      message: bufferError.message,
      version,
    });

    throw bufferError;
  }
}

async function showVersions(ctx, editExistingMessage = false) {
  try {
    const versions = await getVersions();

    if (!versions.length) {
      const message = ERROR_MESSAGES.EMPTY_VERSIONS;

      if (editExistingMessage) {
        await ctx.editMessageText(message);
      } else {
        await ctx.reply(message);
      }

      return;
    }

    const keyboard = buildVersionsKeyboard(versions);

    if (editExistingMessage) {
      await ctx.editMessageText(VERSIONS_TEXT, {
        reply_markup: keyboard,
        parse_mode: "HTML",
      });
    } else {
      await ctx.reply(VERSIONS_TEXT, {
        reply_markup: keyboard,
        parse_mode: "HTML",
      });
    }
  } catch (error) {
    console.error("Failed to get versions:", {
      message: error.message,
      stack: error.stack,
    });

    const message = isTimeoutError(error)
      ? ERROR_MESSAGES.API_TIMEOUT
      : ERROR_MESSAGES.API_UNAVAILABLE;

    if (editExistingMessage) {
      await ctx.editMessageText(message);
    } else {
      await ctx.reply(message);
    }
  }
}

bot.command("start", async (ctx) => {
  await ctx.reply(START_TEXT, {
    reply_markup: buildMainKeyboard(),
    parse_mode: "HTML",
  });
});

bot.command("help", async (ctx) => {
  await ctx.reply(HELP_TEXT, {
    parse_mode: "HTML",
  });
});

bot.command("about", async (ctx) => {
  await ctx.reply(ABOUT_TEXT, {
    parse_mode: "HTML",
  });
});

bot.command("game_versions", async (ctx) => {
  await showVersions(ctx);
});

bot.callbackQuery("show_versions", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showVersions(ctx);
});

bot.callbackQuery("refresh_versions", async (ctx) => {
  await ctx.answerCallbackQuery({
    text: "Обновляю список версий…",
  });

  await showVersions(ctx, true);
});

bot.callbackQuery(/^download:([a-f0-9]{16})$/, async (ctx) => {
  await ctx.answerCallbackQuery({
    text: "Проверяю версию…",
  });

  const selectedKey = ctx.match[1];

  try {
    // Список запрашивается заново, поэтому старая callback-кнопка
    // не использует устаревшую ссылку.
    const versions = await getVersions();

    const selected = versions.find(
      (item) => versionKey(item.version) === selectedKey
    );

    if (!selected) {
      await ctx.reply(ERROR_MESSAGES.VERSION_NOT_FOUND);
      return;
    }

    if (!isValidFileUrl(selected.url)) {
      console.error("Invalid file URL received from API:", {
        version: selected.version,
      });

      await ctx.reply(ERROR_MESSAGES.INVALID_FILE_URL);
      return;
    }

    try {
      await sendGameFile(ctx, selected);

      await ctx.reply(
        `Держи свою версию ${escapeHtml(selected.version)}, скачивай и запускай!`,
        {
          parse_mode: "HTML",
        }
      );
    } catch (error) {
      if (error.code === "FILE_TOO_LARGE") {
        await ctx.reply(ERROR_MESSAGES.FILE_TOO_LARGE);
      } else if (error.code === "FILE_TIMEOUT") {
        await ctx.reply(ERROR_MESSAGES.FILE_TIMEOUT);
      } else {
        await ctx.reply(getTelegramErrorMessage(error));
      }
    }
  } catch (error) {
    console.error("Failed to process selected version:", {
      message: error.message,
      stack: error.stack,
    });

    if (isTimeoutError(error)) {
      await ctx.reply(ERROR_MESSAGES.API_TIMEOUT);
    } else {
      await ctx.reply(ERROR_MESSAGES.API_UNAVAILABLE);
    }
  }
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();

  if (text.startsWith("/")) {
    await ctx.reply(
      "Неизвестная команда. Используй /help, чтобы посмотреть доступные команды."
    );
  } else {
    await ctx.reply(
      "Используй /game_versions, чтобы посмотреть доступные версии игры."
    );
  }
});

bot.catch((error) => {
  console.error("Unhandled bot error:", {
    message: error.error?.message || error.message,
    stack: error.error?.stack || error.stack,
  });
});

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
    return;
  }

  const expectedSecret = process.env.WEBHOOK_SECRET;
  const receivedSecret = req.headers["x-telegram-bot-api-secret-token"];

  if (
    expectedSecret &&
    receivedSecret !== expectedSecret
  ) {
    res.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
    return;
  }

  try {
    await ensureBotInitialized();
    await bot.handleUpdate(req.body);


    res.status(200).json({
      ok: true,
    });
  } catch (error) {
    console.error("Webhook handler error:", {
      message: error.message,
      stack: error.stack,
    });

    // Telegram должен получить HTTP 200, если update уже был принят.
    // Иначе Telegram может бесконечно повторять один и тот же update.
    res.status(200).json({
      ok: false,
    });
  }
};

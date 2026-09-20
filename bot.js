const { Telegraf } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = 8264692426;
const START_BALANCE = 100;
const BONUS_MIN = 50;
const BONUS_MAX = 500;
const BONUS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MINES_SIZE = 5;
const MINES_COUNT = 5;
const MINES_CELL_REWARD = 0.2;
const CRASH_COEFF_STEP = 0.2;
const ROCKET_FRAMES = [
  '🚀',
  '   🚀',
  '      🚀',
  '         🚀',
  '            🚀',
  '               🚀',
  '                  🚀',
  '                     🚀',
  '                        🚀',
  '                           🚀',
  '                              🚀',
  '                               🚀',
];

if (!BOT_TOKEN) {
  console.error('Укажите токен бота через переменную окружения BOT_TOKEN');
  process.exit(1);
}

const db = new sqlite3.Database(path.join(__dirname, 'casino.db'));

db.run(
  'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, balance INTEGER DEFAULT 100, last_bonus INTEGER DEFAULT 0)',
  (err) => {
    if (err) {
      console.error('Ошибка создания таблицы users:', err.message);
      process.exit(1);
    }
  }
);

function isAdmin(userId) {
  return userId === ADMIN_ID;
}

function dbGet(sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function dbRun(sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function getUser(userId) {
  let user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) {
    await dbRun('INSERT INTO users (id, balance, last_bonus) VALUES (?, ?, ?)', [userId, START_BALANCE, 0]);
    user = { id: userId, balance: START_BALANCE, last_bonus: 0 };
  }
  return user;
}

async function changeBalance(userId, delta) {
  return dbRun('UPDATE users SET balance = MAX(0, balance + ?) WHERE id = ?', [delta, userId]);
}

async function setBalance(userId, amount) {
  return dbRun('UPDATE users SET balance = ? WHERE id = ?', [amount, userId]);
}

async function setLastBonus(userId, timestamp) {
  return dbRun('UPDATE users SET last_bonus = ? WHERE id = ?', [timestamp, userId]);
}

const minesGames = new Map();
let minesGameCounter = 0;

function buildMinesField() {
  const size = MINES_SIZE * MINES_SIZE;
  const field = new Array(size).fill(0);
  const mines = new Set();
  while (mines.size < MINES_COUNT) {
    mines.add(Math.floor(Math.random() * size));
  }
  for (const position of mines) {
    field[position] = 1;
  }
  return field;
}

function openedCellsCount(game) {
  return game.opened.reduce((sum, isOpen) => sum + (isOpen ? 1 : 0), 0);
}

function minesWinnings(game) {
  return Math.round(game.bet * (1 + MINES_CELL_REWARD * openedCellsCount(game)));
}

function buildMinesKeyboard(game) {
  const rows = [];
  for (let rowIndex = 0; rowIndex < MINES_SIZE; rowIndex++) {
    const row = [];
    for (let columnIndex = 0; columnIndex < MINES_SIZE; columnIndex++) {
      const index = rowIndex * MINES_SIZE + columnIndex;
      if (game.opened[index]) {
        row.push({ text: '💎', callback_data: 'noop' });
      } else {
        row.push({ text: '🔹', callback_data: 'mines:' + game.id + ':' + index });
      }
    }
    rows.push(row);
  }
  rows.push([{ text: '💰 Забрать куш', callback_data: 'mines:' + game.id + ':cashout' }]);
  return rows;
}

function buildMinesRevealKeyboard(game) {
  const rows = [];
  for (let rowIndex = 0; rowIndex < MINES_SIZE; rowIndex++) {
    const row = [];
    for (let columnIndex = 0; columnIndex < MINES_SIZE; columnIndex++) {
      const index = rowIndex * MINES_SIZE + columnIndex;
      const icon = game.field[index] === 1 ? '💣' : '💎';
      row.push({ text: icon, callback_data: 'noop' });
    }
    rows.push(row);
  }
  return rows;
}

function minesGameText(game) {
  const win = minesWinnings(game);
  return (
    '🎮 ИГРА: МИНЫ\n\n' +
    'Ставка: ' + game.bet + ' ₽\n' +
    'Открыто клеток: ' + openedCellsCount(game) + '\n' +
    '💎 Выигрыш (куш): ' + win + ' ₽\n\n' +
    'Тыкай по клеткам 🔹, избегай 💣!'
  );
}

const crashGames = new Map();
let crashGameCounter = 0;

function formatMultiplier(multiplierCents) {
  return (multiplierCents / 100).toFixed(2) + 'x';
}

function crashFrame(game) {
  const step = Math.floor((game.multiplier - 100) / 20);
  const safeStep = Math.max(0, step);
  return ROCKET_FRAMES[safeStep % ROCKET_FRAMES.length];
}

function crashCashoutAmount(game) {
  return Math.round(game.bet * (game.multiplier / 100));
}

function crashGameText(game) {
  return (
    '🚀 РАКЕТА ВЗЛЕТАЕТ!\n\n' +
    crashFrame(game) + '\n\n' +
    'Коэффициент: ' + formatMultiplier(game.multiplier) + '\n' +
    'Ставка: ' + game.bet + ' ₽\n' +
    '💰 Возможный куш: ' + crashCashoutAmount(game) + ' ₽\n\n' +
    'Тыкни кнопку, чтобы забрать куш!'
  );
}

function crashKeyboard(game) {
  if (!game.active) {
    return { inline_keyboard: [] };
  }
  return {
    inline_keyboard: [
      [
        {
          text: '💰 Забрать куш (' + formatMultiplier(game.multiplier) + ')',
          callback_data: 'crash:' + game.id + ':cashout',
        },
      ],
    ],
  };
}

async function tickCrashGame(crashId) {
  const game = crashGames.get(crashId);
  if (!game || !game.active) {
    return;
  }
  game.multiplier += Math.round(CRASH_COEFF_STEP * 100);
  if (game.multiplier >= game.explosion) {
    game.active = false;
    clearInterval(game.timer);
    crashGames.delete(crashId);
    if (!isAdmin(game.userId)) {
      await changeBalance(game.userId, -game.bet);
    }
    const adminNote = isAdmin(game.userId) ? '\n(👑 Админ: рубли не списаны)' : '';
    const text =
      '💥 РАКЕТКА ВЗОРВАЛАСЬ!\n' +
      'Вы проиграли. Ракета долетела до ' + formatMultiplier(game.explosion) + '\n\n' +
      'Ставка ' + game.bet + ' ₽ сгорела.' + adminNote;
    await bot.telegram
      .editMessageText(game.chatId, game.messageId, null, text, { reply_markup: crashKeyboard(game) })
      .catch(() => {});
  } else {
    const text = crashGameText(game);
    await bot.telegram
      .editMessageText(game.chatId, game.messageId, null, text, { reply_markup: crashKeyboard(game) })
      .catch(() => {});
  }
}

let botAgent;
const proxyUrl = process.env.PROXY;
if (proxyUrl) {
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    botAgent = new HttpsProxyAgent(proxyUrl);
    console.log('Используется прокси: ' + proxyUrl);
  } catch (proxyError) {
    console.error('Не удалось инициализировать прокси:', proxyError.message);
  }
}

const bot = new Telegraf(BOT_TOKEN, botAgent ? { telegram: { agent: botAgent } } : undefined);

bot.hears(/^мины($|\s)/i, async (ctx) => {
  try {
    const user = await getUser(ctx.from.id);
    const bet = parseInt((ctx.message.text.match(/\d+/) || ['0'])[0], 10);
    if (!Number.isInteger(bet) || bet <= 0) {
      await ctx.reply('🎮 Пример команды: `мины 100`');
      return;
    }
    if (!isAdmin(ctx.from.id) && user.balance < bet) {
      await ctx.reply('❌ Недостаточно рублей. Баланс: ' + user.balance + ' ₽');
      return;
    }
    const mineId = ++minesGameCounter;
    const game = {
      id: mineId,
      chatId: ctx.chat.id,
      messageId: null,
      userId: ctx.from.id,
      bet: bet,
      field: buildMinesField(),
      opened: new Array(MINES_SIZE * MINES_SIZE).fill(false),
    };
    minesGames.set(mineId, game);
    const sentMessage = await ctx.reply(minesGameText(game), {
      reply_markup: { inline_keyboard: buildMinesKeyboard(game) },
    });
    game.messageId = sentMessage.message_id;
  } catch (error) {
    console.error('Ошибка в игре MINES:', error);
    await ctx.reply('⚠️ Произошла ошибка при запуске игры. Попробуйте ещё раз.').catch(() => {});
  }
});

bot.action(/^mines:(\d+):(\d+)$/, async (ctx) => {
  try {
    const mineId = parseInt(ctx.match[1], 10);
    const index = parseInt(ctx.match[2], 10);
    const game = minesGames.get(mineId);
    if (!game) {
      await ctx.answerCbQuery('⏳ Игра уже завершена.').catch(() => {});
      return;
    }
    if (ctx.from.id !== game.userId) {
      await ctx.answerCbQuery('❌ Это не ваша игра!').catch(() => {});
      return;
    }
    if (game.opened[index]) {
      await ctx.answerCbQuery('Эта клетка уже открыта.').catch(() => {});
      return;
    }
    game.opened[index] = true;
    if (game.field[index] === 1) {
      minesGames.delete(mineId);
      if (!isAdmin(game.userId)) {
        await changeBalance(game.userId, -game.bet);
      }
      const adminNote = isAdmin(game.userId) ? '\n(👑 Админ: рубли не списаны)' : '';
      const text =
        '💥 БУМ! Ты наступил на мину!\n\n' +
        'Ставка ' + game.bet + ' ₽ сгорела.' + adminNote + '\n\n' +
        'Ты проиграл! 💥';
      await bot.telegram
        .editMessageText(game.chatId, game.messageId, null, text, {
          reply_markup: { inline_keyboard: buildMinesRevealKeyboard(game) },
        })
        .catch(() => {});
      await ctx.answerCbQuery('💥 Ты проиграл!').catch(() => {});
    } else {
      const text = minesGameText(game);
      await bot.telegram
        .editMessageText(game.chatId, game.messageId, null, text, {
          reply_markup: { inline_keyboard: buildMinesKeyboard(game) },
        })
        .catch(() => {});
      await ctx.answerCbQuery('💎 Удачно! Куш растёт.').catch(() => {});
    }
  } catch (error) {
    console.error('Ошибка в клике MINES:', error);
    await ctx.answerCbQuery('⚠️ Произошла ошибка.').catch(() => {});
  }
});

bot.action(/^mines:(\d+):cashout$/, async (ctx) => {
  try {
    const mineId = parseInt(ctx.match[1], 10);
    const game = minesGames.get(mineId);
    if (!game) {
      await ctx.answerCbQuery('⏳ Игра уже завершена.').catch(() => {});
      return;
    }
    if (ctx.from.id !== game.userId) {
      await ctx.answerCbQuery('❌ Это не ваша игра!').catch(() => {});
      return;
    }
    minesGames.delete(mineId);
    const win = minesWinnings(game);
    await changeBalance(game.userId, win);
    const text =
      '💰 КУШ ЗАБРАН!\n\n' +
      'Открыто клеток: ' + openedCellsCount(game) + '\n' +
      'Выигрыш: +' + win + ' ₽';
    await bot.telegram
      .editMessageText(game.chatId, game.messageId, null, text, {
        reply_markup: { inline_keyboard: buildMinesRevealKeyboard(game) },
      })
      .catch(() => {});
    await ctx.answerCbQuery('💰 Вы забрали куш: +' + win + ' ₽').catch(() => {});
  } catch (error) {
    console.error('Ошибка в cashout MINES:', error);
    await ctx.answerCbQuery('⚠️ Произошла ошибка.').catch(() => {});
  }
});

bot.hears(/^краш($|\s)/i, async (ctx) => {
  try {
    const user = await getUser(ctx.from.id);
    const bet = parseInt((ctx.message.text.match(/\d+/) || ['0'])[0], 10);
    if (!Number.isInteger(bet) || bet <= 0) {
      await ctx.reply('🎮 Пример команды: `краш 100`');
      return;
    }
    if (!isAdmin(ctx.from.id) && user.balance < bet) {
      await ctx.reply('❌ Недостаточно рублей. Баланс: ' + user.balance + ' ₽');
      return;
    }
    const crashId = ++crashGameCounter;
    const game = {
      id: crashId,
      chatId: ctx.chat.id,
      messageId: null,
      userId: ctx.from.id,
      bet: bet,
      multiplier: 100,
      explosion: 100 + Math.floor(Math.random() * 21) * 20,
      active: true,
      timer: null,
    };
    crashGames.set(crashId, game);
    const sentMessage = await ctx.reply(crashGameText(game), { reply_markup: crashKeyboard(game) });
    game.messageId = sentMessage.message_id;
    game.timer = setInterval(() => tickCrashGame(crashId), 1000);
  } catch (error) {
    console.error('Ошибка в игре CRASH:', error);
    await ctx.reply('⚠️ Произошла ошибка при запуске игры. Попробуйте ещё раз.').catch(() => {});
  }
});

bot.action(/^crash:(\d+):cashout$/, async (ctx) => {
  try {
    const crashId = parseInt(ctx.match[1], 10);
    const game = crashGames.get(crashId);
    if (!game || !game.active) {
      await ctx.answerCbQuery('⏳ Игра уже завершена.').catch(() => {});
      return;
    }
    if (ctx.from.id !== game.userId) {
      await ctx.answerCbQuery('❌ Это не ваша игра!').catch(() => {});
      return;
    }
    game.active = false;
    clearInterval(game.timer);
    crashGames.delete(crashId);
    const win = crashCashoutAmount(game);
    await changeBalance(game.userId, win);
    const text =
      '🏆 КУШ ЗАБРАН!\n\n' +
      'Коэффициент: ' + formatMultiplier(game.multiplier) + '\n' +
      'Выигрыш: +' + win + ' ₽\n\n' +
      'Ракета продолжила полёт в космос… 🚀';
    await bot.telegram
      .editMessageText(game.chatId, game.messageId, null, text, { reply_markup: crashKeyboard(game) })
      .catch(() => {});
    await ctx.answerCbQuery('💰 Вы забрали куш: +' + win + ' ₽').catch(() => {});
  } catch (error) {
    console.error('Ошибка в cashout CRASH:', error);
    await ctx.answerCbQuery('⚠️ Произошла ошибка.').catch(() => {});
  }
});

bot.action('noop', async (ctx) => {
  await ctx.answerCbQuery('🎮 Игра завершена. Сыграй ещё: мины [ставка] или краш [ставка]').catch(() => {});
});

bot.hears(/^(баланс|кошелёк|кошелек|\/баланс)($|\s)/i, async (ctx) => {
  try {
    const user = await getUser(ctx.from.id);
    if (isAdmin(user.id)) {
      await ctx.reply('💰 Баланс: 🔥 Бесконечно (👑 Админ)');
      return;
    }
    await ctx.reply('💰 Баланс: ' + user.balance + ' ₽');
  } catch (error) {
    console.error('Ошибка в балансе:', error);
    await ctx.reply('⚠️ Произошла ошибка.').catch(() => {});
  }
});

bot.hears(/^(бонус|bonus|\/бонус)($|\s)/i, async (ctx) => {
  try {
    const user = await getUser(ctx.from.id);
    const now = Date.now();
    if (!isAdmin(user.id) && now - user.last_bonus < BONUS_COOLDOWN_MS) {
      const remainingMs = BONUS_COOLDOWN_MS - (now - user.last_bonus);
      const hours = Math.floor(remainingMs / 3600000);
      const minutes = Math.floor((remainingMs % 3600000) / 60000);
      await ctx.reply('⏳ Бонус можно брать раз в 24 часа!\nОсталось: ' + hours + ' ч ' + minutes + ' мин.');
      return;
    }
    const amount = Math.floor(Math.random() * (BONUS_MAX - BONUS_MIN + 1)) + BONUS_MIN;
    await changeBalance(user.id, amount);
    await setLastBonus(user.id, now);
    await ctx.reply('🎁 Бонус получен: +' + amount + ' ₽');
  } catch (error) {
    console.error('Ошибка в бонусе:', error);
    await ctx.reply('⚠️ Произошла ошибка.').catch(() => {});
  }
});

bot.hears(/^(перевод|перевести)($|\s)/i, async (ctx) => {
  try {
    const replyMessage = ctx.message.reply_to_message;
    if (!replyMessage || !replyMessage.from) {
      await ctx.reply(
        'ℹ️ Чтобы перевести рубли, ответь этой командой на сообщение получателя.\n\n' +
          'Пример: `перевод 100`'
      );
      return;
    }
    const amount = parseInt((ctx.message.text.match(/\d+/) || ['0'])[0], 10);
    if (!Number.isInteger(amount) || amount <= 0) {
      await ctx.reply('❌ Укажите сумму больше нуля. Пример: `перевод 100`');
      return;
    }
    const senderId = ctx.from.id;
    const receiverId = replyMessage.from.id;
    if (senderId === receiverId) {
      await ctx.reply('❌ Нельзя переводить рубли самому себе!');
      return;
    }
    await getUser(senderId);
    await getUser(receiverId);
    if (!isAdmin(senderId)) {
      const sender = await getUser(senderId);
      if (sender.balance < amount) {
        await ctx.reply('❌ Недостаточно рублей. Твой баланс: ' + sender.balance + ' ₽');
        return;
      }
      await changeBalance(senderId, -amount);
    }
    await changeBalance(receiverId, amount);
    const receiverName = replyMessage.from.first_name ? replyMessage.from.first_name : ('игрок ' + receiverId);
    const adminNote = isAdmin(senderId) ? '\n(👑 Админ: рубли с его счёта не списаны)' : '';
    await ctx.reply(
      '✅ Перевод выполнен!\n\n' +
        '💸 ' + receiverName + ' получил: ' + amount + ' ₽' + adminNote
    );
  } catch (error) {
    console.error('Ошибка в переводе:', error);
    await ctx.reply('⚠️ Произошла ошибка при переводе.').catch(() => {});
  }
});

bot.hears(/^\/setbal\s+(\d+)/i, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return;
  }
  try {
    const amount = parseInt(ctx.match[1], 10);
    const replyMessage = ctx.message.reply_to_message;
    if (replyMessage && replyMessage.from) {
      await getUser(replyMessage.from.id);
      await setBalance(replyMessage.from.id, amount);
      const targetName = replyMessage.from.first_name ? replyMessage.from.first_name : ('игрок ' + replyMessage.from.id);
      await ctx.reply('👑 Баланс игрока ' + targetName + ' установлен: ' + amount + ' ₽');
    } else {
      await getUser(ADMIN_ID);
      await setBalance(ADMIN_ID, amount);
      await ctx.reply('👑 Твой баланс установлен: ' + amount + ' ₽');
    }
  } catch (error) {
    console.error('Ошибка в /setbal:', error);
    await ctx.reply('⚠️ Произошла ошибка.').catch(() => {});
  }
});

bot.catch((error, ctx) => {
  console.error('Глобальная ошибка бота:', error && error.message);
});

function shutdown(signal) {
  console.log('Бот остановлен (' + signal + ')');
  bot.stop(signal);
  db.close();
}

async function main() {
  const me = await bot.telegram.getMe();
  const username = me && me.username ? ('@' + me.username) : '';
  console.log('Бот ' + username + ' подключен к Telegram, запускаю прослушку сообщений...');
  try {
    await bot.telegram.sendMessage(
      ADMIN_ID,
      '🚀 Казино-бот ' + username + '\nУспешно запущен! Напиши мне: баланс'
    );
  } catch (notifyError) {
    console.error('Не удалось отправить приветствие админу:', notifyError.message);
  }
  await bot.launch();
}

main().catch((error) => {
  console.error('Ошибка запуска бота:', error.message);
  process.exit(1);
});

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
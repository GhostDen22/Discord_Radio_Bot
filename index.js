// index.js
require('dotenv').config();

const {
  Client, GatewayIntentBits,
  EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder,
} = require('discord.js');

const {
  joinVoiceChannel, createAudioPlayer, createAudioResource, getVoiceConnection,
  AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType,
  generateDependencyReport,
} = require('@discordjs/voice');

const { spawn } = require('child_process');
const ffmpeg = require('ffmpeg-static');

// ─────────────────────────────────────────────────────────
// БАЗОВЫЕ ПРОВЕРКИ
// ─────────────────────────────────────────────────────────
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Нет DISCORD_TOKEN в .env');
  process.exit(1);
}

console.log('🧩 Voice deps report:\n' + generateDependencyReport());
console.log('🎬 FFmpeg path:', ffmpeg);

// ─────────────────────────────────────────────────────────
// КАТАЛОГ СТАНЦИЙ (можешь смело редактировать/добавлять)
// value = прямой URL потока
// ─────────────────────────────────────────────────────────
const STATIONS = [
  { label: 'Radio R', desc: 'Литва', value: 'https://stream1.relaxfm.lt/rrb128.mp3', emoji: '📻' },
  { label: 'Авторадио (Мск)', desc: 'HLS',   value: 'https://hls-01-gpm.hostingradio.ru/avtoradio495/playlist.m3u8', emoji: '🚗' },
  { label: 'Ретро FM (Мск)',  desc: 'MP3',   value: 'http://emgregion.hostingradio.ru:8064/moscow.retrofm.mp3', emoji: '🕰️' },
];

// Хранилище на время жизни процесса (динамически добавленные станции)
const customStations = []; // {label, desc, value, emoji?}

// Управление по серверам: соединение/плеер/процесс ffmpeg
const sessions = new Map(); // guildId -> {conn, player, proc, url, retry}

// ─────────────────────────────────────────────────────────
// FFmpeg (поддерживает m3u8/mp3/aac) + заголовки
// ─────────────────────────────────────────────────────────
function makeFfmpeg(url) {
  const headers =
    'User-Agent: Mozilla/5.0 (DiscordRadioBot)\r\n' +
    'Referer: https://radior.lt/online/\r\n' +
    'Origin: https://radior.lt\r\n';

  const args = [
    '-hide_banner',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-rw_timeout', '10000000',
    '-headers', headers,
    '-i', url,
    '-fflags', '+genpts+discardcorrupt',
    '-vn',
    '-acodec', 'pcm_s16le',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ];

  const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  proc.stderr.on('data', (b) => {
    const s = b.toString();
    if (/error|invalid|fail|timeout|403|404|denied|not found/i.test(s)) {
      console.error('ffmpeg:', s.trim());
    }
  });

  proc.on('close', (code) => console.warn('ffmpeg exited with code', code));
  return proc;
}

// ─────────────────────────────────────────────────────────
// Запуск/перезапуск потока
// ─────────────────────────────────────────────────────────
async function playOnGuild(messageOrInteraction, url) {
  const guild = messageOrInteraction.guild;
  const member = messageOrInteraction.member;

  const ch = member?.voice?.channel;
  if (!ch) {
    const reply = '🎤 Сначала зайди в голосовой канал.';
    if ('reply' in messageOrInteraction) return messageOrInteraction.reply(reply);
    return messageOrInteraction.followUp(reply);
  }

  // Получаем/создаём сессию
  let s = sessions.get(guild.id);
  if (!s) {
    const conn = joinVoiceChannel({
      channelId: ch.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      // daveEncryption: false, // если нет @snazzah/davey и вылезает ошибка — временно раскомментируй
    });

    const player = createAudioPlayer();

    // Автовосстановление голосового соединения
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      console.warn('⚠️ Voice disconnected, trying to reconnect...');
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        console.log('🔄 Voice reconnected');
      } catch {
        conn.destroy();
        sessions.delete(guild.id);
      }
    });

    conn.subscribe(player);
    s = { conn, player, proc: null, url: null, retry: 0 };
    sessions.set(guild.id, s);

    player.on('stateChange', (o, n) => {
      console.log(`🔁 Player: ${o.status} -> ${n.status}`);
    });

    // Автоперезапуск при обрыве
    player.on(AudioPlayerStatus.Idle, () => {
      if (!s.url) return;
      if (s.retry >= 5) return; // ограничим циклы
      s.retry++;
      console.warn(`🔁 Поток оборвался. Перезапуск #${s.retry}...`);
      startFfmpegIntoPlayer(s, s.url);
    });

    player.on('error', (err) => {
      console.error('Audio player error:', err);
      killProc(s.proc);
    });
  }

  s.retry = 0;
  s.url = url;
  await entersState(s.conn, VoiceConnectionStatus.Ready, 15_000);
  console.log('🎧 Voice ready');

  startFfmpegIntoPlayer(s, url);

  const text = `📻 Играет: ${url}`;
  if ('reply' in messageOrInteraction) {
    if (messageOrInteraction.deferred || messageOrInteraction.replied) {
      await messageOrInteraction.followUp(text);
    } else {
      await messageOrInteraction.reply(text);
    }
  } else {
    await messageOrInteraction.channel.send(text);
  }
}

function startFfmpegIntoPlayer(session, url) {
  killProc(session.proc);
  const proc = makeFfmpeg(url);
  session.proc = proc;
  const resource = createAudioResource(proc.stdout, { inputType: StreamType.Raw });
  session.player?.play(resource);
}

function killProc(proc) {
  if (!proc) return;
  try { proc.kill('SIGKILL'); } catch {}
}

// ─────────────────────────────────────────────────────────
// UI: Выпадающее меню станций
// ─────────────────────────────────────────────────────────
async function sendStationsMenu(channel) {
  // максимум 25 опций в одном меню
  const options = [...STATIONS, ...customStations].slice(0, 25).map(s => ({
    label: s.label, description: s.desc?.slice(0, 50) || 'Радио',
    value: s.value, emoji: s.emoji || '🎵',
  }));

  const embed = new EmbedBuilder()
    .setTitle('🎚️ Выберите радиостанцию')
    .setDescription('Выбери из списка — бот подключится и начнёт играть.')
    .setColor(0x2b2d31);

  const menu = new StringSelectMenuBuilder()
    .setCustomId('radio_select')
    .setPlaceholder('📻 Выберите станцию')
    .addOptions(options);

  const row = new ActionRowBuilder().addComponents(menu);

  await channel.send({ embeds: [embed], components: [row] });
}

// ─────────────────────────────────────────────────────────
// DISCORD CLIENT
// ─────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(`✅ Запущен как ${client.user.tag}`);
  console.log('Команды: !play <url|name>, !stations, !add "<name>" <url>, !list, !stop');
});

// Сообщения-команды
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  const text = message.content.trim();
  const [cmd, ...rest] = text.split(/\s+/);
  // !help
  if (cmd === '!help') {
      return message.channel.send('Команды: !play <url|name>, !stations, !add "<name>" <url>, !list, !stop');
  }

  // !play <url|name>
  if (cmd === '!play') {
    const arg = rest.join(' ').trim();
    if (!arg) return message.reply('Использование: `!play <url|имя_станции>`');

    const fromList = [...STATIONS, ...customStations].find(s =>
      s.label.toLowerCase() === arg.toLowerCase()
    );
    const url = fromList ? fromList.value : arg;

    return playOnGuild(message, url);
  }

  // !stations — показать меню
  if (cmd === '!stations') {
    return sendStationsMenu(message.channel);
  }

  // !add "<name>" <url> — добавить свою станцию на время работы бота
  if (cmd === '!add') {
    const m = text.match(/^!add\s+"([^"]+)"\s+(\S+)/);
    if (!m) {
      return message.reply('Использование: `!add "Название станции" <url>`');
    }
    const [, label, url] = m;
    customStations.unshift({ label, desc: 'Пользовательская станция', value: url, emoji: '⭐' });
    return message.reply(`✅ Добавил в список: **${label}** → ${url}`);
  }

  // !list — вывести список имён, чтобы потом было удобно !play <name>
  if (cmd === '!list') {
    const lines = [...STATIONS, ...customStations].map(s => `• **${s.label}** — ${s.value}`);
    return message.reply(lines.join('\n').slice(0, 1900));
  }

  // !stop — остановить и выйти
  if (cmd === '!stop') {
    const s = sessions.get(message.guild.id);
    if (s) {
      killProc(s.proc);
      s.conn.destroy();
      sessions.delete(message.guild.id);
      return message.channel.send('🛑 Остановлено.');
    }
    return message.channel.send('ℹ️ Бот не в голосовом.');
  }
});

// Обработка выбора из меню
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId !== 'radio_select') return;

  const url = interaction.values[0];
  await interaction.deferReply({ ephemeral: false });
  return playOnGuild(interaction, url);
});

// ─────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN).catch(e => console.error('❌ Ошибка входа:', e));

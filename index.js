// index.js
require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  entersState,
  StreamType,
  generateDependencyReport,
} = require('@discordjs/voice');

const { spawn, spawnSync } = require('child_process');

// 1) сначала системный ffmpeg, если он есть;
// 2) затем @ffmpeg-installer/ffmpeg;
// 3) затем ffmpeg-static.
function resolveFfmpegBin() {
  const tryBin = (bin) => {
    try {
      const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
      return r.status === 0;
    } catch { return false; }
  };

  const wanted = process.env.FFMPEG_BIN || 'ffmpeg';
  if (tryBin(wanted)) return wanted;

  try {
    const inst = require('@ffmpeg-installer/ffmpeg');
    if (inst?.path && tryBin(inst.path)) return inst.path;
  } catch {}

  try {
    const staticPath = require('ffmpeg-static');
    if (staticPath && tryBin(staticPath)) return staticPath;
  } catch {}

  throw new Error('FFmpeg binary not available');
}

const ffmpegBin = resolveFfmpegBin();
console.log('🎬 FFmpeg bin:', ffmpegBin);

// ---- sanity
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Нет DISCORD_TOKEN в .env');
  process.exit(1);
}

console.log('🧩 Voice deps report:\n' + generateDependencyReport());
console.log('🎬 FFmpeg bin:', ffmpegBin);

// ---- stations
const STATIONS = [
  { label: 'Radio R', desc: 'Литва', value: 'https://stream1.relaxfm.lt/rrb128.mp3', emoji: '📻' },
  { label: 'Авторадио (Мск)', desc: 'HLS', value: 'https://hls-01-gpm.hostingradio.ru/avtoradio495/playlist.m3u8', emoji: '🚗' },
  { label: 'Ретро FM (Мск)',  desc: 'MP3', value: 'http://emgregion.hostingradio.ru:8064/moscow.retrofm.mp3', emoji: '🕰️' },
];

const customStations = [];
const sessions = new Map(); // guildId -> {conn, player, proc, url, retry}

// ---- FFmpeg pipeline: input -> Ogg/Opus (ready for Discord)
function makeFfmpeg(url) {
  const headers =
    'User-Agent: Winamp/5.09\r\n' +
    'Icy-MetaData: 1\r\n' +
    'Origin: https://discordapp.com\r\n' +
    'Referer: https://discordapp.com/\r\n';

  const isHls = /\.m3u8(\?|$)/i.test(url);

  const args = [
    '-hide_banner',
    // reconnects
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '10',
    '-rw_timeout', '15000000',
    // headers
    '-headers', headers,
    // probing
    '-nostdin',
    '-loglevel', 'warning',
    '-analyzeduration', '2000000',
    '-probesize', '256k',
    // input
    ...(isHls ? ['-protocol_whitelist', 'file,crypto,tcp,http,https,tls'] : []),
    '-i', url,
    // robustness
    '-fflags', '+genpts+discardcorrupt',
    '-vn',
    // OUTPUT: Ogg/Opus (Discord-friendly)
    '-c:a', 'libopus',
    '-b:a', '128k',
    '-frame_duration', '60',
    '-application', 'audio',
    '-f', 'ogg',
    'pipe:1',
  ];

  const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', b => {
    const s = b.toString();
    if (/error|invalid|fail|timeout|403|404|denied|not found/i.test(s)) {
      console.warn('ffmpeg:', s.trim());
    }
  });
  proc.on('error', e => console.error('ffmpeg spawn error:', e));
  proc.on('close', (code, sig) => console.warn(`ffmpeg closed: code=${code} sig=${sig || ''}`));
  return proc;
}

// ---- play/restart
async function playOnGuild(messageOrInteraction, url) {
  const guild = messageOrInteraction.guild;
  const member = messageOrInteraction.member;

  const ch = member?.voice?.channel;
  if (!ch) {
    const reply = '🎤 Сначала зайди в голосовой канал.';
    if ('reply' in messageOrInteraction) return messageOrInteraction.reply(reply);
    return messageOrInteraction.followUp(reply);
  }

  let s = sessions.get(guild.id);
  if (!s) {
    const conn = joinVoiceChannel({
      channelId: ch.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      // daveEncryption: false, // если помешает DAVE, раскомментируй
    });

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      console.warn('⚠️ Voice disconnected, trying to reconnect...');
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        console.log('🔄 Voice reconnected');
      } catch {
        try { conn.destroy(); } catch {}
        sessions.delete(guild.id);
      }
    });

    conn.subscribe(player);
    s = { conn, player, proc: null, url: null, retry: 0 };
    sessions.set(guild.id, s);

    player.on('stateChange', (o, n) => {
      console.log(`🎧 Player: ${o.status} -> ${n.status}`);
      if (n.status === AudioPlayerStatus.Playing) s.retry = 0;
    });

    player.on(AudioPlayerStatus.Idle, () => {
      if (!s.url) return;
      if (s.retry >= 10) return console.warn('⛔ Слишком много перезапусков, остановка.');
      const delay = Math.min(1000 * (2 ** s.retry), 15000);
      console.warn(`🔁 Поток оборвался. Перезапуск #${s.retry + 1} через ${delay}мс...`);
      setTimeout(() => startFfmpegIntoPlayer(s, s.url), delay);
      s.retry++;
    });

    player.on('error', (err) => {
      console.error('Audio player error:', err);
      killProc(s.proc);
    });
  }

  s.retry = 0;
  s.url = url;
  await entersState(s.conn, VoiceConnectionStatus.Ready, 15000);
  console.log('🎧 Voice ready');

  try {
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
  } catch (e) {
    console.error('playOnGuild error:', e);
    const msg = '❌ Не удалось запустить поток.';
    if ('reply' in messageOrInteraction) {
      if (messageOrInteraction.deferred || messageOrInteraction.replied) {
        await messageOrInteraction.followUp(msg);
      } else {
        await messageOrInteraction.reply(msg);
      }
    } else {
      await messageOrInteraction.channel.send(msg);
    }
  }
}

function startFfmpegIntoPlayer(session, url) {
  killProc(session.proc);
  const proc = makeFfmpeg(url);
  session.proc = proc;

  const resource = createAudioResource(proc.stdout, {
    inputType: StreamType.OggOpus,
    inlineVolume: true,
  });

  resource.playStream.on('error', (e) => {
    console.error('resource playStream error:', e);
    killProc(proc);
  });

  session.player.play(resource);
}

function killProc(proc) {
  if (!proc) return;
  try { proc.kill('SIGKILL'); } catch {}
}

// ---- UI
async function sendStationsMenu(channel) {
  const options = [...STATIONS, ...customStations].slice(0, 25).map(s => ({
    label: s.label,
    description: s.desc?.slice(0, 50) || 'Радио',
    value: s.value,
    emoji: s.emoji || '🎵',
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

// ---- Discord client
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

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  const text = message.content.trim();
  const [cmd, ...rest] = text.split(/\s+/);

  if (cmd === '!help') {
    return message.channel.send('Команды: !play <url|name>, !stations, !add "<name>" <url>, !list, !stop');
  }

  if (cmd === '!play') {
    const arg = rest.join(' ').trim();
    if (!arg) return message.reply('Использование: `!play <url|имя_станции>`');

    const fromList = [...STATIONS, ...customStations].find(s =>
      s.label.toLowerCase() === arg.toLowerCase()
    );
    const url = fromList ? fromList.value : arg;

    return playOnGuild(message, url);
  }

  if (cmd === '!stations') return sendStationsMenu(message.channel);

  if (cmd === '!add') {
    const m = text.match(/^!add\s+"([^"]+)"\s+(\S+)/);
    if (!m) return message.reply('Использование: `!add "Название станции" <url>`');
    const [, label, url] = m;
    customStations.unshift({ label, desc: 'Пользовательская станция', value: url, emoji: '⭐' });
    return message.reply(`✅ Добавил в список: **${label}** → ${url}`);
  }

  if (cmd === '!list') {
    const lines = [...STATIONS, ...customStations].map(s => `• **${s.label}** — ${s.value}`);
    return message.reply(lines.join('\n').slice(0, 1900));
  }

  if (cmd === '!stop') {
    const s = sessions.get(message.guild.id);
    if (s) {
      killProc(s.proc);
      try { s.conn.destroy(); } catch {}
      sessions.delete(message.guild.id);
      return message.channel.send('🛑 Остановлено.');
    }
    return message.channel.send('ℹ️ Бот не в голосовом.');
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId !== 'radio_select') return;

  const url = interaction.values[0];
  try {
    await interaction.deferReply({ flags: 0 });
    await playOnGuild(interaction, url);
  } catch (e) {
    console.error('interaction error:', e);
    if (!interaction.replied) {
      await interaction.reply('❌ Не удалось запустить поток.');
    }
  }
});

client.login(process.env.DISCORD_TOKEN).catch(e => console.error('❌ Ошибка входа:', e));

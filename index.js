// index.js
import 'dotenv/config';

import {
  Client, GatewayIntentBits,
  EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder
} from 'discord.js';

import {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType,
  generateDependencyReport
} from '@discordjs/voice';

import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';

// ─────────────────────────────────────────────────────────
// FFmpeg binary: system first, then ffmpeg-static fallback
const ffmpegBin = process.env.FFMPEG_BIN || ffmpegStatic || 'ffmpeg';
try {
  const ffmpegStatic = require('ffmpeg-static');
  if (ffmpegStatic) ffmpegBin = ffmpegStatic;
} catch (_) { /* ok if not installed */ }

// ─────────────────────────────────────────────────────────
// БАЗОВЫЕ ПРОВЕРКИ / ЛОГИ
// ─────────────────────────────────────────────────────────
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Нет DISCORD_TOKEN в .env');
  process.exit(1);
}
console.log('🧩 Voice deps report:\n' + generateDependencyReport());
console.log('🎬 FFmpeg path:', ffmpegBin);

// ─────────────────────────────────────────────────────────
// КАТАЛОГ СТАНЦИЙ
// ─────────────────────────────────────────────────────────
const STATIONS = [
  { label: 'Radio R',         desc: 'Литва (MP3)', value: 'https://stream1.relaxfm.lt/rrb128.mp3', emoji: '📻' },
  { label: 'Авторадио (Мск)', desc: 'HLS',         value: 'https://hls-01-gpm.hostingradio.ru/avtoradio495/playlist.m3u8', emoji: '🚗' },
  { label: 'Ретро FM (Мск)',  desc: 'MP3',         value: 'http://emgregion.hostingradio.ru:8064/moscow.retrofm.mp3', emoji: '🕰️' },
];

const customStations = []; // {label, desc, value, emoji?}
const sessions = new Map(); // guildId -> {conn, player, proc, url, retry}

// ─────────────────────────────────────────────────────────
// Вспомогательные: убийство процесса кроссплатформенно
// ─────────────────────────────────────────────────────────
function safeKill(p) {
  if (!p) return;
  try { p.kill(); } catch {}
  setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 400);
}
function killProc(proc) { safeKill(proc); }

// ─────────────────────────────────────────────────────────
// FFmpeg конвейер: вход (HLS/MP3) → выход (opus|pcm)
// mode: 'opus' | 'pcm'
// ─────────────────────────────────────────────────────────
function headersFor(url) {
  // Базовые — по домену входного URL
  let origin = 'https://discordapp.com';
  let referer = 'https://discordapp.com/';
  try {
    const u = new URL(url);
    origin = `${u.protocol}//${u.host}`;
    referer = `${origin}/`;
  } catch {}

  // Спец-кейс для hostingradio (GPM): многие их .m3u8 требуют сайта станции
  if (/hostingradio\.ru$/i.test(new URL(url).host)) {
    origin  = 'https://www.avtoradio.ru';
    referer = 'https://www.avtoradio.ru/online/';
  }

  return (
    'User-Agent: Mozilla/5.0 (DiscordRadioBot)\r\n' +
    `Origin: ${origin}\r\n` +
    `Referer: ${referer}\r\n` +
    'Accept: */*\r\n'
  );
}

function spawnFfmpeg(url, mode, useAdvancedHlsFlags) {
  const isHls = /\.m3u8(\?|$)/i.test(url);
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'warning',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_at_eof', '1',
    '-reconnect_delay_max', '5',
    '-rw_timeout', '15000000',
    '-analyzeduration', '2000000', '-probesize', '256k',
    '-headers', headersFor(url),
  ];

  if (isHls) {
    args.push('-protocol_whitelist', 'file,crypto,tcp,http,https,tls');
    args.push('-ignore_io_errors', '1');
    if (useAdvancedHlsFlags) {
      // Подсказки для лайва: если сборка поддерживает — будет хорошо; если нет — мы откатимся
      args.push('-playlist_flags', '+live+append_list+ignore_length+omit_endlist');
    }
  }

  args.push('-i', url, '-fflags', '+genpts+discardcorrupt', '-vn', '-sn', '-dn');

  if (mode === 'opus') {
    args.push('-c:a', 'libopus', '-b:a', '128k', '-vbr', 'on', '-compression_level', '10', '-f', 'ogg', 'pipe:1');
  } else {
    args.push('-acodec', 'pcm_s16le', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');
  }

  const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return proc;
}

function makeFfmpeg(url, mode, attempt = 1) {
  const isHls = /\.m3u8(\?|$)/i.test(url);
  // 1-я попытка: с advanced HLS флагами; 2-я — без них (если не поддерживаются)
  const useAdvanced = isHls && attempt === 1;

  const proc = spawnFfmpeg(url, mode, useAdvanced);

  proc.stderr.on('data', (b) => {
    const s = b.toString();
    if (/Unrecognized option 'playlist_flags'|Option not found/.test(s) && useAdvanced) {
      console.warn('ffmpeg: playlist_flags unsupported → restarting without it');
      safeKill(proc);
    } else if (/(error|invalid|fail|timeout|403|404|denied|forbidden|not found)/i.test(s)) {
      console.warn('ffmpeg:', s.trim());
    } else if (/end of file/i.test(s)) {
      // EOF для HLS — частая история при смене сегмента. Не считаем это фаталом, ffmpeg сам реконнектится.
      console.log('ffmpeg: HLS EOF (will reconnect)');
    }
  });

  // Авто-ретрай без playlist_flags, если мы их только что отключили
  proc.on('close', (code, sig) => {
    if (useAdvanced && attempt === 1) {
      // Процесс убили из-за неподдерживаемых флагов → запускаем вторую попытку без них
      makeFfmpeg._restart?.(url, mode);
    }
  });

  // Сторожок: HLS не режем на старте; MP3/Opus — да
  let gotAudio = false;
  let last = Date.now();
  const startup = setTimeout(() => {
    if (!gotAudio && (!isHls || mode === 'opus')) {
      console.warn(`ffmpeg: no audio at startup (8s, ${mode}) → restart`);
      safeKill(proc);
    }
  }, 8000);
  const hb = setInterval(() => {
    if (gotAudio && Date.now() - last > 20000) {
      console.warn('ffmpeg: no audio for 20s → restart');
      safeKill(proc);
    }
  }, 5000);

  proc.stdout.on('data', () => { gotAudio = true; last = Date.now(); });
  proc.on('close', () => { clearTimeout(startup); clearInterval(hb); });

  // Хелпер для ретрая без флагов
  makeFfmpeg._restart = (u, m) => {
    const p2 = spawnFfmpeg(u, m, false);
    // переназначаем обработчики как у основного
    p2.stderr.on('data', (b) => {
      const s = b.toString();
      if (/(error|invalid|fail|timeout|403|404|denied|forbidden|not found)/i.test(s)) {
        console.warn('ffmpeg:', s.trim());
      } else if (/end of file/i.test(s)) {
        console.log('ffmpeg: HLS EOF (will reconnect)');
      }
    });
    let got2 = false; let last2 = Date.now();
    const st2 = setTimeout(() => {
      if (!got2 && (!isHls || m === 'opus')) {
        console.warn(`ffmpeg: no audio at startup (8s, ${m}) → restart`);
        safeKill(p2);
      }
    }, 8000);
    const hb2 = setInterval(() => {
      if (got2 && Date.now() - last2 > 20000) {
        console.warn('ffmpeg: no audio for 20s → restart');
        safeKill(p2);
      }
    }, 5000);
    p2.stdout.on('data', () => { got2 = true; last2 = Date.now(); });
    p2.on('close', () => { clearTimeout(st2); clearInterval(hb2); });
    // Пробрасываем наружу
    makeFfmpeg._onRestart?.(p2);
  };

  return proc;
}
// ─────────────────────────────────────────────────────────
// Запуск/перезапуск пайплайна с умным кодек-фолбэком для HLS
// ─────────────────────────────────────────────────────────
function startFfmpegIntoPlayer(session, url) {
  const isHls = /\.m3u8(\?|$)/i.test(url);
  let mode = process.env.STREAM_CODEC ||
             (process.env.NODE_ENV === 'production' ? 'opus' : 'pcm');
  if (mode !== 'opus' && mode !== 'pcm') mode = 'opus';

  killProc(session.proc);
  let proc = makeFfmpeg(url, mode, 1);
  // если пришлось «снять» playlist_flags — сюда прилетит новый процесс
  makeFfmpeg._onRestart = (p2) => {
    session.proc = p2;
    const res2 = createAudioResource(p2.stdout, {
      inputType: mode === 'opus' ? StreamType.OggOpus : StreamType.Raw,
      inlineVolume: true,
    });
    session.player?.play(res2);
  };

  session.proc = proc;
  const resource = createAudioResource(proc.stdout, {
    inputType: mode === 'opus' ? StreamType.OggOpus : StreamType.Raw,
    inlineVolume: true,
  });
  session.player?.play(resource);

  // HLS: если Opus не стартанул — fallback на PCM
  if (isHls && mode === 'opus' && !process.env.NO_CODEC_FALLBACK) {
    setTimeout(() => {
      if (session.player.state.status !== AudioPlayerStatus.Playing) {
        console.warn('HLS didn’t start in Opus → fallback to PCM');
        killProc(session.proc);
        const p3 = makeFfmpeg(url, 'pcm', 2);
        session.proc = p3;
        const res3 = createAudioResource(p3.stdout, {
          inputType: StreamType.Raw,
          inlineVolume: true,
        });
        session.player?.play(res3);
      }
    }, 10000);
  }
}

// ─────────────────────────────────────────────────────────
// Основная логика play для гильдии
// ─────────────────────────────────────────────────────────
async function playOnGuild(ctx, url) {
  const guild = ctx.guild;
  const member = ctx.member;
  const ch = member?.voice?.channel;
  if (!ch) {
    const reply = '🎤 Сначала зайди в голосовой канал.';
    return 'reply' in ctx ? ctx.reply(reply) : ctx.followUp(reply);
  }

  let s = sessions.get(guild.id);
  if (!s) {
    const conn = joinVoiceChannel({
      channelId: ch.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      daveEncryption: false, 
    });

    const player = createAudioPlayer();

    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      console.warn('⚠️ Voice disconnected, trying to reconnect...');
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5000),
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
      console.log(`🔁 Player: ${o.status} -> ${n.status}`);
      if (n.status === AudioPlayerStatus.Playing) s.retry = 0;
    });

    // Автоперезапуск при обрыве
    player.on(AudioPlayerStatus.Idle, () => {
      if (!s.url) return;
      if (s.retry >= 5) return;
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
  await entersState(s.conn, VoiceConnectionStatus.Ready, 15000);
  console.log('🎧 Voice ready');

  startFfmpegIntoPlayer(s, url);

  const text = `📻 Играет: ${url}`;
  if ('reply' in ctx) {
    if (ctx.deferred || ctx.replied) await ctx.followUp(text);
    else await ctx.reply(text);
  } else {
    await ctx.channel.send(text);
  }
}

// ─────────────────────────────────────────────────────────
// UI: Выпадающее меню станций
// ─────────────────────────────────────────────────────────
async function sendStationsMenu(channel) {
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
// DISCORD CLIENT + команды
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

    const fromList = [...STATIONS, ...customStations].find(
      s => s.label.toLowerCase() === arg.toLowerCase()
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
  await interaction.deferReply();
  return playOnGuild(interaction, url);
});

client.login(process.env.DISCORD_TOKEN).catch(e => console.error('❌ Ошибка входа:', e));

import {
  Client,
  GatewayIntentBits,
  WebhookClient,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType
} from 'discord.js';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import FormData from 'form-data';
import chalk from 'chalk';
import os from 'os';

// Config and constants
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// Haupt-Zipline (für eingeloggte User)
const ZIPLINE_BASE_URL = config.ziplineBaseUrl;

// Anonyme Zipline-Instanz (für User ohne Login)
const ANON_ZIPLINE_BASE_URL = config.anonymousZiplineBaseUrl;
const ANON_ZIPLINE_TOKEN = config.anonymousZiplineToken;
const ANON_UPLOAD_EXPIRY = config.anonymousUploadExpiry || null;

const DATA_DIR = './data';
const TOKENS_FILE = path.join(DATA_DIR, 'userTokens.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'userSettings.json');
const IDS_FILE = path.join(DATA_DIR, 'userIds.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(TOKENS_FILE)) fs.writeFileSync(TOKENS_FILE, '{}');
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, '{}');
if (!fs.existsSync(IDS_FILE)) fs.writeFileSync(IDS_FILE, '{}');

let userTokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
let userSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
let userIds = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));

const webhook = config.errorWebhookUrl ? new WebhookClient({ url: config.errorWebhookUrl }) : null;

// Logging functions
function logInfo(msg) { console.log(chalk.blue('[INFO]'), msg); }
function logSuccess(msg) { console.log(chalk.green('[SUCCESS]'), msg); }
function logWarn(msg) { console.log(chalk.yellow('[WARN]'), msg); }
function logError(error, ctx = '') {
  console.error(chalk.red('[ERROR]'), ctx);
  if (error instanceof Error) console.error(chalk.red(error.stack));
  else console.error(chalk.red(error));
  if (webhook) {
    webhook.send({
      content: `❌ Error in ${ctx}\n\`\`\`${error.stack || error.message || error}\`\`\``
    }).catch(console.error);
  }
}

// Token and settings management
function saveTokens() { fs.writeFileSync(TOKENS_FILE, JSON.stringify(userTokens, null, 2)); }
function saveSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(userSettings, null, 2)); }
function saveIds() { fs.writeFileSync(IDS_FILE, JSON.stringify(userIds, null, 2)); }

function getUserToken(userId) { return userTokens[userId] || null; }
function setUserToken(userId, token) { userTokens[userId] = token; saveTokens(); }
function deleteUserToken(userId) { delete userTokens[userId]; saveTokens(); }

function getBotUserId(discordUserId) {
  return userIds[discordUserId] || null;
}

function ensureAssignBotUserId(discordUserId) {
  if (userIds[discordUserId]) return userIds[discordUserId];

  // Find highest existing numeric id
  const existing = Object.values(userIds).map(v => parseInt(v, 10)).filter(n => !isNaN(n));
  const next = (existing.length ? Math.max(...existing) : 0) + 1;
  userIds[discordUserId] = next;
  saveIds();
  return next;
}

// On startup, ensure all existing token-holders have a bot user ID
try {
  Object.keys(userTokens).forEach(uid => {
    if (!userIds[uid]) {
      ensureAssignBotUserId(uid);
      logInfo(`Assigned bot user ID ${userIds[uid]} to existing user ${uid}`);
    }
  });
} catch (e) {
  logWarn('Failed to assign IDs to existing users: ' + e.message);
}

function getUserSettings(userId) {
  return userSettings[userId] || { expiry: null, compression: null };
}

function setUserSettings(userId, settings) {
  userSettings[userId] = {
    expiry: settings.expiry ? settings.expiry.trim() : null,
    compression: settings.compression ? settings.compression.trim() : null
  };
  saveSettings();
}

// Token validation function (Haupt-Instanz)
async function validateZiplineToken(token) {
  try {
    const res = await fetch(`${ZIPLINE_BASE_URL}/api/user`, {
      headers: { Authorization: token }
    });

    if (!res.ok) {
      return { valid: false, error: `HTTP ${res.status} - Invalid token or unauthorized` };
    }

    const data = await res.json();
    return {
      valid: true,
      user: data.username || 'Unknown',
      role: data.role || 'Unknown',
      quota: data.quota || { used: 0, max: '∞' }
    };
  } catch (error) {
    return { valid: false, error: 'Network error or invalid Zipline URL' };
  }
}

// User info API
async function ziplineGetMe(token) {
  const res = await fetch(`${ZIPLINE_BASE_URL}/api/user`, {
    headers: { Authorization: token }
  });
  if (!res.ok) throw new Error(`Zipline /api/user error ${res.status}`);
  const data = await res.json();
  // The API wraps the user data in a 'user' property
  return data.user || data;
}

// Fetch one page of uploads
async function ziplineFetchUserUploads(token, page = 1, perpage = 50) {
  const url = `${ZIPLINE_BASE_URL}/api/user/files?page=${page}&perpage=${perpage}&sortBy=createdAt&order=desc&filter=all`;
  const res = await fetch(url, { headers: { Authorization: token } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Zipline /api/user/files error ${res.status}: ${text}`);
  return JSON.parse(text);
}

// Fetch all uploads
async function ziplineFetchAllUserUploads(token) {
  let allUploads = [];
  let page = 1;
  const perpage = 50;

  while (true) {
    const resp = await ziplineFetchUserUploads(token, page, perpage);
    if (!resp.page || resp.page.length === 0) break;
    allUploads.push(...resp.page);
    if (page >= resp.pages) break;
    page++;
  }
  return allUploads;
}

// Upload file (für eingeloggte User, mit userSettings)
async function ziplineUploadFromUrl(token, fileUrl, filename, userId) {
  const settings = getUserSettings(userId);

  const tmpPath = path.join('./', `tmp_${Date.now()}_${filename}`);
  const dlRes = await fetch(fileUrl);
  if (!dlRes.ok) throw new Error('Failed to download attachment');

  const fileStream = fs.createWriteStream(tmpPath);
  await new Promise((res, rej) => {
    dlRes.body.pipe(fileStream);
    dlRes.body.on('error', rej);
    fileStream.on('finish', res);
  });

  const form = new FormData();
  form.append('file', fs.createReadStream(tmpPath));

  const headers = {
    Authorization: token,
    ...form.getHeaders()
  };

  // User-spezifische Einstellungen auf Haupt-Instanz
  if (settings.expiry && settings.expiry !== '') {
    headers['x-zipline-deletes-at'] = settings.expiry;
  }
  if (settings.compression && settings.compression !== '') {
    headers['x-zipline-compression'] = settings.compression;
  }

  const resUpload = await fetch(`${ZIPLINE_BASE_URL}/api/upload`, {
    method: 'POST',
    headers,
    body: form
  });

  fs.unlinkSync(tmpPath);
  if (!resUpload.ok) throw new Error(`Zipline upload error ${resUpload.status}`);

  return resUpload.json();
}

// Upload file (anonyme Instanz, ohne User-Login)
async function ziplineAnonUploadFromUrl(fileUrl, filename) {
  if (!ANON_ZIPLINE_BASE_URL || !ANON_ZIPLINE_TOKEN) {
    throw new Error('Guest Zipline instance or token not configured in config.json');
  }

  const tmpPath = path.join('./', `tmp_anon_${Date.now()}_${filename}`);
  const dlRes = await fetch(fileUrl);
  if (!dlRes.ok) throw new Error('Failed to download attachment');

  const fileStream = fs.createWriteStream(tmpPath);
  await new Promise((res, rej) => {
    dlRes.body.pipe(fileStream);
    dlRes.body.on('error', rej);
    fileStream.on('finish', res);
  });

  const form = new FormData();
  form.append('file', fs.createReadStream(tmpPath));

  const headers = {
    Authorization: ANON_ZIPLINE_TOKEN,
    ...form.getHeaders()
  };

  // Standard-Ablaufzeit aus config.json für anonyme Uploads
  if (ANON_UPLOAD_EXPIRY && ANON_UPLOAD_EXPIRY !== '') {
    headers['x-zipline-deletes-at'] = ANON_UPLOAD_EXPIRY; // z.B. "7d" oder "date=2025-01-01T00:00:00Z"[web:6]
  }

  const resUpload = await fetch(`${ANON_ZIPLINE_BASE_URL}/api/upload`, {
    method: 'POST',
    headers,
    body: form
  });

  fs.unlinkSync(tmpPath);
  if (!resUpload.ok) throw new Error(`Guest Zipline upload error ${resUpload.status}`);

  return resUpload.json();
}

// Slash commands definition
const commands = [
  new SlashCommandBuilder()
    .setName('zipline')
    .setDescription('Zipline commands')
    .addSubcommand(sub =>
      sub.setName('settoken')
        .setDescription('Set your Zipline API token')
        .addStringOption(opt => opt.setName('token').setDescription('Your token').setRequired(true))
    )
    .addSubcommand(sub => sub.setName('me').setDescription('Show your account info'))
    .addSubcommand(sub => sub.setName('list').setDescription('List your uploads'))
    .addSubcommand(sub =>
      sub.setName('upload')
        .setDescription('Upload a file')
        .addAttachmentOption(opt => opt.setName('file').setDescription('File to upload').setRequired(true))
    )
    .addSubcommand(sub => sub.setName('settings').setDescription('Manage your default upload settings'))
    .addSubcommand(sub => sub.setName('logout').setDescription('Delete token (logout)'))
    .addSubcommand(sub => sub.setName('invite').setDescription('Show bot invite link'))
    .addSubcommand(sub => sub.setName('about').setDescription('Info about the bot and its commands'))
    .addSubcommand(sub =>
      sub.setName('stats')
        .setDescription('Show host/server resource usage, Zipline stats, and your storage usage')
    )
    .toJSON()
];

async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  try {
    logInfo('Registering global slash commands...');
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    logSuccess('Slash commands registered successfully.');
  } catch (err) {
    logError(err, 'Registering slash commands');
  }
}

// Create Discord client
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, () => {
  logSuccess(`Logged in as ${client.user.tag}`);
  client.user.setPresence({
    status: 'online',
    activities: [{
      name: 'www.stuffmaker.net',
      type: 4
    }]
  });
});

// Pagination helper
async function paginateUploads(interaction, uploads) {
  const pageSize = 5;
  let page = 0;
  const totalPages = Math.ceil(uploads.length / pageSize);

  function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return 'unknown';
    const kb = 1024;
    const mb = kb * 1024;
    if (bytes < mb) return `${(bytes / kb).toFixed(1)} KB`;
    return `${(bytes / mb).toFixed(2)} MB`;
  }

  function createEmbed() {
    const embed = new EmbedBuilder()
      .setTitle('Your Uploads')
      .setFooter({ text: `Page ${page + 1} of ${totalPages}` });
    const slice = uploads.slice(page * pageSize, (page + 1) * pageSize);

    function trimString(str, maxLength = 15) {
      if (!str) return '';
      return str.length > maxLength ? str.slice(0, maxLength - 1) + '…' : str;
    }

    const descriptionLines = slice.map(f => {
      const name = trimString(f.originalName || f.name || 'Unnamed', 15);
      const url = f.url && f.url.startsWith('http') ? f.url : `${ZIPLINE_BASE_URL}${f.url || `/u/${f.id}`}`;
      const sizeStr = formatFileSize(f.size);
      const createdTimestamp = f.createdAt ? Math.floor(new Date(f.createdAt).getTime() / 1000) : null;
      const createdDiscordTime = createdTimestamp ? `<t:${createdTimestamp}:R>` : 'unknown';
      return `• [${name}](${url}) — ${sizeStr} — Created: ${createdDiscordTime}`;
    });

    embed.setDescription(descriptionLines.join('\n'));
    return embed;
  }

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('prev')
        .setLabel('⬅️ Back')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId('next')
        .setLabel('➡️ Next')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page + 1 === totalPages)
    );

  const message = await interaction.reply({
    embeds: [createEmbed()],
    components: [row],
    flags: MessageFlags.Ephemeral,
    fetchReply: true
  });

  const collector = message.createMessageComponentCollector({ time: 60000 });

  collector.on('collect', async i => {
    if (i.user.id !== interaction.user.id) {
      await i.reply({ content: 'Only you can navigate pages!', flags: MessageFlags.Ephemeral });
      return;
    }
    if (i.customId === 'prev' && page > 0) page--;
    if (i.customId === 'next' && page < totalPages - 1) page++;

    await i.update({
      embeds: [createEmbed()],
      components: [
        new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('prev')
              .setLabel('⬅️ Back')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(page === 0),
            new ButtonBuilder()
              .setCustomId('next')
              .setLabel('➡️ Next')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(page + 1 === totalPages)
          )
      ]
    });
  });

  collector.on('end', () => {
    message.edit({ components: [] }).catch(() => { });
  });
}

// Helper: get human-readable OS name
function getReadableOSName() {
  const platform = os.platform();
  const release = os.release();

  if (platform === 'win32') {
    if (release.startsWith('10.0')) return 'Windows Server 2016/2019/2022';
    if (release.startsWith('6.3')) return 'Windows Server 2012 R2';
    if (release.startsWith('6.2')) return 'Windows Server 2012';
    if (release.startsWith('6.1')) return 'Windows Server 2008 R2';
    return `Windows (Release ${release})`;
  }

  if (platform === 'linux') {
    try {
      const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
      const match = osRelease.match(/^PRETTY_NAME="(.+)"$/m);
      if (match) return match[1];
    } catch {
    }
    return `Linux kernel ${release}`;
  }

  if (platform === 'darwin') {
    return 'macOS ' + release;
  }

  return `${platform} ${release}`;
}

// Zipline stats API
async function ziplineGetStats() {
  const res = await fetch(`${ZIPLINE_BASE_URL}/api/stats`, {
    headers: { Authorization: ANON_ZIPLINE_TOKEN }
  });
  if (!res.ok) throw new Error(`Zipline /api/stats error ${res.status}`);
  const statsArray = await res.json();
  // The API returns an array; get the first (latest) entry's data
  if (Array.isArray(statsArray) && statsArray.length > 0 && statsArray[0].data) {
    return statsArray[0].data;
  }
  return {};
}

// Interaction handler
client.on(Events.InteractionCreate, async interaction => {
  const userId = interaction.user.id;

  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'zipline') {
      const sub = interaction.options.getSubcommand(true);

      if (sub === 'settoken') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const token = interaction.options.getString('token', true);
        const validation = await validateZiplineToken(token);

        if (validation.valid) {
          setUserToken(userId, token);
          const botUserId = ensureAssignBotUserId(userId);
          const embed = new EmbedBuilder()
            .setTitle('✅ Token Valid & Saved!')
            .setDescription(`**User:** ${validation.user}\n**Role:** ${validation.role}\n**Storage:** ${validation.quota.used}/${validation.quota.max}`)
            .addFields(
              { name: '🔗 Zipline', value: `[Open Dashboard](${ZIPLINE_BASE_URL})`, inline: true },
              { name: '🆔 Bot User ID', value: String(botUserId), inline: true }
            )
            .setColor(0x00ff00)
            .setThumbnail(interaction.user.displayAvatarURL({ format: 'png', size: 1024 }));

          await interaction.editReply({ embeds: [embed] });
        } else {
          const embed = new EmbedBuilder()
            .setTitle('❌ Invalid Token')
            .setDescription(`**Error:** ${validation.error}`)
            .addFields(
              { name: '💡 Tip', value: `Get your token from ${ZIPLINE_BASE_URL}/dashboard`, inline: false },
              { name: '🔗', value: `[Zipline Dashboard](${ZIPLINE_BASE_URL})`, inline: true }
            )
            .setColor(0xff0000)
            .setThumbnail(interaction.user.displayAvatarURL({ format: 'png', size: 1024 }));

          await interaction.editReply({ embeds: [embed] });
        }
        return;
      }

      if (sub === 'logout') {
        deleteUserToken(userId);
        await interaction.reply({ content: '🚪 You have been logged out.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === 'invite') {
        const inviteLink = `https://discord.com/oauth2/authorize?client_id=${config.clientId}`;
        await interaction.reply({ content: `🤖 Invite me using this link:\n${inviteLink}`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === 'about') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        let botVersion = 'unknown';
        try {
          const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
          botVersion = packageJson.version || 'unknown';
        } catch {
          botVersion = 'unknown';
        }

        const commandId = '1441450591409668117';

        const subcommands = [
          { key: 'settoken', label: '🔐', desc: 'Set your Zipline API token' },
          { key: 'logout', label: '🚪', desc: 'Delete token (logout)' },
          { key: 'me', label: '👤', desc: 'Show your account info' },
          { key: 'list', label: '📂', desc: 'List your uploads' },
          { key: 'upload', label: '📤', desc: 'Upload a file' },
          { key: 'settings', label: '⚙️', desc: 'Manage your default upload settings' },
          { key: 'invite', label: '🤖', desc: 'Show bot invite link' },
          { key: 'about', label: 'ℹ️', desc: 'Info about the bot and its commands' },
          { key: 'stats', label: '📊', desc: 'Show host/server resource usage, Zipline stats, and your storage usage' }
        ];

        const commandsLines = subcommands.map(sc => {
          return `${sc.label} </zipline ${sc.key}:${commandId}> — ${sc.desc}`;
        });

        const commandsList = commandsLines.join('\n');

        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setLabel('Support')
              .setStyle(ButtonStyle.Link)
              .setURL('https://discord.fish/support')
              .setEmoji('<:support:1449887982587740312>'),
            new ButtonBuilder()
              .setLabel('GitHub')
              .setStyle(ButtonStyle.Link)
              .setURL('https://github.com/MrStuffmaker/zipline-bot')
              .setEmoji('<:github:1449887984626434169>')
          );

        await interaction.editReply({
          content: `💡 **Zipline Bot v${botVersion}**\n\n${commandsList}`,
          components: [row]
        });
        return;
      }

      if (sub === 'settings') {
        const settings = getUserSettings(userId);

        const embed = new EmbedBuilder()
          .setTitle('⚙️ User Settings')
          .setDescription('Manage your default upload settings')
          .addFields(
            { name: '📅 Expiry', value: settings.expiry ? `\`${settings.expiry}\`` : 'Not set', inline: true },
            { name: '🗜️ Compression', value: settings.compression ? `\`${settings.compression}\`` : 'Not set', inline: true }
          )
          .setColor(0x00b0ff)
          .setFooter({ text: 'Click a button below to edit settings' });

        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('edit_expiry')
              .setLabel('Edit Expiry')
              .setEmoji('📅')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId('edit_compression')
              .setLabel('Edit Compression')
              .setEmoji('🗜️')
              .setStyle(ButtonStyle.Secondary)
          );

        await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
        return;
      }

      // Ab hier werden nur Befehle behandelt, die ein Token auf der Hauptinstanz brauchen
      const token = getUserToken(userId);

      if (sub === 'me') {
        if (!token) {
          await interaction.reply({
            content: `❗ Please set your token first using </zipline settoken:1441450591409668117>.\n🔗 Zipline URL: ${ZIPLINE_BASE_URL}`,
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const data = await ziplineGetMe(token);
        const botUserId = getBotUserId(userId) || ensureAssignBotUserId(userId);

        // Try to get user storage from Zipline stats; fall back to quota if available
        let userStorage = 0;
        try {
          const zipStats = await ziplineGetStats();
          if (zipStats.filesUsers && Array.isArray(zipStats.filesUsers)) {
            const userFileData = zipStats.filesUsers.find(u => u.username === (data.username || ''));
            if (userFileData) userStorage = userFileData.storage || 0;
          }
        } catch {
          // ignore
        }

        // If API provides quota info on the user object, prefer that for display
        const quota = data.quota || null;

        const formatStorage = (bytes) => {
          if (!bytes || bytes === 0) return '0 MB';
          const mb = bytes / (1024 * 1024);
          if (mb > 1024) return (mb / 1024).toFixed(2) + ' GB';
          return mb.toFixed(2) + ' MB';
        };

        const storageDisplay = quota && typeof quota.used !== 'undefined' && typeof quota.max !== 'undefined'
          ? `${formatStorage(quota.used)} / ${quota.max}`
          : formatStorage(userStorage || 0);

        const embed = new EmbedBuilder()
          .setTitle('👤 Account Info')
          .addFields(
            { name: 'Username', value: data.username || 'Unknown', inline: true },
            { name: 'Role', value: data.role || 'Unknown', inline: true },
            { name: '🆔 Bot User ID', value: String(botUserId), inline: true },
            { name: '📦 Storage', value: storageDisplay, inline: false }
          )
          .setColor(0x00ff00);

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (sub === 'list') {
        if (!token) {
          await interaction.reply({
            content: `❗ Please set your token first using </zipline settoken:1441450591409668117>.\n🔗 Zipline URL: ${ZIPLINE_BASE_URL}`,
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const uploads = await ziplineFetchAllUserUploads(token);
        if (!uploads.length) {
          await interaction.reply({ content: 'No uploads found.', flags: MessageFlags.Ephemeral });
          return;
        }
        await paginateUploads(interaction, uploads);
        return;
      }

      if (sub === 'upload') {
        const attachment = interaction.options.getAttachment('file', true);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const userToken = getUserToken(userId);

        // Wenn der User eingeloggt ist -> Hauptinstanz + User-Settings
        if (userToken) {
          const uploadResp = await ziplineUploadFromUrl(userToken, attachment.url, attachment.name, userId);
          const urls = (uploadResp.files || []).map(f =>
            f.url || `${ZIPLINE_BASE_URL}/u/${f.id}`
          ).join('\n');

          const embed = new EmbedBuilder()
            .setTitle('✅ Upload Successful')
            .setDescription(`**[Click the link to view your upload](${urls})**`)
            .setColor(0x00ff00);

          await interaction.editReply({ embeds: [embed] });
        } else {
          // Kein Login -> anonyme Instanz mit Daten aus config.json
          const uploadResp = await ziplineAnonUploadFromUrl(attachment.url, attachment.name);
          const urls = (uploadResp.files || []).map(f =>
            f.url || `${ANON_ZIPLINE_BASE_URL}/u/${f.id}`
          ).join('\n');

          const embed = new EmbedBuilder()
            .setTitle('✅ Guest Upload Successful')
            .setDescription(`**[Click the link to view your upload](${urls})**`)
            .addFields(
              ANON_UPLOAD_EXPIRY
                ? { name: '⏱ Expiry', value: `This file is set to expire after: \`${ANON_UPLOAD_EXPIRY}\``, inline: false }
                : { name: '⏱ Expiry', value: 'No default expiry configured.', inline: false }
            )
            .setColor(0x00ff00);

          await interaction.editReply({ embeds: [embed] });
        }
        return;
      }

      if (sub === 'stats') {
        if (!token) {
          await interaction.reply({
            content: `❗ Please set your token first using </zipline settoken:1441450591409668117>.\n🔗 Zipline URL: ${ZIPLINE_BASE_URL}`,
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const hostStats = {
          os: getReadableOSName(),
          uptime: os.uptime(),
          loadAvg: os.loadavg(),
          totalMem: os.totalmem(),
          freeMem: os.freemem(),
          usedMem: process.memoryUsage().rss,
          cpuCount: os.cpus().length
        };

        let zipStats;
        try {
          zipStats = await ziplineGetStats();
        } catch {
          zipStats = { error: 'Unavailable' };
        }

        let userMe;
        try {
          userMe = await ziplineGetMe(token);
        } catch {
          userMe = { username: 'Unknown' };
        }

        // Calculate user storage from the stats filesUsers array
        let userStorage = 0;
        if (zipStats.filesUsers && Array.isArray(zipStats.filesUsers)) {
          const userFileData = zipStats.filesUsers.find(u => u.username === userMe.username);
          if (userFileData) {
            userStorage = userFileData.storage || 0;
          }
        }

        const uptimeSeconds = hostStats.uptime;
        const days = Math.floor(uptimeSeconds / 86400);
        const hours = Math.floor((uptimeSeconds % 86400) / 3600);
        const minutes = Math.floor((uptimeSeconds % 3600) / 60);
        const uptimeDisplay = `${days}d/${String(hours).padStart(2, '0')}h/${String(minutes).padStart(2, '0')}m`;

        // Format storage to MB or GB
        const formatStorage = (bytes) => {
          const mb = bytes / (1024 * 1024);
          if (mb > 1024) {
            return (mb / 1024).toFixed(2) + ' GB';
          }
          return mb.toFixed(2) + ' MB';
        };

        const userStorageDisplay = formatStorage(userStorage);

        const embed = new EmbedBuilder()
          .setTitle('📊 Server & Zipline Stats')
          .addFields(
            {
              name: '🖥️ Host System',
              value:
                `**OS:** ${hostStats.os}\n` +
                `**Uptime:** ${uptimeDisplay}\n` +
                `**CPUs:** ${hostStats.cpuCount}\n` +
                `**RAM:** ${(hostStats.usedMem / (1024 * 1024)).toFixed(2)}MB / ${(hostStats.freeMem / (1024 * 1024)).toFixed(2)}MB`,
              inline: true
            },
            {
              name: '📈 Zipline',
              value: zipStats.error
                ? `❌ ${zipStats.error}`
                : `**Users:** ${zipStats.users ?? '?'}\n` +
                  `**Files:** ${zipStats.files ?? '?'}\n` +
                  `**Used Storage:** ${zipStats.storage ? (zipStats.storage / (1024 * 1024 * 1024)).toFixed(2) + ' GB' : '?'}\n` +
                  `**File Views:** ${zipStats.fileViews ?? '?'}\n` +
                  `**URLs:** ${zipStats.urls ?? '?'}`,
              inline: true
            },
            {
              name: `👤 ${userMe.username ?? 'Unknown'}`,
              value:
                `**Used:** ${userStorageDisplay}`,
              inline: false
            }
          )
          .setColor(0x5865f2);

        await interaction.editReply({ embeds: [embed] });
        return;
      }
    }

    // Buttons for Settings
    if (interaction.isButton() && (interaction.customId === 'edit_expiry' || interaction.customId === 'edit_compression')) {
      const modal = new ModalBuilder()
        .setCustomId(interaction.customId)
        .setTitle(interaction.customId === 'edit_expiry' ? 'Expiry (days/date)' : 'Compression level');

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('value_input')
            .setLabel(interaction.customId === 'edit_expiry' ? 'Enter expiry (e.g. 7d or 2025-01-01)' : 'Enter compression (e.g. low, medium)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(45)
        )
      );

      await interaction.showModal(modal);
      return;
    }

    // Modal Submit for Settings
    if (interaction.type === InteractionType.ModalSubmit && (interaction.customId === 'edit_expiry' || interaction.customId === 'edit_compression')) {
      const value = interaction.fields.getTextInputValue('value_input');
      if (interaction.customId === 'edit_expiry') {
        setUserSettings(userId, { ...getUserSettings(userId), expiry: value });
      } else {
        setUserSettings(userId, { ...getUserSettings(userId), compression: value });
      }

      const updatedSettings = getUserSettings(userId);
      const embed = new EmbedBuilder()
        .setTitle('✅ Settings Updated!')
        .setDescription('Your new default upload settings:')
        .addFields(
          { name: '📅 Expiry', value: updatedSettings.expiry ? `\`${updatedSettings.expiry}\`` : 'Not set', inline: true },
          { name: '🗜️ Compression', value: updatedSettings.compression ? `\`${updatedSettings.compression}\`` : 'Not set', inline: true }
        )
        .setColor(0x00ff88)
        .setFooter({ text: 'These settings apply to all future uploads.' });

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
  } catch (error) {
    logError(error, 'InteractionHandler');
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('❌ An error occurred.');
      } else {
        await interaction.reply({ content: '❌ An error occurred.', flags: MessageFlags.Ephemeral });
      }
    } catch { }
  }
});

// Start bot and deploy commands
deployCommands().then(() => client.login(config.discordToken));

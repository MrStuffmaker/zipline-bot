// commands/zipline.js
import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
} from 'discord.js';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import FormData from 'form-data';
import chalk from 'chalk';
import os from 'os';


// --- config & constants ---
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

const ZIPLINE_BASE_URL = config.ziplineBaseUrl;
const ANON_ZIPLINE_BASE_URL = config.anonymousZiplineBaseUrl;
const ANON_ZIPLINE_TOKEN = config.anonymousZiplineToken;
const ANON_UPLOAD_EXPIRY = config.anonymousUploadExpiry || null;

// chunk upload config
const CHUNK_THRESHOLD = config.chunkThresholdBytes || 100 * 1024 * 1024; // 100MB default
const CHUNK_SIZE = config.chunkSizeBytes || 8 * 1024 * 1024;       // 8MB default

const DATA_DIR = './data';
const TOKENS_FILE = path.join(DATA_DIR, 'userTokens.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'userSettings.json');
const IDS_FILE = path.join(DATA_DIR, 'userIds.json');


// --- fs init ---
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(TOKENS_FILE)) fs.writeFileSync(TOKENS_FILE, '{}');
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, '{}');
if (!fs.existsSync(IDS_FILE)) fs.writeFileSync(IDS_FILE, '{}');

let userTokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
let userSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
let userIds = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));


// --- logging ---
function logError(error, ctx = '') {
  console.error(chalk.red('[ERROR]'), ctx);
  if (error instanceof Error) console.error(chalk.red(error.stack));
  else console.error(chalk.red(error));
}


// --- storage helpers ---
function saveTokens() { fs.writeFileSync(TOKENS_FILE, JSON.stringify(userTokens, null, 2)); }
function saveSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(userSettings, null, 2)); }
function saveIds() { fs.writeFileSync(IDS_FILE, JSON.stringify(userIds, null, 2)); }

function getUserToken(userId) { return userTokens[userId] || null; }
function setUserToken(userId, token) { userTokens[userId] = token; saveTokens(); }
function deleteUserToken(userId) { delete userTokens[userId]; saveTokens(); }

function getUserSettings(userId) {
  return userSettings[userId] || { expiry: null, compression: null };
}
function setUserSettings(userId, settings) {
  userSettings[userId] = {
    expiry: settings.expiry ? settings.expiry.trim() : null,
    compression: settings.compression ? settings.compression.trim() : null,
  };
  saveSettings();
}

function getBotUserId(discordUserId) {
  return userIds[discordUserId] || null;
}
function ensureAssignBotUserId(discordUserId) {
  if (userIds[discordUserId]) return userIds[discordUserId];
  const existing = Object.values(userIds)
    .map(v => parseInt(v, 10))
    .filter(n => !isNaN(n));
  const next = (existing.length ? Math.max(...existing) : 0) + 1;
  userIds[discordUserId] = next;
  saveIds();
  return next;
}

// assign IDs on module load for users that already had tokens
try {
  Object.keys(userTokens).forEach(uid => {
    if (!userIds[uid]) {
      ensureAssignBotUserId(uid);
    }
  });
} catch (e) {
  console.warn('Failed to assign IDs to existing users:', e.message);
}


// --- Zipline API helpers ---
async function validateZiplineToken(token) {
  try {
    const res = await fetch(`${ZIPLINE_BASE_URL}/api/user`, {
      headers: { Authorization: token },
    });

    if (!res.ok) {
      return { valid: false, error: `HTTP ${res.status} - Invalid token or unauthorized` };
    }

    const data = await res.json();
    return {
      valid: true,
      user: data.username || 'Unknown',
      role: data.role || 'Unknown',
      quota: data.quota || { used: 0, max: '∞' },
    };
  } catch {
    return { valid: false, error: 'Network error or invalid Zipline URL' };
  }
}

async function ziplineGetMe(token) {
  const res = await fetch(`${ZIPLINE_BASE_URL}/api/user`, {
    headers: { Authorization: token },
  });
  if (!res.ok) throw new Error(`Zipline /api/user error ${res.status}`);
  const data = await res.json();
  return data.user || data;
}

async function ziplineFetchUserUploads(token, page = 1, perpage = 50) {
  const url = `${ZIPLINE_BASE_URL}/api/user/files?page=${page}&perpage=${perpage}&sortBy=createdAt&order=desc&filter=all`;
  const res = await fetch(url, { headers: { Authorization: token } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Zipline /api/user/files error ${res.status}: ${text}`);
  return JSON.parse(text);
}

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


// --- upload helpers (normal + partial) ---
async function ziplineUploadFromUrl(token, fileUrl, filename, userId, onProgress) {
  const settings = getUserSettings(userId);

  const headRes = await fetch(fileUrl, { method: 'HEAD' });
  const contentLengthHead = parseInt(headRes.headers.get('content-length') || '0', 10) || 0;

  const dlRes = await fetch(fileUrl);
  if (!dlRes.ok) throw new Error('Failed to download attachment');

  const contentLength = contentLengthHead || parseInt(dlRes.headers.get('content-length') || '0', 10) || 0;
  const contentType = dlRes.headers.get('content-type') || undefined;

  // large files -> partial upload
  if (contentLength >= CHUNK_THRESHOLD && contentLength > 0) {
    return ziplinePartialUpload({
      baseUrl: ZIPLINE_BASE_URL,
      authToken: token,
      fileUrl,
      filename,
      contentLength,
      contentType,
      settings,
      onProgress,
    });
  }

  // small files -> normal /api/upload
  const tmpPath = path.join('./', `tmp_${Date.now()}_${filename}`);
  const fileStream = fs.createWriteStream(tmpPath);
  await new Promise((res, rej) => {
    dlRes.body.pipe(fileStream);
    dlRes.body.on('error', rej);
    fileStream.on('finish', res);
  });

  const form = new FormData();
  form.append('file', fs.createReadStream(tmpPath), { filename });

  const headers = {
    Authorization: token,
    ...form.getHeaders(),
  };

  if (settings.expiry && settings.expiry !== '') {
    headers['x-zipline-deletes-at'] = settings.expiry;
  }
  if (settings.compression && settings.compression !== '') {
    headers['x-zipline-compression'] = settings.compression;
  }

  headers['x-zipline-original-name'] = 'true';

  const resUpload = await fetch(`${ZIPLINE_BASE_URL}/api/upload`, {
    method: 'POST',
    headers,
    body: form,
  });

  const resText = await resUpload.text();
  if (tmpPath && fs.existsSync(tmpPath)) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
  if (!resUpload.ok) throw new Error(`Zipline upload error ${resUpload.status}: ${resText}`);

  try {
    return JSON.parse(resText);
  } catch {
    return resText;
  }
}

async function ziplineAnonUploadFromUrl(fileUrl, filename, onProgress) {
  if (!ANON_ZIPLINE_BASE_URL || !ANON_ZIPLINE_TOKEN) {
    throw new Error('Guest Zipline instance or token not configured in config.json');
  }

  const headRes = await fetch(fileUrl, { method: 'HEAD' });
  const contentLengthHead = parseInt(headRes.headers.get('content-length') || '0', 10) || 0;

  const dlRes = await fetch(fileUrl);
  if (!dlRes.ok) throw new Error('Failed to download attachment');

  const contentLength = contentLengthHead || parseInt(dlRes.headers.get('content-length') || '0', 10) || 0;
  const contentType = dlRes.headers.get('content-type') || undefined;

  if (contentLength >= CHUNK_THRESHOLD && contentLength > 0) {
    return ziplinePartialUpload({
      baseUrl: ANON_ZIPLINE_BASE_URL,
      authToken: ANON_ZIPLINE_TOKEN,
      fileUrl,
      filename,
      contentLength,
      contentType,
      anon: true,
      settings: ANON_UPLOAD_EXPIRY ? { expiry: ANON_UPLOAD_EXPIRY, compression: null } : {},
      onProgress,
    });
  }

  const tmpPath = path.join('./', `tmp_anon_${Date.now()}_${filename}`);
  const fileStream = fs.createWriteStream(tmpPath);
  await new Promise((res, rej) => {
    dlRes.body.pipe(fileStream);
    dlRes.body.on('error', rej);
    fileStream.on('finish', res);
  });

  const form = new FormData();
  form.append('file', fs.createReadStream(tmpPath), { filename });

  const headers = {
    Authorization: ANON_ZIPLINE_TOKEN,
    ...form.getHeaders(),
  };

  if (ANON_UPLOAD_EXPIRY && ANON_UPLOAD_EXPIRY !== '') {
    headers['x-zipline-deletes-at'] = ANON_UPLOAD_EXPIRY;
  }

  headers['x-zipline-original-name'] = 'true';

  const resUpload = await fetch(`${ANON_ZIPLINE_BASE_URL}/api/upload`, {
    method: 'POST',
    headers,
    body: form,
  });

  const resText = await resUpload.text();
  if (tmpPath && fs.existsSync(tmpPath)) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
  if (!resUpload.ok) throw new Error(`Guest Zipline upload error ${resUpload.status}: ${resText}`);

  try {
    return JSON.parse(resText);
  } catch {
    return resText;
  }
}

async function ziplinePartialUpload({
  baseUrl,
  authToken,
  fileUrl,
  filename,
  contentLength,
  contentType,
  anon = false,
  settings = {},
  onProgress,
}) {
  const partialUrl = `${baseUrl.replace(/\/$/, '')}/api/upload/partial`;

  const dlRes = await fetch(fileUrl);
  if (!dlRes.ok) throw new Error('Failed to download attachment for partial upload');

  /* Optimized buffering to prevent memory leaks */
  const iterator = dlRes.body[Symbol.asyncIterator]();
  let accumulatedChunks = [];
  let accumulatedLen = 0;
  let uploadedBytes = 0;
  let partialIdentifier = null;

  while (true) {
    const { value, done } = await iterator.next();

    if (value) {
      accumulatedChunks.push(Buffer.from(value));
      accumulatedLen += value.length;
    }

    // Process if we have enough data (>= CHUNK_SIZE) OR if we are done and have data left
    while (accumulatedLen >= CHUNK_SIZE || (done && accumulatedLen > 0)) {
      let buffer = Buffer.concat(accumulatedChunks);
      accumulatedChunks = [];
      accumulatedLen = 0;

      // Slice chunks out of the consolidated buffer
      while (buffer.length >= CHUNK_SIZE || (done && buffer.length > 0)) {
        // If not done, we strictly need CHUNK_SIZE
        if (!done && buffer.length < CHUNK_SIZE) {
          // Push remainder back and wait for more data
          accumulatedChunks.push(buffer);
          accumulatedLen += buffer.length;
          buffer = Buffer.alloc(0);
          break;
        }

        const amountToSend = Math.min(buffer.length, CHUNK_SIZE);
        const sending = buffer.slice(0, amountToSend);

        // Keep remainder
        const remainder = buffer.slice(amountToSend);
        buffer = remainder;

        // WRITE TO DISK
        const tmpChunkPath = path.join('./', `tmp_chunk_${Date.now()}_${Math.random().toString(36).substring(7)}.bin`);
        fs.writeFileSync(tmpChunkPath, sending);

        let effectiveContentLength = contentLength;
        // Check if this is truly the last piece we will ever send
        const isRefEmpty = (buffer.length === 0 && accumulatedChunks.length === 0 && done);

        if (isRefEmpty) {
          // Fix for content-length mismatch if source size was inexact
          effectiveContentLength = uploadedBytes + sending.length;
        }

        const isLast = (uploadedBytes + sending.length) >= effectiveContentLength;

        console.log(`[DEBUG] Chunk: ${uploadedBytes}-${uploadedBytes + sending.length - 1}/${effectiveContentLength}, isLast: ${isLast}, done: ${done}`);

        try {
          const resp = await sendPartialChunk({
            url: partialUrl,
            authToken,
            filePath: tmpChunkPath,
            filename,
            contentType,
            contentLength: effectiveContentLength,
            partialIdentifier,
            isLast,
            settings,
            uploadedBytes,
          });

          if (resp && resp.files && resp.files.length > 0) {
            console.log(`[DEBUG] Final Files: ${JSON.stringify(resp.files)}`);
            fs.unlinkSync(tmpChunkPath);
            return resp;
          }

          if (resp && resp.partialIdentifier) {
            partialIdentifier = resp.partialIdentifier;
          }

          if (resp && resp.partialSuccess === false) {
            throw new Error('Partial upload failed; server indicated partialSuccess=false');
          }
        } finally {
          if (fs.existsSync(tmpChunkPath)) fs.unlinkSync(tmpChunkPath);
        }

        uploadedBytes += sending.length;
        if (onProgress) onProgress(uploadedBytes, contentLength);
      }

      if (buffer.length > 0) {
        accumulatedChunks.push(buffer);
        accumulatedLen += buffer.length;
      }
    }

    if (done) break;
  }

  return { partialSuccess: true };
}

async function sendPartialChunk({
  url,
  authToken,
  filePath,
  chunkBuffer,
  filename,
  contentType,
  contentLength,
  partialIdentifier,
  isLast,
  settings,
  uploadedBytes,
}) {
  const form = new FormData();

  if (filePath) {
    form.append('file', fs.createReadStream(filePath), {
      filename,
      contentType: contentType || 'application/octet-stream',
    });
  } else if (chunkBuffer) {
    form.append('file', chunkBuffer, {
      filename,
      contentType: contentType || 'application/octet-stream',
    });
  }

  const contentLengthMulti = await new Promise((resolve, reject) => {
    form.getLength((err, len) => {
      if (err) reject(err);
      else resolve(len);
    });
  });

  const chunkLen = filePath ? fs.statSync(filePath).size : chunkBuffer.length;

  const headers = {
    Authorization: authToken,
    ...form.getHeaders(),
    'Content-Length': String(contentLengthMulti),
    'Content-Range': `bytes ${uploadedBytes}-${uploadedBytes + chunkLen - 1}/${contentLength}`,
    'x-zipline-p-filename': filename,
    'x-zipline-p-content-type': contentType || 'application/octet-stream',
    'x-zipline-p-content-length': String(contentLength),
    'x-zipline-p-lastchunk': isLast ? 'true' : 'false',
  };

  if (partialIdentifier) {
    headers['x-zipline-p-identifier'] = partialIdentifier;
  }

  if (settings.expiry && settings.expiry !== '') {
    headers['x-zipline-deletes-at'] = settings.expiry;
  }
  if (settings.compression && settings.compression !== '') {
    headers['x-zipline-compression'] = settings.compression;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: form,
  });

  const txt = await res.text();
  if (!res.ok) {
    console.error('[DEBUG] Response Headers:', JSON.stringify(Object.fromEntries(res.headers.entries()), null, 2));
    throw new Error(`Partial upload failed ${res.status}: ${txt}`);
  }

  try { return JSON.parse(txt); } catch { return txt; }
}


async function ziplineGetVersion() {
  try {
    const res = await fetch(`${ZIPLINE_BASE_URL}/api/version`, {
      headers: { Authorization: ANON_ZIPLINE_TOKEN },
    });

    // 500 is technically "Online" but upstream fetch failed
    if (res.status === 500) {
      return { online: true, statusCode: 500, version: 'Unknown (Upstream Check Failed)' };
    }

    if (!res.ok) {
      return { online: false, statusCode: res.status, version: null };
    }

    const data = await res.json();
    const version = data.details?.version || data.version?.tag || 'Unknown';
    return { online: true, statusCode: 200, version };
  } catch (e) {
    return { online: false, statusCode: 0, error: e.message };
  }
}

async function ziplineGetStats() {
  const res = await fetch(`${ZIPLINE_BASE_URL}/api/stats`, {
    headers: { Authorization: ANON_ZIPLINE_TOKEN },
  });
  if (!res.ok) throw new Error(`Zipline /api/stats error ${res.status}`);
  const statsArray = await res.json();
  if (Array.isArray(statsArray) && statsArray.length > 0 && statsArray[0].data) {
    return statsArray[0].data;
  }
  return {};
}



// --- OS helper ---
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
    } catch { /* ignore */ }
    return `Linux kernel ${release}`;
  }
  if (platform === 'darwin') return `macOS ${release}`;
  return `${platform} ${release}`;
}


// --- pagination helper ---
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

  function trimString(str, maxLength = 15) {
    if (!str) return '';
    return str.length > maxLength ? str.slice(0, maxLength - 1) + '…' : str;
  }

  function createEmbed() {
    const embed = new EmbedBuilder()
      .setTitle('Your Uploads')
      .setFooter({ text: `Page ${page + 1} of ${totalPages}` });

    const slice = uploads.slice(page * pageSize, (page + 1) * pageSize);
    const descriptionLines = slice.map(f => {
      const name = trimString(f.originalName || f.name || 'Unnamed', 15);
      const url = f.url && f.url.startsWith('http')
        ? f.url
        : `${ZIPLINE_BASE_URL}${f.url || `/u/${f.id}`}`;
      const sizeStr = formatFileSize(f.size);
      const createdTimestamp = f.createdAt
        ? Math.floor(new Date(f.createdAt).getTime() / 1000)
        : null;
      const createdDiscordTime = createdTimestamp
        ? `<t:${createdTimestamp}:R>`
        : 'unknown';
      return `• [${name}](${url}) — ${sizeStr} — Created: ${createdDiscordTime}`;
    });

    embed.setDescription(descriptionLines.join('\n'));
    return embed;
  }

  const buildRow = () =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('zip_prev')
        .setLabel('⬅️ Back')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId('zip_next')
        .setLabel('➡️ Next')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page + 1 === totalPages),
    );

  const message = await interaction.reply({
    embeds: [createEmbed()],
    components: [buildRow()],
    flags: MessageFlags.Ephemeral,
    fetchReply: true,
  });

  const collector = message.createMessageComponentCollector({ time: 60000 });

  collector.on('collect', async i => {
    if (i.user.id !== interaction.user.id) {
      await i.reply({ content: 'Only you can navigate pages!', flags: MessageFlags.Ephemeral });
      return;
    }
    if (i.customId === 'zip_prev' && page > 0) page--;
    if (i.customId === 'zip_next' && page < totalPages - 1) page++;

    await i.update({
      embeds: [createEmbed()],
      components: [buildRow()],
    });
  });

  collector.on('end', () => {
    message.edit({ components: [] }).catch(() => { });
  });
}


// --- slash command data ---
export const data = new SlashCommandBuilder()
  .setName('zipline')
  .setDescription('Zipline commands')
  .addSubcommand(sub =>
    sub.setName('settoken')
      .setDescription('Set your Zipline API token')
      .addStringOption(opt =>
        opt.setName('token').setDescription('Your token').setRequired(true),
      ),
  )
  .addSubcommand(sub => sub.setName('me').setDescription('Show your account info'))
  .addSubcommand(sub => sub.setName('list').setDescription('List your uploads'))
  .addSubcommand(sub =>
    sub.setName('upload')
      .setDescription('Upload a file')
      .addAttachmentOption(opt =>
        opt.setName('file').setDescription('File to upload').setRequired(true),
      ),
  )
  .addSubcommand(sub => sub.setName('settings').setDescription('Manage your default upload settings'))
  .addSubcommand(sub => sub.setName('logout').setDescription('Delete token (logout)'))
  .addSubcommand(sub => sub.setName('invite').setDescription('Show bot invite link'))
  .addSubcommand(sub => sub.setName('about').setDescription('Info about the bot and its commands'))
  .addSubcommand(sub => sub.setName('stats').setDescription('Show host/server resource usage, Zipline stats, and your storage usage'))
  .addSubcommand(sub => sub.setName('help').setDescription('Link to the documentation'))
  .addSubcommand(sub => sub.setName('status').setDescription('Check Zipline instance status'));


// --- main execute(interaction) ---
export async function execute(interaction) {
  const userId = interaction.user.id;
  const sub = interaction.options.getSubcommand(true);

  try {
    if (sub === 'settoken') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const token = interaction.options.getString('token', true);
      const validation = await validateZiplineToken(token);

      if (validation.valid) {
        setUserToken(userId, token);
        const botUserId = ensureAssignBotUserId(userId);
        const embed = new EmbedBuilder()
          .setTitle('✅ Token Valid & Saved!')
          .setDescription(
            `**User:** ${validation.user}\n` +
            `**Role:** ${validation.role}\n` +
            `**Storage:** ${validation.quota.used}/${validation.quota.max}`,
          )
          .addFields(
            { name: '🔗 Zipline', value: `[Open Dashboard](${ZIPLINE_BASE_URL})`, inline: true },
            { name: '🆔 Bot User ID', value: String(botUserId), inline: true },
          )
          .setColor(0x00ff00)
          .setThumbnail(interaction.user.displayAvatarURL({ extension: 'png', size: 1024 }));
        await interaction.editReply({ embeds: [embed] });
      } else {
        const embed = new EmbedBuilder()
          .setTitle('❌ Invalid Token')
          .setDescription(`**Error:** ${validation.error}`)
          .addFields(
            { name: '💡 Tip', value: `Get your token from ${ZIPLINE_BASE_URL}/dashboard`, inline: false },
            { name: '🔗', value: `[Zipline Dashboard](${ZIPLINE_BASE_URL})`, inline: true },
          )
          .setColor(0xff0000)
          .setThumbnail(interaction.user.displayAvatarURL({ extension: 'png', size: 1024 }));
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
      const inviteLink = `https://discord.com/oauth2/authorize?client_id=${interaction.client.user.id}`;
      await interaction.reply({ content: `🤖 Invite me using this link:\n${inviteLink}`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === 'about') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let botVersion = 'unknown';
      try {
        const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
        botVersion = packageJson.version || 'unknown';
      } catch { /* ignore */ }

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
        { key: 'stats', label: '📊', desc: 'Show host/server resource usage, Zipline stats, and your storage usage' },
      ];
      const commandsList = subcommands
        .map(sc => `${sc.label} </zipline ${sc.key}:${commandId}> — ${sc.desc}`)
        .join('\n');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Support')
          .setStyle(ButtonStyle.Link)
          .setURL('https://discord.fish/support')
          .setEmoji('⛑️'),
        new ButtonBuilder()
          .setLabel('GitHub')
          .setStyle(ButtonStyle.Link)
          .setURL('https://github.com/MrStuffmaker/zipline-bot')
          .setEmoji('💻'),
        new ButtonBuilder()
          .setLabel('Website')
          .setStyle(ButtonStyle.Link)
          .setURL('https://ziplinebot.pawpatrol.dev')
          .setEmoji('💻'),
      );

      await interaction.editReply({
        content: `💡 **Zipline Bot v${botVersion}**\n\n${commandsList}`,
        components: [row],
      });
      return;
    }

    if (sub === 'help') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Zipline')
          .setStyle(ButtonStyle.Link)
          .setURL('https://zipline.diced.sh/docs')
          .setEmoji('📚'),
        new ButtonBuilder()
          .setLabel('Bot Docs')
          .setStyle(ButtonStyle.Link)
          .setURL('https://ziplinebot.pawpatrol.dev/docs')
          .setEmoji('⛑️'),
      );

      await interaction.reply({
        content: 'Need help? Check out the documentation below\n\nIf you need anything else you are invites to join our support server\nhttps://discord.gg/9rr2uRZbuV.',
        components: [row],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (sub === 'status') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const info = await ziplineGetVersion();


      const embed = new EmbedBuilder()
        .setTitle(info.online ? '✅ Zipline Online' : '❌ Zipline Offline')
        .setColor(info.online ? (info.statusCode === 200 ? 0x00ff00 : 0xffaa00) : 0xff0000)
        .addFields(
          { name: 'Status Code', value: `[${info.statusCode || 'N/A'}](https://stuffmaker.org/pages/http-info#${info.statusCode})`, inline: true },
          { name: 'Version', value: String(info.version || 'N/A'), inline: true }
        );

      if (info.error) {
        embed.addFields({ name: 'Error', value: String(info.error), inline: false });
      }

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === 'settings') {
      const settings = getUserSettings(userId);
      const embed = new EmbedBuilder()
        .setTitle('⚙️ User Settings')
        .setDescription('Manage your default upload settings')
        .addFields(
          { name: '📅 Expiry', value: settings.expiry ? `\`${settings.expiry}\`` : 'Not set', inline: true },
          { name: '🗜️ Compression', value: settings.compression ? `\`${settings.compression}\`` : 'Not set', inline: true },
        )
        .setColor(0x00b0ff)
        .setFooter({ text: 'Click a button below to edit settings' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('zip_edit_expiry')
          .setLabel('Edit Expiry')
          .setEmoji('📅')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('zip_edit_compression')
          .setLabel('Edit Compression')
          .setEmoji('🗜️')
          .setStyle(ButtonStyle.Secondary),
      );

      await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
      return;
    }

    // commands that require token
    const token = getUserToken(userId);
    if (!token && ['me', 'list', 'upload', 'stats'].includes(sub)) {
      await interaction.reply({
        content: `❗ Please set your token first using </zipline settoken:1441450591409668117>.\n🔗 Zipline URL: ${ZIPLINE_BASE_URL}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'me') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const data = await ziplineGetMe(token);
      const botUserId = getBotUserId(userId) || ensureAssignBotUserId(userId);

      let userStorage = 0;
      try {
        const zipStats = await ziplineGetStats();
        if (zipStats.filesUsers && Array.isArray(zipStats.filesUsers)) {
          const userFileData = zipStats.filesUsers.find(u => u.username === (data.username || ''));
          if (userFileData) userStorage = userFileData.storage || 0;
        }
      } catch { /* ignore */ }

      const quota = data.quota || null;
      const formatStorageLocal = bytes => {
        if (!bytes || bytes === 0) return '0 MB';
        const mb = bytes / (1024 * 1024);
        if (mb > 1024) return (mb / 1024).toFixed(2) + ' GB';
        return mb.toFixed(2) + ' MB';
      };

      const storageDisplay =
        quota && typeof quota.used !== 'undefined' && typeof quota.max !== 'undefined'
          ? `${formatStorageLocal(quota.used)} / ${quota.max}`
          : formatStorageLocal(userStorage || 0);

      const embed = new EmbedBuilder()
        .setTitle('👤 Account Info')
        .addFields(
          { name: 'Username', value: data.username || 'Unknown', inline: true },
          { name: 'Role', value: data.role || 'Unknown', inline: true },
          { name: '🆔 Bot User ID', value: String(botUserId), inline: true },
          { name: '📦 Storage', value: storageDisplay, inline: false },
        )
        .setColor(0x00ff00);

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === 'list') {
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
      if (userToken) {
        const uploadResp = await ziplineUploadFromUrl(userToken, attachment.url, attachment.name, userId);
        const urls = (uploadResp.files || [])
          .map(f => f.url || `${ZIPLINE_BASE_URL}/u/${f.id}`)
          .join('\n');

        const embed = new EmbedBuilder()
          .setTitle('✅ Upload Successful')
          .setDescription(`**[Click the link to view your upload](${urls})**`)
          .setColor(0x00ff00);

        await interaction.editReply({ embeds: [embed] });
      } else {
        const uploadResp = await ziplineAnonUploadFromUrl(attachment.url, attachment.name);
        const urls = (uploadResp.files || [])
          .map(f => f.url || `${ANON_ZIPLINE_BASE_URL}/u/${f.id}`)
          .join('\n');

        const embed = new EmbedBuilder()
          .setTitle('✅ Guest Upload Successful')
          .setDescription(`**[Click the link to view your upload](${urls})**`)
          .addFields(
            ANON_UPLOAD_EXPIRY
              ? { name: '⏱ Expiry', value: `This file is set to expire after: \`${ANON_UPLOAD_EXPIRY}\``, inline: false }
              : { name: '⏱ Expiry', value: 'No default expiry configured.', inline: false },
          )
          .setColor(0x00ff00);

        await interaction.editReply({ embeds: [embed] });
      }
      return;
    }

    if (sub === 'stats') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const hostStats = {
        os: getReadableOSName(),
        uptime: os.uptime(),
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        usedMem: process.memoryUsage().rss,
        cpuCount: os.cpus().length,
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

      let userStorage = 0;
      if (zipStats.filesUsers && Array.isArray(zipStats.filesUsers)) {
        const userFileData = zipStats.filesUsers.find(u => u.username === userMe.username);
        if (userFileData) userStorage = userFileData.storage || 0;
      }

      const uptimeSeconds = hostStats.uptime;
      const days = Math.floor(uptimeSeconds / 86400);
      const hours = Math.floor((uptimeSeconds % 86400) / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const uptimeDisplay = `${days}d/${String(hours).padStart(2, '0')}h/${String(minutes).padStart(2, '0')}m`;

      const formatStorage = bytes => {
        const mb = bytes / (1024 * 1024);
        if (mb > 1024) return (mb / 1024).toFixed(2) + ' GB';
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
            inline: true,
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
            inline: true,
          },
          {
            name: `👤 ${userMe.username ?? 'Unknown'}`,
            value: `**Used:** ${userStorageDisplay}`,
            inline: false,
          },
        )
        .setColor(0x5865f2);

      await interaction.editReply({ embeds: [embed] });
    }
  } catch (error) {
    logError(error, 'zipline.execute');
    throw error;
  }
}


// --- components & modal handler used by interactionCreate.js ---
export async function handleComponents(interaction) {
  try {
    const userId = interaction.user.id;

    if (interaction.isButton() &&
      (interaction.customId === 'zip_edit_expiry' || interaction.customId === 'zip_edit_compression')) {

      const modal = new ModalBuilder()
        .setCustomId(interaction.customId)
        .setTitle(interaction.customId === 'zip_edit_expiry' ? 'Expiry (days/date)' : 'Compression level');

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('value_input')
            .setLabel(
              interaction.customId === 'zip_edit_expiry'
                ? 'Enter expiry (e.g. 7d or 2025-01-01)'
                : 'Enter compression (e.g. low, medium)',
            )
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(45),
        ),
      );

      await interaction.showModal(modal);
      return true;
    }

    if (
      interaction.type === InteractionType.ModalSubmit &&
      (interaction.customId === 'zip_edit_expiry' || interaction.customId === 'zip_edit_compression')
    ) {
      const value = interaction.fields.getTextInputValue('value_input');
      if (interaction.customId === 'zip_edit_expiry') {
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
          { name: '🗜️ Compression', value: updatedSettings.compression ? `\`${updatedSettings.compression}\`` : 'Not set', inline: true },
        )
        .setColor(0x00ff88)
        .setFooter({ text: 'These settings apply to all future uploads.' });

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return true;
    }

    return false;
  } catch (error) {
    logError(error, 'zipline.handleComponents');
    throw error;
  }
}


// --- context menu / message upload handler ---
export async function handleMessageUpload(interaction) {
  try {
    const userId = interaction.user.id;
    const target = interaction.targetMessage;

    let fileUrl = null;
    let filename = null;

    // attachments (preferred)
    if (target.attachments && target.attachments.size > 0) {
      const attachment = target.attachments.first();
      fileUrl = attachment.url;
      filename = attachment.name || null;
    }

    // embeds
    if (!fileUrl && target.embeds && target.embeds.length > 0) {
      for (const e of target.embeds) {
        if (e.image && e.image.url) { fileUrl = e.image.url; break; }
        if (e.thumbnail && e.thumbnail.url) { fileUrl = e.thumbnail.url; break; }
        if (e.url) { fileUrl = e.url; break; }
      }
    }

    // plain text URLs
    if (!fileUrl && target.content) {
      const m = target.content.match(/https?:\/\/[^\s<>)"']+/i);
      if (m) fileUrl = m[0];
    }

    if (!fileUrl) {
      await interaction.reply({
        content: '❗️ This message has no attachments or recognised URLs to upload.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // derive filename
    if (!filename) {
      try {
        const parsed = new URL(fileUrl);
        const base = path.basename(parsed.pathname) || '';
        filename = decodeURIComponent(base) || `file_${Date.now()}`;
      } catch {
        filename = `file_${Date.now()}`;
      }
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const userToken = getUserToken(userId);
    let lastUpdate = 0;

    const onProgress = async (uploaded, total) => {
      const now = Date.now();
      if (now - lastUpdate < 3000 && uploaded < total) return; // limit updates to every 3s
      lastUpdate = now;

      const percentage = Math.floor((uploaded / total) * 100);
      const filled = Math.floor(percentage / 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

      try {
        await interaction.editReply({
          content: `⏳ Uploading... [${bar}] ${percentage}%`,
          flags: MessageFlags.Ephemeral
        });
      } catch (e) {
        // ignore edit errors (e.g. unknown interaction if too slow)
      }
    };

    let uploadResp;
    if (userToken) {
      uploadResp = await ziplineUploadFromUrl(userToken, fileUrl, filename, userId, onProgress);
    } else {
      uploadResp = await ziplineAnonUploadFromUrl(fileUrl, filename, onProgress);
    }

    const urls = (uploadResp.files || [])
      .map(f => f.url || `${(userToken ? ZIPLINE_BASE_URL : ANON_ZIPLINE_BASE_URL)}/u/${f.id}`)
      .join('\n');

    const embed = new EmbedBuilder()
      .setTitle(userToken ? '✅ Upload Successful' : '✅ Guest Upload Successful')
      .setDescription(`**[Click the link to view your upload](${urls})**`)
      .setColor(0x00ff00);

    if (!userToken) {
      embed.addFields(
        ANON_UPLOAD_EXPIRY
          ? { name: '⏱ Expiry', value: `This file is set to expire after: \`${ANON_UPLOAD_EXPIRY}\``, inline: false }
          : { name: '⏱ Expiry', value: 'No default expiry configured.', inline: false },
      );
    }

    await interaction.editReply({ content: null, embeds: [embed] });
    return;
  } catch (error) {
    logError(error, 'zipline.handleMessageUpload');
    let msg = error instanceof Error ? error.message : String(error);
    if (msg.length > 1900) msg = msg.substring(0, 1900) + '... (truncated)';

    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content: `❌ Upload failed: ${msg}`, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: `❌ Upload failed: ${msg}`, flags: MessageFlags.Ephemeral });
      }
    } catch (e) {
      logError(e, 'zipline.handleMessageUpload.reply');
    }
    return;
  }
}

export {
  ZIPLINE_BASE_URL,
  ANON_ZIPLINE_BASE_URL,
  ANON_UPLOAD_EXPIRY,
  getReadableOSName,
};

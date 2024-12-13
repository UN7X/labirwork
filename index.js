require('dotenv').config();
const { Client, Events, GatewayIntentBits, SlashCommandBuilder, REST, Routes, PermissionFlagsBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, VoiceConnectionStatus, EndBehaviorType } = require('@discordjs/voice');
const WebSocket = require('ws');
const { Readable } = require('stream');
const prism = require('prism-media');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BOT_OWNER_ID = process.env.BOT_OWNER_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

let ws;
let connection;
let audioPlayer;
let currentAudioStream;
let voice_mode_enabled = false;
let ai_instructions = "You are a helpful AI. Respond as instructed.";

function isBotOwner(userId) {
  return userId === BOT_OWNER_ID;
}

function isGuildOwnerOrManager(interaction) {
  if (!interaction.guild) return false;
  if (interaction.user.id === interaction.guild.ownerId) return true;
  if (isBotOwner(interaction.user.id)) return true;
  return interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
}

// Commands
const commands = [
  new SlashCommandBuilder()
    .setName('actlike')
    .setDescription('Set how the AI should act (restricted).')
    .addStringOption(option =>
      option.setName('style')
        .setDescription('A short description of how the AI should act.')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('experiments')
    .setDescription('Configure experimental features (owner only).')
    .addBooleanOption(option =>
      option.setName('voice_mode')
        .setDescription('Enable or disable voice mode.')
    ),
  new SlashCommandBuilder()
    .setName('connect')
    .setDescription('Connects the bot to your current voice channel (if voice-mode enabled).'),
  new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('Disconnects the bot from the current voice channel'),
];

client.once(Events.ClientReady, async () => {
  console.log('bot starting up');
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    console.log('registering slash commands');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('bot is ready');
  }
  catch (error) {
    console.log('Error registering slash commands', error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  console.log(`received /${interaction.commandName} command`);

  try {
    if (interaction.commandName === 'actlike') {
      // Only guild owner, managers or bot owner can use this
      if (!isGuildOwnerOrManager(interaction)) {
        await interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
        return;
      }
      const style = interaction.options.getString('style', true);
      ai_instructions = style;
      await interaction.reply({ content: `AI acting style changed to: ${style}`, ephemeral: true });

    } else if (interaction.commandName === 'experiments') {
      // Owner only
      if (!isBotOwner(interaction.user.id)) {
        await interaction.reply({ content: "Only the bot owner can use this command.", ephemeral: true });
        return;
      }
      const voiceMode = interaction.options.getBoolean('voice_mode');
      if (voiceMode !== null) {
        voice_mode_enabled = voiceMode;
      }
      await interaction.reply({ content: `Experiments updated. Voice mode is now ${voice_mode_enabled ? 'enabled' : 'disabled'}.`, ephemeral: true });

    } else if (interaction.commandName === 'connect') {
      // Reply quickly and then proceed
      if (!voice_mode_enabled) {
        await interaction.reply({ content: "Voice mode is disabled.", ephemeral: true });
        return;
      }
      const userChannel = interaction.member.voice.channel;
      if (!userChannel) {
        await interaction.reply({ content: 'You need to be in a voice channel first!', ephemeral: true });
        return;
      }
      await interaction.reply({ content: 'Connecting to your voice channel...', ephemeral: true });

      connection = joinVoiceChannel({
        channelId: userChannel.id,
        guildId: userChannel.guild.id,
        adapterCreator: userChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
      });

      connection.on(VoiceConnectionStatus.Ready, async () => {
        console.log('connected to voice channel');
        // Since we've already replied, we won't reply again here.
        try { await startListening(); } catch (error) { console.log('error: startListening() broke', error); }
        try { await startConversation(); } catch (error) { console.log('error: startConversation() broke', error); }
      });

      connection.on('error', (error) => {
        console.log('error: voice connection', error);
      });

    } else if (interaction.commandName === 'disconnect') {
      await interaction.reply({ content: 'Disconnecting...', ephemeral: true });
      await disconnectChannel();
      // Interaction replied, no more replies needed
    }

  } catch (error) {
    console.log('error handling interaction:', error);
    // If an error occurs after reply, do not attempt another reply.
  }
});

// Respond if bot is mentioned or replied to
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const botMention = `<@${client.user.id}>`;
  if (message.mentions.has(client.user) || (message.reference && (await message.channel.messages.fetch(message.reference.messageId)).author.id === client.user.id)) {
    // Just a simple response
    await message.channel.send(`Hello, ${message.author}! You mentioned me?`);
  }
});

async function startListening() {
  console.log('listening to voice channel');
  const receiver = connection.receiver;
  
  receiver.speaking.on('start', async (userId) => {
    try {
      const user = client.users.cache.get(userId);
      if (!user) return;
      console.log(`${user.username} started speaking`);

      if (audioPlayer) {
        audioPlayer.stop();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'response.cancel' }));
        }
      }

      const userRawStream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 500
        }
      });

      const userPCMStream = userRawStream.pipe(new prism.opus.Decoder({ rate: 24000, channels: 1, frameSize: 960 }));

      let chunks = [];
      userPCMStream.on('data', (chunk) => {
        chunks.push(chunk);
      });

      userPCMStream.on('end', async () => {
        console.log(`${user.username} stopped speaking`);
        if (ws && ws.readyState === WebSocket.OPEN) {
          const base64Audio = Buffer.concat(chunks).toString('base64');
          await sendAudioBufferToWebSocket(base64Audio);
          ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          ws.send(JSON.stringify({ type: 'response.create' }));
        }
      });
    }
    catch (error) { console.log('error: mishandling speaking event', error); }
  });
}

async function startConversation() {
  console.log('connecting to OpenAI websocket');

  if (!audioPlayer) {
    audioPlayer = createAudioPlayer();
    console.log('connected to audio stream');
    audioPlayer.on('stateChange', (oldState, newState) => {
      if (oldState.status !== newState.status) {
        if (newState.status === 'playing') { console.log('Bot started speaking'); }
        else if (newState.status === 'idle') { console.log('Bot finished speaking'); }
      }
    });
  }

  ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
    headers: {
      "Authorization": "Bearer " + OPENAI_API_KEY,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  ws.on('open', () => {
    console.log('openai: websocket connected');
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        instructions: `${ai_instructions}\nToday's date is ${new Date().toDateString()}. You don't know anything after October 2023.`,
        voice: 'echo'
      }
    }));
  });

  ws.on('message', async (message) => {
    const response = JSON.parse(message.toString());

    if (response.type === "response.audio.delta") {
      try {
        const audioChunk = Buffer.from(response.delta, 'base64');
        if (currentAudioStream) { currentAudioStream.push(audioChunk); }
        else {
          currentAudioStream = new Readable({ read() {} });
          const ffmpeg = new prism.FFmpeg({
            args: ['-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '1']
          });
          const pcmStream = currentAudioStream.pipe(ffmpeg);
          const opusEncoder = new prism.opus.Encoder({ rate: 48000, channels: 1, frameSize: 960 });
          const opusStream = pcmStream.pipe(opusEncoder);
          const resource = createAudioResource(opusStream);

          connection.subscribe(audioPlayer);
          audioPlayer.play(resource);

          currentAudioStream.push(audioChunk);
        }
      }
      catch (error) { console.log('error: failure to process audio delta response', error); }
    } 
    else if (response.type === "response.audio.done") {
      if (currentAudioStream) {
        currentAudioStream.push(null);
        currentAudioStream = null;
      }
    }
    else if (response.type === 'error') {
      console.log('openai error:', response.error.message);
    }
  });

  ws.on('error', (error) => {
    console.log('openai: websocket error', error);
  });

  ws.on('close', () => {
    console.log('openai: websocket disconnected');
    ws = null;
    disconnectChannel();
  });
}

async function sendAudioBufferToWebSocket(base64Chunk) {
  if (base64Chunk.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: base64Chunk
      }));
    }
    catch (error) { console.log('error: websocket audio buffer problem', error); }
  }
  else { console.log('error: websocket is not open or audio buffer is empty'); }
}

async function disconnectChannel() {
  if (ws) {
    console.log('warning: disconnecting websocket');
    ws.close();
    ws = null;
  }
  else { console.log('warning: no active websocket'); }
  if (connection) {
    console.log('warning: disconnecting from voice');
    connection.destroy();
    connection = null;
    audioPlayer = null;
  }
  else { console.log('warning: no active voice connection'); }
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

async function shutdown() {
  console.log('bot shutting down');
  await disconnectChannel();
  await client.destroy();
  process.exit(0);
}

console.log('logging in to discord');
client.login(DISCORD_TOKEN);

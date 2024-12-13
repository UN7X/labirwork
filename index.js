require('dotenv').config();
const { Client, Events, GatewayIntentBits, SlashCommandBuilder, REST, Routes, PermissionFlagsBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, VoiceConnectionStatus, EndBehaviorType } = require('@discordjs/voice');
const WebSocket = require('ws');
const { Readable } = require('stream');
const prism = require('prism-media');

// Load environment variables
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
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

// Globals
let ws;
let connection;
let audioPlayer;
let currentAudioStream;
let voice_mode_enabled = false;
let ai_instructions = "You are a helpful AI. Respond as instructed.";

// Permission checks
function isBotOwner(userId) {
  return userId === BOT_OWNER_ID;
}

function isGuildOwnerOrManager(interaction) {
  if (!interaction.guild) return false;
  if (interaction.user.id === interaction.guild.ownerId) return true;
  if (isBotOwner(interaction.user.id)) return true;
  return interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
}

// Setup commands
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
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('connect')
    .setDescription('Connects the bot to your current voice channel (if voice-mode enabled).'),
  new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('Disconnects the bot from the current voice channel'),
];

// Register commands when ready
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

// Interaction Handler
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isCommand()) return;
  console.log(`received /${interaction.commandName} command`);

  try {
    if (interaction.commandName === 'actlike') {
      // Check permissions: guild owner, manager, or bot owner
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
      await interaction.deferReply({ ephemeral: true });
      if (!voice_mode_enabled) {
        await interaction.editReply("Voice mode is disabled.");
        return;
      }
      const userChannel = interaction.member.voice.channel;
      if (!userChannel) {
        await interaction.editReply('You need to be in a voice channel to use this command!');
        return;
      }

      connection = joinVoiceChannel({
        channelId: userChannel.id,
        guildId: userChannel.guild.id,
        adapterCreator: userChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
      });

      connection.on(VoiceConnectionStatus.Ready, async () => {
        console.log('connected to voice channel');
        try { await interaction.editReply('Connected to voice channel!'); } catch (e) { console.log(e); }
        try { await startListening(); } catch (error) { console.log('error: startListening() broke', error); }
        try { await startConversation(); } catch (error) { console.log('error: startConversation() broke', error); }
      });

      connection.on(VoiceConnectionStatus.Disconnected, () => {
        console.log('disconnected from voice');
      });

      connection.on('error', (error) => {
        console.log('error: issue with voice connectivity', error);
      });

    } else if (interaction.commandName === 'disconnect') {
      await interaction.deferReply({ ephemeral: true });
      await disconnectChannel();
      await interaction.editReply('Disconnected from the voice channel.');
    }
  } catch (error) {
    console.log('error: mishandling discord interaction', error);
    if (!interaction.replied && !interaction.deferred) {
      try { await interaction.reply({ content: 'An error occurred.', ephemeral: true }); }
      catch (replyError) { console.log('error: could not send interaction reply', replyError); }
    }
  }
});

// Handling voice and OpenAI logic
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

async function startListening() {
  console.log('listening to voice channel');
  const receiver = connection.receiver;
  
  receiver.speaking.on('start', async (userId) => {
    try {
      const user = client.users.cache.get(userId);
      if (user) {
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
            duration: 500 // ms
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
      else { console.log('error: discord api issue'); }
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
        voice: 'echo' // you can change the voice here
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
      try {
        if (currentAudioStream) {
          currentAudioStream.push(null);
          currentAudioStream = null;
        }
      }
      catch (error) { console.log('error: failure to process audio done response', error); }
    }
    else if (response.type === 'error') {
      console.log('openai:', response.error.message);
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

async function disconnectChannel() {
  if (ws) {
    console.log('warning: disconnecting websocket');
    ws.close();
    ws = null;
  } else {
    console.log('warning: no active websocket');
  }
  if (connection) {
    console.log('warning: disconnecting from voice');
    connection.destroy();
    connection = null;
    audioPlayer = null;
  } else {
    console.log('warning: no active voice connection');
  }
}

// Shutdown gracefully
const shutdown = async () => {
  console.log('');
  console.log('bot shutting down');
  await disconnectChannel();
  await client.destroy();
  process.exit(0);
};

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

console.log('logging in to discord');
client.login(DISCORD_TOKEN);

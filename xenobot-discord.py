
import os
import asyncio

from collections import defaultdict, deque

try:
  import openai
  import discord
except ImportError:
  os.system("pip install openai discord.py")
# === XENOBOT-72 SETUP INSTRUCTIONS ===
#
# This code outlines a Discord bot using discord.py (v1.x or v2.x)
# and OpenAI's API for GPT-like responses. It listens to messages,
# checks if it's mentioned or replied to, and then responds using
# GPT. It maintains a short per-user message history (up to 3 messages).
#
# Before running this code, ensure you have:
# 1. Installed discord.py (pip install discord.py)
# 2. Installed openai (pip install openai)
# 3. Set your Discord bot token and OpenAI API key as environment variables
#    DISCORD_BOT_TOKEN and OPENAI_API_KEY, or replace them directly below.
#
# The "AI_INSTRUCTIONS" is already set. But, you can replace it with 
# your desired role instructions and system messages to get the
# behavior you want.

TOKEN = os.getenv("DISCORD_BOT_TOKEN", "YOUR_DISCORD_BOT_TOKEN_HERE")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "YOUR_OPENAI_API_KEY_HERE")

# Template instructions for the GPT model.
# Replace this content with your desired instructions. 
# For example, instructions might include: "You are a roleplaying as a... from a..."
AI_INSTRUCTIONS = (
  "SYSTEM PROMPT: You are a helpful, roleplaying AI. Respond as instructed.\n"
  "User will send messages. You must reply as if you are a specific character.\n"
  "...\n" # Insert your instructions here
)

intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)

openai.api_key = OPENAI_API_KEY

# We will store recent user messages in a dictionary keyed by user_id.
# Each value will be a deque holding the last 3 messages from that user.
user_histories = defaultdict(lambda: deque(maxlen=3))

@client.event
async def on_ready():
    print(f'Logged in as {client.user}')
    for guild in client.guilds:
        # You can specify a specific channel by name or ID
        # Here, we are sending the message to the first text channel in the guild
        for channel in guild.text_channels:
            if channel.permissions_for(guild.me).send_messages:
                await channel.send('Hello!')
                break

@client.event
async def on_message(message):
  # Ignore messages from the bot itself
  if message.author == client.user:
    return

  # Check if the bot is mentioned or if the message is a reply to the bot
  # Conditions:
  # 1. If the message mentions the bot
  # 2. If the message is a reply to the bot
  mentioned = client.user.mentioned_in(message)
  replying_to_bot = (message.reference is not None and 
                     message.reference.resolved is not None and 
                     message.reference.resolved.author == client.user)

  if mentioned or replying_to_bot:
    # Store the user's latest message in their history
    user_id = message.author.id
    user_histories[user_id].append(message.content)

    # up to 3 of the user's last messages
    user_messages = list(user_histories[user_id])

    # Construct a prompt for the AI model
    # We use a simple role+user message format. 
    # The system sets the instructions, user messages follow.
    messages_for_model = [
      {"role": "system", "content": AI_INSTRUCTIONS}
    ]

    for m in user_messages:
      messages_for_model.append({"role": "user", "content": m})

    response = openai.ChatCompletion.create(
      model="gpt-4o-mini",
      messages=messages_for_model,
      temperature=0.7,
      max_tokens=2000
    )

    reply = response.choices[0].message.content.strip()

    await message.channel.send(reply)

client.run(TOKEN)

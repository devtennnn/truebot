require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase Client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Initialize Discord Bot Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ]
});

// Define Slash Commands
const commands = [
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check your TRUE Community coin balance and rank'),
  
  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Claim your daily 50 coin reward bonus'),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View the richest players in TRUE Community'),

  new SlashCommandBuilder()
    .setName('task')
    .setDescription('Complete daily community tasks (login, share, chat)')
    .addStringOption(option =>
      option.setName('action')
        .setDescription('The task to complete')
        .setRequired(true)
        .addChoices(
          { name: 'Login today (+10 coins)', value: 'login' },
          { name: 'Share Community (+30 coins)', value: 'share' },
          { name: 'Chat in Room (+10 coins)', value: 'chat' }
        )
    )
].map(command => command.toJSON());

client.once('ready', async () => {
  console.log(`🤖 TRUE Bot is online as ${client.user.tag}!`);

  // Register Slash Commands to Discord
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  try {
    console.log('🔄 Refreshing application (/) commands...');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands },
    );
    console.log('✅ Successfully reloaded application commands.');
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  // Use Discord user ID as the database key
  const userId = interaction.user.id;
  const username = interaction.user.username;
  const avatarUrl = interaction.user.displayAvatarURL({ extension: 'png' });

  try {
    // Ensure user profile exists in Supabase so foreign keys match wallets
    await supabase.from('profiles').upsert({
      id: userId,
      username: username,
      avatar_url: avatarUrl,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id', ignoreDuplicates: false });

    if (commandName === 'balance') {
      await interaction.deferReply();
      const { data, error } = await supabase.rpc('get_wallet');
      
      // Fallback if rpc fails or wallet row doesn't exist yet
      let coins = 0;
      if (!error && data) {
        coins = data.coins || 0;
      } else {
        const { data: wData } = await supabase.from('wallets').select('coins').eq('user_id', userId).maybeSingle();
        if (wData) coins = wData.coins;
      }

      const embed = new EmbedBuilder()
        .setColor('#2dce89')
        .setTitle(`🪙 TRUE Community Wallet`)
        .setThumbnail(avatarUrl)
        .addFields(
          { name: 'Member', value: `<@${userId}>`, inline: true },
          { name: 'Total Coins', value: `**${coins} 🪙**`, inline: true }
        )
        .setFooter({ text: 'TRUE Community • Play & Earn' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });

    } else if (commandName === 'daily') {
      await interaction.deferReply();
      const { data, error } = await supabase.rpc('claim_reward', { p_task: 'daily' });

      if (error) {
        const errMsg = error.message.includes('already claimed') 
          ? '❌ You have already claimed your daily bonus today! Come back tomorrow.' 
          : `❌ Could not claim reward: ${error.message}`;
        return interaction.editReply({ content: errMsg });
      }

      const embed = new EmbedBuilder()
        .setColor('#fbbf24')
        .setTitle('🎁 Daily Reward Claimed!')
        .setDescription(`Successfully claimed your daily bonus of **+50 🪙**!`)
        .addFields({ name: 'New Balance', value: `**${data.coins} 🪙**` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });

    } else if (commandName === 'leaderboard') {
      await interaction.deferReply();
      const { data, error } = await supabase.rpc('top_coins', { p_limit: 10 });

      if (error || !data || data.length === 0) {
        return interaction.editReply({ content: '📊 No leaderboard rankings found yet.' });
      }

      const listStr = data.map((row, index) => {
        const medals = ['👑', '🥈', '🥉'];
        const rankPrefix = medals[index] || `\`#${index + 1}\``;
        return `${rankPrefix} **${row.username}** — **${row.coins} 🪙**`;
      }).join('\n');

      const embed = new EmbedBuilder()
        .setColor('#2dce89')
        .setTitle('🏆 TRUE Community Richest Players')
        .setDescription(listStr)
        .setFooter({ text: 'Updated live from Supabase database' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });

    } else if (commandName === 'task') {
      await interaction.deferReply();
      const taskName = interaction.options.getString('action');

      // 1. Mark task completed
      const { error: compError } = await supabase.rpc('complete_task', { p_task: taskName });
      if (compError) {
        return interaction.editReply({ content: `❌ Error processing task: ${compError.message}` });
      }

      // 2. Claim task reward
      const { data, error: claimError } = await supabase.rpc('claim_reward', { p_task: taskName });
      if (claimError) {
        const msg = claimError.message.includes('already claimed')
          ? '⚠️ You already completed and claimed this task today!'
          : `❌ Error claiming task: ${claimError.message}`;
        return interaction.editReply({ content: msg });
      }

      const rewardsMap = { login: 10, share: 30, chat: 10 };
      const earned = rewardsMap[taskName] || 10;

      const embed = new EmbedBuilder()
        .setColor('#2dce89')
        .setTitle('✅ Task Completed!')
        .setDescription(`You completed the **${taskName}** task and earned **+${earned} 🪙**!`)
        .addFields({ name: 'New Balance', value: `**${data.coins} 🪙**` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    }

  } catch (err) {
    console.error('Command execution error:', err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ An unexpected error occurred while running this command.' });
    } else {
      await interaction.reply({ content: '❌ An unexpected error occurred while running this command.', ephemeral: true });
    }
  }
});

// Log in the bot using your Discord Token
client.login(process.env.DISCORD_BOT_TOKEN);

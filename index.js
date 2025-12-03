import "dotenv/config";
import express from "express";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ActivityType
} from "discord.js";
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, entersState, VoiceConnectionStatus } from "@discordjs/voice";
import ytdl from "ytdl-core";

// ---------- ENV ----------
const TOKEN = process.env.DISCORD_TOKEN;
const SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID;
const APP_ID = process.env.APP_ID;
const GUILD_ID = process.env.GUILD_ID;
const INVOICE_LOG_ID = "1444496474690813972";
const MOD_LOG_ID = "1444845107084787722";
const ALT_CHANNEL_ID = process.env.ALT_CHANNEL_ID || "1445548929943998694";
const ALT_NOTIFY_ROLE_ID = process.env.ALT_NOTIFY_ROLE_ID || "1445544529888411840";
const LEAVE_LOG_CHANNEL_ID = "1445549973566652590";

// ---------- CLIENT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// ---------- STORAGE ----------
const invoices = {};
const warnings = {};
const kicks = {};
const bans = {};
const unbans = {};
let altDays = 7;
const memberRoleSnapshots = {};
const altPinged = new Set();
const globalBanList = new Set();

// ---------- MUSIC QUEUES ----------
// ---------- MUSIC QUEUES ----------
const queues = new Map(); // guildId => { connection, player, songs[] }

const playSong = async (interaction, url) => {
  const voiceChannel = interaction.member.voice.channel;
  if(!voiceChannel) return replyInteraction(interaction, "❌ You must be in a voice channel to play music!");

  const permissions = voiceChannel.permissionsFor(interaction.client.user);
  if(!permissions.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak))
    return replyInteraction(interaction, "❌ I need permissions to join and speak!");

  let queue = queues.get(interaction.guildId);
  const song = { url, requestedBy: interaction.user.tag };

  // Check if the URL is valid
  if(!ytdl.validateURL(url)) return replyInteraction(interaction, "❌ Invalid YouTube URL.");

  if(!queue){
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      preferredEncryptionModes: ["aead_aes256_gcm_rtpsize", "aead_xchacha20_poly1305_rtpsize"]
    });

    // Wait until connection is ready or destroy it
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20000);
    } catch(err) {
      console.error("Voice connection failed:", err);
      connection.destroy();
      return replyInteraction(interaction, "❌ Failed to join voice channel.");
    }

    const player = createAudioPlayer();

    // Catch player errors
    player.on("error", error => {
      console.error(`Audio player error: ${error.message}`);
      // Remove song from queue to prevent blocking
      if(queue && queue.songs.length > 0) queue.songs.shift();
      if(queue && queue.songs.length > 0) playNext(queue);
    });

    connection.subscribe(player);

    queue = { connection, player, songs: [] };
    queues.set(interaction.guildId, queue);

    // Function to play next song in queue
const playNext = async (queueObj) => {
  if(!queueObj || !queueObj.songs.length){
    queueObj?.connection.destroy();
    queues.delete(interaction.guildId);
    return;
  }

  const nextSong = queueObj.songs[0];
  let resource;

  try {
    // Wrap ytdl in a try/catch to handle removed/deleted videos
    resource = createAudioResource(
      ytdl(nextSong.url, {
        filter: "audioonly",
        highWaterMark: 1 << 25,
        quality: "highestaudio",
      }),
      { inputType: StreamType.Arbitrary }
    );
  } catch(err) {
    console.error(`Failed to play ${nextSong.url}:`, err.message);
    queueObj.songs.shift(); // remove the bad song
    return playNext(queueObj); // try the next song
  }

  queueObj.player.play(resource);

  // Optional: listen for player errors (just in case)
  queueObj.player.once("error", err => {
    console.error(`Audio player error for ${nextSong.url}:`, err.message);
    queueObj.songs.shift(); // remove the failed song
    playNext(queueObj); // play next
  });
};

const skipSong = interaction => {
  const queue = queues.get(interaction.guildId);
  if(!queue || !queue.songs.length) return replyInteraction(interaction, "❌ No songs to skip.");
  queue.songs.shift(); // Remove current song
  if(queue.songs.length > 0){
    const next = queue.songs[0];
    const resource = createAudioResource(ytdl(next.url, { filter: 'audioonly', highWaterMark: 1<<25 }), { inputType: StreamType.Arbitrary });
    queue.player.play(resource);
  } else {
    queue.connection.destroy();
    queues.delete(interaction.guildId);
  }
  return replyInteraction(interaction, "⏭ Skipped current track.");
};

const pauseSong = interaction => {
  const queue = queues.get(interaction.guildId);
  if(!queue) return replyInteraction(interaction, "❌ No song is currently playing.");
  queue.player.pause();
  return replyInteraction(interaction, "⏸ Music paused.");
};

const resumeSong = interaction => {
  const queue = queues.get(interaction.guildId);
  if(!queue) return replyInteraction(interaction, "❌ No song is currently playing.");
  queue.player.unpause();
  return replyInteraction(interaction, "▶ Music resumed.");
};

const stopSong = interaction => {
  const queue = queues.get(interaction.guildId);
  if(!queue) return replyInteraction(interaction, "❌ No song is currently playing.");
  queue.connection.destroy();
  queues.delete(interaction.guildId);
  return replyInteraction(interaction, "⏹ Music stopped.");
};

const nowPlaying = interaction => {
  const queue = queues.get(interaction.guildId);
  if(!queue || !queue.songs.length) return replyInteraction(interaction, "❌ No song currently playing.");
  return replyInteraction(interaction, `🎵 Now playing: ${queue.songs[0].url} (requested by ${queue.songs[0].requestedBy})`);
};

const showQueue = interaction => {
  const queue = queues.get(interaction.guildId);
  if(!queue || !queue.songs.length) return replyInteraction(interaction, "❌ Queue is empty.");
  const list = queue.songs.map((s,i) => `${i+1}. ${s.url} (requested by ${s.requestedBy})`).join("\n");
  return replyInteraction(interaction, `🎶 Current Queue:\n${list}`);
};

// ---------- HELPERS ----------
const millisToDays = ms => ms / (24 * 60 * 60 * 1000);
const isAltAccount = member => member?.user ? (Date.now() - member.user.createdTimestamp) < altDays * 24 * 60 * 60 * 1000 : false;

const createEmbed = ({ title, description, color="#3498db", user=null, fields=[], footer }) => {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description || "No description")
    .setColor(color)
    .setTimestamp();
  if(user) embed.setThumbnail(user.displayAvatarURL({ dynamic: true }));
  if(fields.length) embed.addFields(...fields);
  if(footer) embed.setFooter({ text: footer });
  return embed;
};

const replyInteraction = async (interaction, payload) => {
  try {
    if(!interaction) return;
    if(interaction.replied || interaction.deferred){
      if(typeof payload === "string") return interaction.followUp({ content: payload }).catch(()=>{});
      if(payload?.embeds) return interaction.followUp({ embeds: payload.embeds }).catch(()=>{});
      return;
    }
    if(typeof payload === "string") return interaction.reply({ content: payload }).catch(()=>{});
    if(payload?.embeds) return interaction.reply({ embeds: payload.embeds }).catch(()=>{});
    return interaction.reply({ content: "✅ Done." }).catch(()=>{});
  } catch(err){ console.error("replyInteraction error:", err); }
};

const saveMemberSnapshot = async member => {
  try {
    const g = member.guild.id;
    if(!memberRoleSnapshots[g]) memberRoleSnapshots[g] = {};
    const roleIDs = member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.id);
    const roleNames = member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.name);
    memberRoleSnapshots[g][member.id] = { roles: roleNames, roleIDs, joinedAt: member.joinedAt?.getTime() || null, cachedAt: Date.now() };
  } catch(err){ console.error(err); }
};

const handleAltDetection = async member => {
  try {
    if(!member?.guild || !isAltAccount(member)) return;
    if(altPinged.has(member.id)) return;

    altPinged.add(member.id);
    const roles = member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.name).join(", ") || "None";
    const accountAgeDays = Math.floor(millisToDays(Date.now() - member.user.createdTimestamp));

    const embed = createEmbed({
      title: "⚠️ Possible Alt Account Detected",
      description: `A possible alt account was detected — ${member.user.tag}`,
      color: "#ff0000",
      user: member.user,
      fields: [
        { name:"Username", value: member.user.tag, inline:true },
        { name:"Discord ID", value: member.user.id, inline:true },
        { name:"Account Created", value: new Date(member.user.createdTimestamp).toLocaleString(), inline:true },
        { name:"Server Joined", value: member.joinedAt?.toLocaleString() || "Just joined", inline:true },
        { name:"Current Roles", value: roles, inline:false },
        { name:"Why flagged", value: `Account age ${accountAgeDays} day(s) — under threshold (${altDays} days).`, inline:false }
      ],
      footer: "Alt Detection Audit ⚠️"
    });

    const channel = await client.channels.fetch(ALT_CHANNEL_ID).catch(()=>null);
    if(channel) channel.send({ content:`<@&${ALT_NOTIFY_ROLE_ID}> — ⚠️ Possible alt detected`, embeds:[embed] }).catch(()=>{});
  } catch(err){ console.error(err); }
};

// ---------- SLASH COMMANDS ----------
const commands = [
  // Invoices
  new SlashCommandBuilder().setName("invoice").setDescription("Send a payment invoice")
    .addUserOption(opt => opt.setName("user").setDescription("User to invoice").setRequired(true))
    .addIntegerOption(opt => opt.setName("amount").setDescription("Amount").setRequired(true))
    .addStringOption(opt => opt.setName("description").setDescription("Product description").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("viewinvoice").setDescription("View an invoice by ID")
    .addIntegerOption(opt => opt.setName("id").setDescription("Invoice ID").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("deleteinvoice").setDescription("Delete an invoice by ID")
    .addIntegerOption(opt => opt.setName("id").setDescription("Invoice ID").setRequired(true)).toJSON(),

  // Moderation
  new SlashCommandBuilder().setName("warn").setDescription("Warn a user")
    .addUserOption(opt => opt.setName("user").setDescription("User to warn").setRequired(true))
    .addStringOption(opt => opt.setName("reason").setDescription("Reason").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("kick").setDescription("Kick a user")
    .addUserOption(opt => opt.setName("user").setDescription("User to kick").setRequired(true))
    .addStringOption(opt => opt.setName("reason").setDescription("Reason")).toJSON(),
  new SlashCommandBuilder().setName("ban").setDescription("Ban a user")
    .addUserOption(opt => opt.setName("user").setDescription("User to ban").setRequired(true))
    .addStringOption(opt => opt.setName("reason").setDescription("Reason")).toJSON(),
  new SlashCommandBuilder().setName("addrole").setDescription("Add a role to a user")
    .addUserOption(opt => opt.setName("user").setDescription("User").setRequired(true))
    .addRoleOption(opt => opt.setName("role").setDescription("Role").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("removerole").setDescription("Remove a role from a user")
    .addUserOption(opt => opt.setName("user").setDescription("User").setRequired(true))
    .addRoleOption(opt => opt.setName("role").setDescription("Role").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("purgeroles").setDescription("Remove all roles from a user")
    .addUserOption(opt => opt.setName("user").setDescription("User to purge").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("setaltdays").setDescription("Set alt detection days")
    .addIntegerOption(opt => opt.setName("days").setDescription("Days").setRequired(true)).toJSON(),

  // Music
  new SlashCommandBuilder().setName("play").setDescription("Play music in your voice channel")
    .addStringOption(opt => opt.setName("url").setDescription("YouTube URL").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("skip").setDescription("Skip current track").toJSON(),
  new SlashCommandBuilder().setName("pause").setDescription("Pause current track").toJSON(),
  new SlashCommandBuilder().setName("resume").setDescription("Resume current track").toJSON(),
  new SlashCommandBuilder().setName("stop").setDescription("Stop music and leave").toJSON(),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Show current song").toJSON(),
  new SlashCommandBuilder().setName("queue").setDescription("Show current music queue").toJSON()
];

// ---------- REGISTER COMMANDS ----------
(async () => {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try{
    console.log("Registering guild commands...");
    await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
    console.log("✅ Commands registered!");
  } catch(err){ console.error("Failed registering commands:", err); }
})();

// ---------- EVENTS ----------
client.on("ready", () => {
  console.log(`🤖 Bot online as ${client.user.tag}`);
  client.user.setActivity("Fisher Fabrications..", { type: ActivityType.Watching });
});

client.on("guildMemberAdd", async member => { await saveMemberSnapshot(member); await handleAltDetection(member); });

// ---------- INTERACTION HANDLER ----------
client.on("interactionCreate", async interaction => {
  try{
    if(!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;
    const user = interaction.options.getUser("user");
    const role = interaction.options.getRole("role");

    switch(cmd){
      // Music
      case "play": return playSong(interaction, interaction.options.getString("url"));
      case "skip": return skipSong(interaction);
      case "pause": return pauseSong(interaction);
      case "resume": return resumeSong(interaction);
      case "stop": return stopSong(interaction);
      case "nowplaying": return nowPlaying(interaction);
      case "queue": return showQueue(interaction);

      // Invoices
      case "invoice": {
        if(!interaction.member.roles.cache.has(SUPPORT_ROLE_ID)) return replyInteraction(interaction,"❌ No permission.");
        const amount = interaction.options.getInteger("amount");
        const desc = interaction.options.getString("description");
        const invoiceID = Math.floor(1000 + Math.random()*9000);
        invoices[invoiceID] = { userID:user.id, issuerID:interaction.user.id, product:desc, amount, status:"Pending", createdAt:Date.now() };
        return replyInteraction(interaction, `✅ Invoice #${invoiceID} created.`);
      }
      case "viewinvoice": {
        const id = interaction.options.getInteger("id");
        const invoice = invoices[id];
        if(!invoice) return replyInteraction(interaction,"❌ Invoice not found.");
        return replyInteraction(interaction, `🧾 Invoice #${id}\nCustomer: <@${invoice.userID}>\nAmount: ${invoice.amount}\nDescription: ${invoice.product}\nStatus: ${invoice.status}`);
      }
      case "deleteinvoice": {
        const id = interaction.options.getInteger("id");
        if(!invoices[id]) return replyInteraction(interaction,"❌ Invoice not found.");
        delete invoices[id];
        return replyInteraction(interaction, `🗑️ Invoice #${id} deleted.`);
      }

      // Moderation
      case "warn": {
        const reason = interaction.options.getString("reason");
        if(!warnings[user.id]) warnings[user.id] = [];
        warnings[user.id].push(reason);
        return replyInteraction(interaction, `⚠️ ${user.tag} has been warned for: ${reason}`);
      }
      case "kick": {
        const reason = interaction.options.getString("reason") || "No reason provided";
        if(user && user.kick) await user.kick(reason);
        if(!kicks[user.id]) kicks[user.id] = [];
        kicks[user.id].push({ by: interaction.user.id, reason });
        return replyInteraction(interaction, `👢 ${user.tag} has been kicked.`);
      }
      case "ban": {
        const reason = interaction.options.getString("reason") || "No reason provided";
        if(user && user.ban) await user.ban({ reason });
        if(!bans[user.id]) bans[user.id] = [];
        bans[user.id].push({ by: interaction.user.id, reason });
        return replyInteraction(interaction, `⛔ ${user.tag} has been banned.`);
      }
      case "addrole": {
        if(user && role) await interaction.guild.members.cache.get(user.id).roles.add(role);
        return replyInteraction(interaction, `✅ Added role ${role.name} to ${user.tag}`);
      }
      case "removerole": {
        if(user && role) await interaction.guild.members.cache.get(user.id).roles.remove(role);
        return replyInteraction(interaction, `✅ Removed role ${role.name} from ${user.tag}`);
      }
      case "purgeroles": {
        if(user){
          const memberObj = interaction.guild.members.cache.get(user.id);
          await memberObj.roles.set([]);
          return replyInteraction(interaction, `✅ All roles removed from ${user.tag}`);
        }
      }

      // Alt
      case "setaltdays": {
        altDays = interaction.options.getInteger("days");
        return replyInteraction(interaction, `✅ Alt detection set to ${altDays} days`);
      }

      default: return replyInteraction(interaction,"❌ Unknown command.");
    }
  } catch(err){ console.error(err); replyInteraction(interaction,"❌ Something went wrong."); }
});

client.on("ready", () => {
  console.log(`🤖 Bot online as ${client.user.tag}`);
  client.user.setActivity("Fisher Fabrications..", { type: ActivityType.Watching });
});

// ---------- EXPRESS KEEP-ALIVE ----------
const app = express();
app.get("/",(req,res)=>res.send("Bot is running!"));
app.listen(process.env.PORT || 3000,()=>console.log("✔ Web server running"));

// ---------- LOGIN ----------
client.login(TOKEN);

import "dotenv/config";
import express from "express";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits
} from "discord.js";

// ---------- ENV ----------
const TOKEN = process.env.DISCORD_TOKEN;
const SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID;
const APP_ID = process.env.APP_ID;
const GUILD_ID = process.env.GUILD_ID;
const INVOICE_LOG_ID = process.env.INVOICE_LOG_ID || "1444496474690813972";
const MOD_LOG_ID = process.env.MOD_LOG_ID || "1444845107084787722";
const ALT_CHANNEL_ID = process.env.ALT_CHANNEL_ID || "1445548929943998694";
const ALT_NOTIFY_ROLE_ID = process.env.ALT_NOTIFY_ROLE_ID || "1445544529888411840";
const LEAVE_LOG_CHANNEL_ID = process.env.LEAVE_LOG_CHANNEL_ID || "1445549973566652590";

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
const invoices = {};          // invoiceID => { userID, issuerID, product, amount, status, channelID, messageID, createdAt }
const warnings = {};          // userID => [reason1, reason2]
let altDays = 7;
const memberRoleSnapshots = {}; // guildId => userId => { roles, roleIDs, joinedAt, cachedAt }
const altPinged = new Set(); // prevent double pinging for alts
const globalBanList = new Set();

// ---------- HELPERS ----------
const millisToDays = ms => ms / (24 * 60 * 60 * 1000);
const isAltAccount = member => member?.user ? (Date.now() - member.user.createdTimestamp) < altDays * 24 * 60 * 60 * 1000 : false;

// Standard embed creator
const createAuditEmbed = ({ title, description, color="#3498db", user=null, extraFields=[], footerText }) => {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description || "No description")
    .setColor(color)
    .setTimestamp()
    .setFooter({ text: footerText || "Audit Log" });
  if(user) embed.setThumbnail(user.displayAvatarURL({ dynamic: true }));

  if(extraFields.length) embed.addFields(...extraFields);

  return embed;
};

// Specialized invoice embed
const createInvoiceAuditEmbed = (invoice, customer, issuer) => {
  return createAuditEmbed({
    title: `🧾 Invoice #${invoice.id}`,
    description: `A new invoice has been issued:`,
    color: "#3498db",
    user: customer,
    extraFields: [
      { name: "💰 Amount", value: `$${invoice.amount}`, inline:true },
      { name: "📝 Product / Description", value: invoice.product, inline:false },
      { name: "👤 Customer", value: customer ? customer.tag : invoice.userID, inline:true },
      { name: "🆔 Customer ID", value: invoice.userID, inline:true },
      { name: "👮 Issued By", value: issuer ? issuer.tag : invoice.issuerID, inline:true },
      { name: "🆔 Issuer ID", value: invoice.issuerID, inline:true },
      { name: "📅 Date", value: new Date(invoice.createdAt).toLocaleString(), inline:false }
    ],
    footerText: "Invoice Audit"
  });
};

// Reply helper
const replyInteraction = async (interaction, payload) => {
  try {
    if(!interaction) return;
    if(interaction.replied || interaction.deferred) {
      if(typeof payload === "string") return interaction.followUp({ content: payload }).catch(()=>{});
      if(payload?.embeds) return interaction.followUp({ embeds: payload.embeds }).catch(()=>{});
      return;
    }
    if(typeof payload === "string") return interaction.reply({ content: payload }).catch(()=>{});
    if(payload?.embeds) return interaction.reply({ embeds: payload.embeds }).catch(()=>{});
    return interaction.reply({ content: "✅ Done." }).catch(()=>{});
  } catch(err){ console.error("replyInteraction error:", err); }
};

// Member snapshots
const saveMemberSnapshot = async member => {
  try {
    const g = member.guild.id;
    if(!memberRoleSnapshots[g]) memberRoleSnapshots[g] = {};
    const roleIDs = member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.id);
    const roleNames = member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.name);
    memberRoleSnapshots[g][member.id] = {
      roles: roleNames,
      roleIDs,
      joinedAt: member.joinedAt?.getTime() || null,
      cachedAt: Date.now()
    };
  } catch(err){ console.error("saveMemberSnapshot error:", err); }
};

// Alt detection
const handleAltDetection = async member => {
  try {
    if(!member?.guild || !isAltAccount(member)) return;
    const alreadyPinged = altPinged.has(member.id);

    const roles = member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.name).join(", ") || "None";
    const accountAgeDays = Math.floor(millisToDays(Date.now() - member.user.createdTimestamp));
    const embed = createAuditEmbed({
      title: "⚠️ Possible Alt Account Detected",
      description: `A possible alt account was detected — ${member.user.tag}`,
      color: "#ff0000",
      user: member.user,
      extraFields: [
        { name:"Username", value: member.user.tag, inline:true },
        { name:"Discord ID", value: member.user.id, inline:true },
        { name:"Account Created", value: new Date(member.user.createdTimestamp).toLocaleString(), inline:true },
        { name:"Server Joined", value: member.joinedAt?.toLocaleString() || "Just joined", inline:true },
        { name:"Current Roles", value: roles, inline:false },
        { name:"Why flagged", value: `Account age ${accountAgeDays} day(s) — under threshold (${altDays} days).`, inline:false }
      ],
      footerText: "Alt Detection Audit"
    });

    const channel = await client.channels.fetch(ALT_CHANNEL_ID).catch(()=>null);
    if(!channel) return;
    if(!alreadyPinged){
      altPinged.add(member.id);
      await channel.send({ content:`<@&${ALT_NOTIFY_ROLE_ID}> — ⚠️ Possible alt detected`, embeds:[embed] }).catch(()=>{});
    } else await channel.send({ embeds:[embed] }).catch(()=>{});
  } catch(err){ console.error("handleAltDetection error:", err); }
};

// ---------- SLASH COMMANDS ----------
const commands = [
  new SlashCommandBuilder().setName("invoice").setDescription("Send a payment invoice")
    .addUserOption(opt => opt.setName("user").setDescription("User to invoice").setRequired(true))
    .addIntegerOption(opt => opt.setName("amount").setDescription("Amount").setRequired(true))
    .addStringOption(opt => opt.setName("description").setDescription("Product description").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder().setName("deleteinvoice").setDescription("Delete an invoice by ID")
    .addIntegerOption(opt => opt.setName("id").setDescription("Invoice ID").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder().setName("viewinvoice").setDescription("View an invoice by its ID")
    .addIntegerOption(opt => opt.setName("id").setDescription("Invoice ID").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder().setName("warn").setDescription("Warn a user")
    .addUserOption(opt => opt.setName("user").setDescription("User to warn").setRequired(true))
    .addStringOption(opt => opt.setName("reason").setDescription("Reason").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder().setName("kick").setDescription("Kick a user")
    .addUserOption(opt => opt.setName("user").setDescription("User to kick").setRequired(true))
    .addStringOption(opt => opt.setName("reason").setDescription("Reason"))
    .toJSON(),

  new SlashCommandBuilder().setName("ban").setDescription("Ban a user")
    .addUserOption(opt => opt.setName("user").setDescription("User to ban").setRequired(true))
    .addStringOption(opt => opt.setName("reason").setDescription("Reason"))
    .toJSON(),

  new SlashCommandBuilder().setName("addrole").setDescription("Add a role to a user")
    .addUserOption(opt => opt.setName("user").setDescription("User").setRequired(true))
    .addRoleOption(opt => opt.setName("role").setDescription("Role").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder().setName("removerole").setDescription("Remove a role from a user")
    .addUserOption(opt => opt.setName("user").setDescription("User").setRequired(true))
    .addRoleOption(opt => opt.setName("role").setDescription("Role").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder().setName("purgeroles").setDescription("Remove all roles from a user")
    .addUserOption(opt => opt.setName("user").setDescription("User to purge").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder().setName("setaltdays").setDescription("Set alt detection days")
    .addIntegerOption(opt => opt.setName("days").setDescription("Days").setRequired(true))
    .toJSON(),

  // 🔥 Custom Fun / Utility Commands
  new SlashCommandBuilder().setName("hug").setDescription("Hug a user")
    .addUserOption(opt => opt.setName("user").setDescription("User to hug").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder().setName("slap").setDescription("Slap a user")
    .addUserOption(opt => opt.setName("user").setDescription("User to slap").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder().setName("say").setDescription("Bot says a message")
    .addStringOption(opt => opt.setName("message").setDescription("Message to send").setRequired(true))
    .toJSON()
];

// ---------- REGISTER COMMANDS ----------
(async () => {
  const rest = new REST({ version:"10" }).setToken(TOKEN);
  try {
    console.log("Registering guild commands...");
    await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
    console.log("✅ Commands registered!");
  } catch(err){ console.error("Failed registering commands:", err); }
})();

// ---------- EVENTS ----------
client.on("ready", () => {
  console.log(`🤖 Bot online as ${client.user.tag}`);
});

// Member join / update / leave
client.on("guildMemberAdd", async member => { await saveMemberSnapshot(member); await handleAltDetection(member); });
client.on("guildMemberUpdate", async (oldM, newM) => { 
  /* Add role audit log similar style here */ 
});
client.on("guildMemberRemove", async member => { 
  /* Leave log embed similar style here */ 
});

// Interaction handler
client.on("interactionCreate", async interaction => {
  try {
    if(!interaction.isChatInputCommand()) return;

    const cmd = interaction.commandName;
    const logInvoice = client.channels.cache.get(INVOICE_LOG_ID);
    const logMod = client.channels.cache.get(MOD_LOG_ID);
    const user = interaction.options.getUser("user");

    switch(cmd){
      case "invoice":
      case "deleteinvoice":
      case "viewinvoice":
      case "warn":
      case "kick":
      case "ban":
      case "addrole":
      case "removerole":
      case "purgeroles":
      case "setaltdays":
        // Handlers from previous code (as rewritten above)
        break;

      case "hug": {
        return replyInteraction(interaction, `🤗 ${interaction.user.tag} hugs ${user.tag}!`);
      }
      case "slap": {
        return replyInteraction(interaction, `💥 ${interaction.user.tag} slaps ${user.tag}!`);
      }
      case "say": {
        const msg = interaction.options.getString("message");
        return replyInteraction(interaction, msg);
      }
      default: return replyInteraction(interaction,"❌ Unknown command.");
    }

  } catch(err){ console.error("interactionCreate handler error:", err); try{replyInteraction(interaction,"❌ Something went wrong.");}catch{} }
});

// ---------- EXPRESS KEEP-ALIVE ----------
const app = express();
app.get("/", (req,res)=>res.send("Bot is running!"));
app.listen(process.env.PORT || 3000, ()=>console.log("✔ Web server running"));

// ---------- LOGIN ----------
client.login(TOKEN);

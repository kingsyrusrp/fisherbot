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
const invoices = {};          // invoiceID => { userID, issuerID, product, amount, status, channelID, messageID, createdAt }
const warnings = {};          // userID => [reason1, reason2]
let altDays = 7;
const memberRoleSnapshots = {}; // guildId => userId => { roles, roleIDs, joinedAt, cachedAt }
const altPinged = new Set(); // prevent double pinging for alts
const globalBanList = new Set();

// ---------- HELPERS ----------
const millisToDays = ms => ms / (24 * 60 * 60 * 1000);

const isAltAccount = member => member?.user ? (Date.now() - member.user.createdTimestamp) < altDays * 24 * 60 * 60 * 1000 : false;

const createEmbed = ({ title, description, color = "#3498db", extra, footer }) => {
  const embed = new EmbedBuilder().setTitle(title).setDescription(description || "No description").setColor(color).setTimestamp();
  if (extra) embed.addFields({ name: "Extra Info", value: extra });
  if (footer) embed.setFooter({ text: footer });
  return embed;
};

const replyInteraction = async (interaction, payload) => {
  try {
    if (!interaction) return;
    if (interaction.replied || interaction.deferred) {
      if (typeof payload === "string") return interaction.followUp({ content: payload }).catch(()=>{});
      if (payload?.embeds) return interaction.followUp({ embeds: payload.embeds }).catch(()=>{});
      return;
    }
    if (typeof payload === "string") return interaction.reply({ content: payload }).catch(()=>{});
    if (payload?.embeds) return interaction.reply({ embeds: payload.embeds }).catch(()=>{});
    return interaction.reply({ content: "✅ Done." }).catch(()=>{});
  } catch (err) { console.error("replyInteraction error:", err); }
};

const saveMemberSnapshot = async member => {
  try {
    const g = member.guild.id;
    if (!memberRoleSnapshots[g]) memberRoleSnapshots[g] = {};
    const roleIDs = member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.id);
    const roleNames = member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.name);
    memberRoleSnapshots[g][member.id] = {
      roles: roleNames,
      roleIDs,
      joinedAt: member.joinedAt?.getTime() || null,
      cachedAt: Date.now()
    };
  } catch (err) { console.error("saveMemberSnapshot error:", err); }
};

const handleAltDetection = async member => {
  try {
    if (!member?.guild || !isAltAccount(member)) return;
    const alreadyPinged = altPinged.has(member.id);

    const roles = member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.name).join(", ") || "None";
    const accountAgeDays = Math.floor(millisToDays(Date.now() - member.user.createdTimestamp));
    const embed = new EmbedBuilder()
      .setTitle("⚠️ Possible Alt Account Detected")
      .setColor("#ff0000")
      .setDescription(`A possible alt account was detected — ${member.user.tag}`)
      .addFields(
        { name: "Username", value: member.user.tag, inline: true },
        { name: "Discord ID", value: member.user.id, inline: true },
        { name: "Account Created", value: new Date(member.user.createdTimestamp).toLocaleString(), inline: true },
        { name: "Server Joined", value: member.joinedAt?.toLocaleString() || "Just joined", inline: true },
        { name: "Current Roles", value: roles, inline: false },
        { name: "Why flagged", value: `Account age ${accountAgeDays} day(s) — under threshold (${altDays} days).`, inline: false }
      )
      .setTimestamp();

    const channel = await client.channels.fetch(ALT_CHANNEL_ID).catch(()=>null);
    if (!channel) return console.warn("ALT_CHANNEL_ID not found. Skipping alt alert send.");
    if (!alreadyPinged) {
      altPinged.add(member.id);
      await channel.send({ content: `<@&${ALT_NOTIFY_ROLE_ID}> — ⚠️ Possible alt detected`, embeds: [embed] }).catch(()=>{});
    } else await channel.send({ embeds: [embed] }).catch(()=>{});
  } catch (err) { console.error("handleAltDetection error:", err); }
};

// ---------- SLASH COMMANDS ----------
const commands = [
  new SlashCommandBuilder().setName("invoice").setDescription("Send a payment invoice")
    .addUserOption(opt => opt.setName("user").setDescription("User to invoice").setRequired(true))
    .addIntegerOption(opt => opt.setName("amount").setDescription("Amount").setRequired(true))
    .addStringOption(opt => opt.setName("description").setDescription("Product description").setRequired(true))
    .toJSON(),
  new SlashCommandBuilder().setName("deleteinvoice").setDescription("Delete an invoice by ID")
    .addIntegerOption(opt => opt.setName("id").setDescription("Invoice ID").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("setaltdays").setDescription("Set alt detection days")
    .addIntegerOption(opt => opt.setName("days").setDescription("Days").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("userinfo").setDescription("Get user information")
    .addUserOption(opt => opt.setName("user").setDescription("The user").setRequired(true)).toJSON(),
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
  new SlashCommandBuilder()
  .setName("viewinvoice")
  .setDescription("View an invoice by its ID")
  .addIntegerOption(opt => opt
    .setName("id")
    .setDescription("The invoice ID")
    .setRequired(true))
  .toJSON()

];

// ---------- REGISTER COMMANDS ----------
(async () => {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log("Registering guild commands...");
    await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
    console.log("✅ Commands registered!");
  } catch (err) { console.error("Failed registering commands:", err); }
})();

// ---------- EVENTS ----------
client.on("ready", () => {
  console.log(`🤖 Bot online as ${client.user.tag}`);
  setInterval(() => {
    for (const [id, invoice] of Object.entries(invoices)) {
      if (invoice.status === "pending") {
        client.users.fetch(invoice.userID).then(u => u?.send(`Reminder: Invoice #${id} for **${invoice.product}** is still pending.`).catch(()=>{})).catch(()=>{});
      }
    }
  }, 3600 * 1000);
});

// Member tracking
client.on("guildMemberAdd", async member => { await saveMemberSnapshot(member); await handleAltDetection(member); });

client.on("guildMemberUpdate", async (oldM, newM) => {
  try {
    const oldRoles = oldM.roles.cache.map(r => r.id).join(",");
    const newRoles = newM.roles.cache.map(r => r.id).join(",");
    if (oldRoles !== newRoles) {
      await saveMemberSnapshot(newM);
      const removed = oldM.roles.cache.filter(r => !newM.roles.cache.has(r.id)).map(r => r.name);
      const added = newM.roles.cache.filter(r => !oldM.roles.cache.has(r.id)).map(r => r.name);
      if ((removed.length || added.length) && client.channels.cache.get(MOD_LOG_ID)) {
        const embed = new EmbedBuilder()
          .setTitle("🔁 Member Roles Updated")
          .setColor("#3498db")
          .setDescription(`${newM.user.tag} (${newM.id})`)
          .addFields({ name: "Added Roles", value: added.length ? added.join(", ") : "None", inline: false }, { name: "Removed Roles", value: removed.length ? removed.join(", ") : "None", inline: false })
          .setTimestamp();
        client.channels.cache.get(MOD_LOG_ID).send({ embeds: [embed] }).catch(()=>{});
      }
    }
  } catch (err) { console.error("guildMemberUpdate error:", err); }
});

// Leave logging with buttons
client.on("guildMemberRemove", async member => {
  try {
    const g = member.guild.id;
    const snapshot = memberRoleSnapshots[g]?.[member.id];
    const roles = snapshot?.roles?.join(", ") || (member.roles?.cache?.map(r => r.name).join(", ") || "None");
    const joinedAt = snapshot?.joinedAt ? new Date(snapshot.joinedAt).toLocaleString() : member.joinedAt?.toLocaleString() || "Unknown";
    const accountCreated = new Date(member.user.createdTimestamp).toLocaleString();
    const isAlt = isAltAccount(member);
    const incidentId = `leave-${member.id}-${Date.now()}`;
    const embed = new EmbedBuilder()
      .setTitle(isAlt ? "⚠️ Member Left — Possible Alt" : "🚨 Member Left — Role Snapshot")
      .setColor(isAlt ? "#ff3b30" : "#ff7f50")
      .setDescription(`A member has left — review the snapshot and take action if necessary.`)
      .addFields(
        { name: "Username", value: member.user.tag, inline: true },
        { name: "Discord ID", value: member.user.id, inline: true },
        { name: "Account Created", value: accountCreated, inline: true },
        { name: "Joined Server", value: joinedAt, inline: true },
        { name: "Roles (when last seen)", value: roles, inline: false },
        { name: "Incident ID", value: incidentId, inline: false },
        { name: "Flagged as Alt?", value: isAlt ? `Yes — Account age under ${altDays} day(s)` : "No", inline: false }
      )
      .setFooter({ text: "Use the buttons to take action — staff only" })
      .setTimestamp();

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`terminate-${member.id}-${Date.now()}`).setLabel("Terminate User").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`globalban-${member.id}-${Date.now()}`).setLabel("Global Ban").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ack-${member.id}-${Date.now()}`).setLabel("Acknowledge").setStyle(ButtonStyle.Primary)
    );

    const leaveLogChannel = await client.channels.fetch(LEAVE_LOG_CHANNEL_ID).catch(()=>null);
    if (leaveLogChannel) await leaveLogChannel.send({ embeds: [embed], components: [buttons] });
  } catch (err) { console.error("guildMemberRemove error:", err); }
});

// Interaction handler
client.on("interactionCreate", async interaction => {
  try {
    if (!interaction) return;
    const logInvoice = client.channels.cache.get(INVOICE_LOG_ID);
    const logMod = client.channels.cache.get(MOD_LOG_ID);

    // BUTTONS
    if (interaction.isButton()) {
      const [action, targetId] = interaction.customId.split("-");
      const member = interaction.member;
      const hasSupport = member?.roles.cache?.has(SUPPORT_ROLE_ID);
      const hasBanPerm = member?.permissions?.has(PermissionFlagsBits.BanMembers);

      if (["terminate","terminateAlt"].includes(action)) {
        if (!hasSupport && !hasBanPerm) return replyInteraction(interaction, "❌ You don't have permission.");
        await interaction.guild.bans.create(targetId, { reason: `Terminated by ${interaction.user.tag}` }).catch(()=>{});
        if (logMod) logMod.send({ embeds: [createEmbed({ title: "🛑 Terminate Executed", description: `User <@${targetId}> banned.`, color: "#c0392b", footer: `Action by ${interaction.user.tag}` })] }).catch(()=>{});
        return replyInteraction(interaction, `✅ User <@${targetId}> banned.`);
      }

      if (["globalban","globalbanAlt"].includes(action)) {
        if (!hasSupport && !hasBanPerm) return replyInteraction(interaction, "❌ You don't have permission.");
        globalBanList.add(targetId);
        return replyInteraction(interaction, `✅ Global ban recorded for <@${targetId}>.`);
      }

      if (["ack","ackAlt"].includes(action)) {
        const msg = interaction.message;
        if (msg?.embeds?.[0]) {
          const e = EmbedBuilder.from(msg.embeds[0]).setFooter({ text: `Acknowledged by ${interaction.user.tag}` }).setColor("#2ecc71");
          await msg.edit({ embeds: [e], components: [] }).catch(()=>{});
        }
        if (logMod) logMod.send({ embeds: [createEmbed({ title: "✅ Incident Acknowledged", description: `Acknowledged by ${interaction.user.tag}`, color: "#2ecc71" })] }).catch(()=>{});
        return replyInteraction(interaction, "✅ Acknowledged.");
      }

      return replyInteraction(interaction, "❌ Unknown button action.");
    }

    // SLASH COMMANDS
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;
    const user = interaction.options.getUser("user");

    switch(cmd){
      case "invoice": {
        if (!interaction.member.roles.cache.has(SUPPORT_ROLE_ID)) return replyInteraction(interaction, "❌ No permission.");
        const amount = interaction.options.getInteger("amount");
        const desc = interaction.options.getString("description");
        const invoiceID = Math.floor(1000 + Math.random()*9000);
        const channel = interaction.channel;
        if(channel) channel.setName(`invoice-${invoiceID}`).catch(()=>{});

        const embed = createEmbed({ title:`🧾 Invoice #${invoiceID}`, description:`Invoice for **${desc}**`, extra:`Customer: ${user.tag}\nIssuer: ${interaction.user.tag}\nAmount: $${amount}\nStatus: Pending\nPayment Options: Venmo | Paypal | CashApp` });
        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`complete-${invoiceID}`).setLabel("Mark Completed").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`deliver-${invoiceID}`).setLabel("Mark Delivered").setStyle(ButtonStyle.Success)
        );
        const message = await channel.send({ content: `<@${user.id}>`, embeds: [embed], components: [buttons] }).catch(()=>null);
        invoices[invoiceID] = { userID: user.id, issuerID: interaction.user.id, product: desc, amount, status:"pending", channelID: channel.id, messageID: message?.id, createdAt: Date.now() };
        if(logInvoice) logInvoice.send({ embeds: [embed] }).catch(()=>{});
        return replyInteraction(interaction, `✅ Invoice #${invoiceID} created.`);
      }
      case "deleteinvoice": {
        const id = interaction.options.getInteger("id");
        const invoice = invoices[id];
        if(!invoice) return replyInteraction(interaction,"❌ Invoice not found");
        if(invoice.channelID && invoice.messageID){
          const ch = await client.channels.fetch(invoice.channelID).catch(()=>null);
          const msg = ch ? await ch.messages.fetch(invoice.messageID).catch(()=>null) : null;
          if(msg) await msg.delete().catch(()=>{});
        }
        delete invoices[id];
        if(logInvoice) logInvoice.send({ embeds: [createEmbed({ title:`🗑️ Invoice #${id} Deleted`, description:`Deleted by ${interaction.user.tag}`, color:"#e74c3c" })] }).catch(()=>{});
        return replyInteraction(interaction, `✅ Invoice #${id} deleted`);
      }
      case "setaltdays": { altDays = interaction.options.getInteger("days"); return replyInteraction(interaction, `✅ Alt detection set to ${altDays} days`); }
      case "warn": {
        const reason = interaction.options.getString("reason");
        if(!warnings[user.id]) warnings[user.id] = [];
        warnings[user.id].push(reason);
        if(logMod) logMod.send({ embeds:[createEmbed({ title:"⚠️ User Warned", description:`${user.tag} warned by ${interaction.user.tag}\nReason: ${reason}`, color:"#f39c12" })] }).catch(()=>{});
        return replyInteraction(interaction, `✅ ${user.tag} has been warned`);
      }
        case "viewinvoice": {
  const id = interaction.options.getInteger("id");
  const invoice = invoices[id];

  if (!invoice) return replyInteraction(interaction, "❌ Invoice not found.");

  const customer = await client.users.fetch(invoice.userID).catch(() => null);
  const issuer = await client.users.fetch(invoice.issuerID).catch(() => null);

  const embed = new EmbedBuilder()
    .setTitle(`🧾 Invoice #${id}`)
    .setColor("#3498db")
    .addFields(
      { name: "Customer", value: customer ? `${customer.tag} (${customer.id})` : invoice.userID, inline: true },
      { name: "Issuer", value: issuer ? `${issuer.tag} (${issuer.id})` : invoice.issuerID, inline: true },
      { name: "Product/Description", value: invoice.product, inline: false },
      { name: "Amount", value: `$${invoice.amount}`, inline: true },
      { name: "Status", value: invoice.status, inline: true }
    )
    .setTimestamp()
    .setFooter({ text: `Requested by ${interaction.user.tag}` });

  return replyInteraction(interaction, { embeds: [embed] });
}

      default: return replyInteraction(interaction,"❌ Unknown command.");
    }
  } catch (err) { console.error("interactionCreate handler error:", err); try{replyInteraction(interaction,"❌ Something went wrong.");}catch{} }
});

// ---------- EXPRESS KEEP-ALIVE ----------
const app = express();
app.get("/", (req,res)=>res.send("Bot is running!"));
app.listen(process.env.PORT || 3000, ()=>console.log("✔ Web server running"));

// ---------- LOGIN ----------
client.login(TOKEN);

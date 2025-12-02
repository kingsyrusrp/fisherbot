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
const INVOICE_LOG_ID = "1444496474690813972"; // Invoice Audit Log
const MOD_LOG_ID = "1444845107084787722";     // Moderation Logs
const ALT_CHANNEL_ID = process.env.ALT_CHANNEL_ID || "1445548929943998694";
const ALT_NOTIFY_ROLE_ID = process.env.ALT_NOTIFY_ROLE_ID || "1445544529888411840";
const LEAVE_LOG_CHANNEL_ID = "1445549973566652590"; // Where leave incidents are posted
const APP_ID = process.env.APP_ID;
const GUILD_ID = process.env.GUILD_ID;

// ---------- CLIENT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ---------- STORAGE ----------
const invoices = {}; // invoiceID: { userID, issuerID, product, amount, status, channelID, messageID, createdAt }
const warnings = {}; // userID: [reason1, reason2]
let altDays = 7;

// snapshots for members' roles and join time (by guild)
const memberRoleSnapshots = {}; // { guildId: { userId: { roles: [names], roleIDs: [ids], joinedAt, cachedAt } } }
const altPinged = new Set(); // ensures alt role only pinged once per user
const globalBanList = new Set(); // in-memory global ban list (persist externally if desired)

// ---------- HELPERS ----------
function millisToDays(ms) {
  return ms / (24 * 60 * 60 * 1000);
}

function isAltAccount(member) {
  if (!member || !member.user) return false;
  return (Date.now() - member.user.createdTimestamp) < altDays * 24 * 60 * 60 * 1000;
}

function createEmbed({ title, description, color = "#3498db", extra, footer }) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description || "No description")
    .setColor(color)
    .setTimestamp();
  if (extra) embed.addFields({ name: "Extra Info", value: extra });
  if (footer) embed.setFooter({ text: footer });
  return embed;
}

async function saveMemberSnapshot(member) {
  try {
    const g = member.guild.id;
    if (!memberRoleSnapshots[g]) memberRoleSnapshots[g] = {};
    const roleIDs = member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.id);
    const roleNames = member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.name);
    memberRoleSnapshots[g][member.id] = {
      roles: roleNames,
      roleIDs,
      joinedAt: member.joinedAt ? member.joinedAt.getTime() : null,
      cachedAt: Date.now()
    };
  } catch (err) {
    console.error("saveMemberSnapshot error:", err);
  }
}

// One-time alt detection handler
async function handleAltDetection(member) {
  try {
    if (!member || !member.guild) return;
    const isAlt = isAltAccount(member);
    if (!isAlt) return;

    // Only ping once per user
    const alreadyPinged = altPinged.has(member.id);

    const roles = member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.name).join(", ") || "None";
    const accountAgeDays = Math.floor(millisToDays(Date.now() - member.user.createdTimestamp));
    const accountCreated = new Date(member.user.createdTimestamp).toLocaleString();
    const joinedAt = member.joinedAt ? member.joinedAt.toLocaleString() : "Just joined";

    const embed = new EmbedBuilder()
      .setTitle("⚠️ Possible Alt Account Detected")
      .setColor("#ff0000")
      .setDescription(`A possible alt account was detected — ${member.user.tag}`)
      .addFields(
        { name: "Username", value: `${member.user.tag}`, inline: true },
        { name: "Discord ID", value: `${member.user.id}`, inline: true },
        { name: "Account Created", value: accountCreated, inline: true },
        { name: "Server Joined", value: joinedAt, inline: true },
        { name: "Current Roles", value: roles, inline: false },
        { name: "Why flagged", value: `Account age is ${accountAgeDays} day(s) — under threshold (${altDays} days).`, inline: false }
      )
      .setTimestamp();

    const channel = await client.channels.fetch(ALT_CHANNEL_ID).catch(() => null);
    if (!channel) {
      console.warn("ALT_CHANNEL_ID not found. Skipping alt alert send.");
      return;
    }

    if (!alreadyPinged) {
      altPinged.add(member.id);
      await channel.send({ content: `<@&${ALT_NOTIFY_ROLE_ID}> — ⚠️ Possible alt detected`, embeds: [embed] }).catch(()=>{});
    } else {
      // send without ping
      await channel.send({ embeds: [embed] }).catch(()=>{});
    }
  } catch (err) {
    console.error("handleAltDetection error:", err);
  }
}

// helper reply function for interactions (non-ephemeral)
async function replyInteraction(interaction, payload) {
  try {
    if (!interaction || interaction.replied || interaction.deferred) {
      // Try followUp if already replied
      if (interaction && (interaction.deferred || interaction.replied)) {
        if (typeof payload === "string") return interaction.followUp({ content: payload }).catch(()=>{});
        if (payload && payload.embeds) return interaction.followUp({ embeds: payload.embeds }).catch(()=>{});
        return;
      }
    }
    if (typeof payload === "string") return interaction.reply({ content: payload }).catch(()=>{});
    if (payload && payload.embeds) return interaction.reply({ embeds: payload.embeds }).catch(()=>{});
    // fallback
    return interaction.reply({ content: "✅ Done." }).catch(()=>{});
  } catch (err) {
    console.error("replyInteraction error:", err);
  }
}

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

  new SlashCommandBuilder().setName("setaltdays").setDescription("Set alt detection days")
    .addIntegerOption(opt => opt.setName("days").setDescription("Days").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder().setName("userinfo").setDescription("Get user information")
    .addUserOption(opt => opt.setName("user").setDescription("The user").setRequired(true))
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
];

// ---------- REGISTER COMMANDS ----------
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log("Registering guild commands...");
    await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
    console.log("✅ Commands registered!");
  } catch (err) {
    console.error("Failed registering commands:", err);
  }
}
registerCommands();

// ---------- BOT EVENTS ----------
client.on("ready", () => {
  console.log(`🤖 Bot online as ${client.user.tag}`);

  // Automatic invoice reminders (every 1 hour)
  setInterval(async () => {
    try {
      for (const [id, invoice] of Object.entries(invoices)) {
        if (invoice.status === "pending") {
          const user = await client.users.fetch(invoice.userID).catch(() => null);
          if (user) user.send(`Reminder: Invoice #${id} for **${invoice.product}** is still pending.`).catch(()=>{});
        }
      }
    } catch (err) {
      console.error("Invoice reminder loop error:", err);
    }
  }, 1000 * 60 * 60);
});

// ---------- MEMBER TRACKING HOOKS ----------

// Save snapshot on join and run alt detection
client.on("guildMemberAdd", async (member) => {
  try {
    await saveMemberSnapshot(member);
    await handleAltDetection(member);
  } catch (err) {
    console.error("guildMemberAdd handler error:", err);
  }
});

// Update snapshot on role changes
client.on("guildMemberUpdate", async (oldMember, newMember) => {
  try {
    const oldRoles = oldMember.roles.cache.map(r => r.id).join(",");
    const newRoles = newMember.roles.cache.map(r => r.id).join(",");
    if (oldRoles !== newRoles) {
      await saveMemberSnapshot(newMember);

      // log role diffs to mod log
      const removed = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id)).map(r => r.name);
      const added = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id)).map(r => r.name);
      if ((removed.length || added.length) && client.channels.cache.get(MOD_LOG_ID)) {
        const embed = new EmbedBuilder()
          .setTitle("🔁 Member Roles Updated")
          .setColor("#3498db")
          .setDescription(`${newMember.user.tag} (${newMember.id})`)
          .addFields(
            { name: "Added Roles", value: added.length ? added.join(", ") : "None", inline: false },
            { name: "Removed Roles", value: removed.length ? removed.join(", ") : "None", inline: false }
          )
          .setTimestamp();
        client.channels.cache.get(MOD_LOG_ID).send({ embeds: [embed] }).catch(()=>{});
      }
    }
  } catch (err) {
    console.error("guildMemberUpdate error:", err);
  }
});

// On leave — create leave audit + action buttons
client.on("guildMemberRemove", async (member) => {
  try {
    const g = member.guild.id;
    const snapshot = memberRoleSnapshots[g] && memberRoleSnapshots[g][member.id];
    const roles = snapshot ? (snapshot.roles.length ? snapshot.roles.join(", ") : "None") : (member.roles ? member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.name).join(", ") : "None");
    const joinedAt = snapshot && snapshot.joinedAt ? new Date(snapshot.joinedAt).toLocaleString() : (member.joinedAt ? member.joinedAt.toLocaleString() : "Unknown");
    const accountCreated = new Date(member.user.createdTimestamp).toLocaleString();
    const isAlt = isAltAccount(member);

    const incidentId = `leave-${member.id}-${Date.now()}`;

    const embed = new EmbedBuilder()
      .setTitle(isAlt ? "⚠️ Member Left — Possible Alt" : "🚨 Member Left — Role Snapshot")
      .setColor(isAlt ? "#ff3b30" : "#ff7f50")
      .setDescription(`A member has left — review the snapshot and take action if necessary.`)
      .addFields(
        { name: "Username", value: `${member.user.tag}`, inline: true },
        { name: "Discord ID", value: `${member.user.id}`, inline: true },
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
    if (leaveLogChannel) {
      await leaveLogChannel.send({ embeds: [embed], components: [buttons] });
    } else {
      // fallback to mod log
      if (client.channels.cache.get(MOD_LOG_ID)) client.channels.cache.get(MOD_LOG_ID).send({ embeds: [embed], components: [buttons] }).catch(()=>{});
    }

  } catch (err) {
    console.error("guildMemberRemove error:", err);
  }
});

// ---------- INTERACTION HANDLER ----------
client.on("interactionCreate", async interaction => {
  try {
    // unified accessors for logs
    const logInvoice = (interaction.guild && interaction.guild.channels.cache.get(INVOICE_LOG_ID)) || client.channels.cache.get(INVOICE_LOG_ID);
    const logMod = (interaction.guild && interaction.guild.channels.cache.get(MOD_LOG_ID)) || client.channels.cache.get(MOD_LOG_ID);

    // BUTTON HANDLING (invoices + leave actions + alt actions)
    if (interaction.isButton()) {
      const custom = interaction.customId;

      // Invoice buttons: complete-<id>, deliver-<id>
      if (custom.startsWith("complete-") || custom.startsWith("deliver-")) {
        const [action, invoiceID] = custom.split("-");
        const invoice = invoices[invoiceID];
        if (!invoice) return replyInteraction(interaction, "❌ Invoice not found");

        const user = await client.users.fetch(invoice.userID).catch(()=>null);
        const issuer = await client.users.fetch(invoice.issuerID).catch(()=>null);
        const channel = await client.channels.fetch(invoice.channelID).catch(()=>null);
        const message = channel && invoice.messageID ? await channel.messages.fetch(invoice.messageID).catch(()=>null) : null;

        let embed;
        if (action === "complete") {
          invoice.status = "completed";
          embed = createEmbed({
            title: `✅ Invoice #${invoiceID} Completed`,
            description: `Invoice for **${invoice.product}** is completed.`,
            color: "#f1c40f",
            extra: `Customer: ${user ? user.tag : invoice.userID}\nIssuer: ${issuer ? issuer.tag : invoice.issuerID}\nAmount: $${invoice.amount}`
          });
        } else {
          invoice.status = "delivered";
          embed = createEmbed({
            title: `📦 Invoice #${invoiceID} Delivered`,
            description: `Invoice for **${invoice.product}** delivered.`,
            color: "#27ae60",
            extra: `Customer: ${user ? user.tag : invoice.userID}\nIssuer: ${issuer ? issuer.tag : invoice.issuerID}\nAmount: $${invoice.amount}`
          });
        }

        if (message) {
          await message.edit({ embeds: [embed] }).catch(()=>{});
        } else if (channel) {
          // fallback: post new message if original missing
          const msg = await channel.send({ embeds: [embed] }).catch(()=>null);
          if (msg && !invoice.messageID) invoice.messageID = msg.id;
        }

        if (logInvoice) logInvoice.send({ embeds: [embed] }).catch(()=>{});
        return replyInteraction(interaction, `✅ Invoice #${invoiceID} updated`);
      }

      // Leave audit action buttons and alt action buttons
      if (custom.startsWith("terminate-") || custom.startsWith("globalban-") || custom.startsWith("ack-") ||
          custom.startsWith("terminateAlt-") || custom.startsWith("globalbanAlt-") || custom.startsWith("ackAlt-")) {

        // permission check: require support role OR BanMembers permission
        const member = interaction.member;
        const hasSupport = member?.roles?.cache?.has(SUPPORT_ROLE_ID);
        const hasBanPerm = member?.permissions?.has(PermissionFlagsBits.BanMembers);

        if (!hasSupport && !hasBanPerm) {
          return replyInteraction(interaction, "❌ You don't have permission to perform that action.");
        }

        // parse
        if (custom.startsWith("terminate-") || custom.startsWith("terminateAlt-")) {
          const parts = custom.split("-");
          const targetId = parts[1];
          // Attempt to ban in this guild
          try {
            await interaction.guild.bans.create(targetId, { reason: `Terminated by ${interaction.user.tag} via audit action.` }).catch(()=>{});
            // log
            if (logMod) logMod.send({ embeds: [ createEmbed({ title: "🛑 Terminate Executed", description: `User <@${targetId}> was banned from ${interaction.guild.name}`, color: "#c0392b", footer: `Action by ${interaction.user.tag}` }) ] }).catch(()=>{});
            return replyInteraction(interaction, `✅ User <@${targetId}> banned from this server.`);
          } catch (err) {
            console.error("Terminate action error:", err);
            return replyInteraction(interaction, `❌ Failed to ban user <@${targetId}>.`);
          }
        }

        if (custom.startsWith("globalban-") || custom.startsWith("globalbanAlt-")) {
          const parts = custom.split("-");
          const targetId = parts[1];
          globalBanList.add(targetId);

          // attempt bans across shared guilds (best-effort)
          const results = [];
          for (const [gid, g] of client.guilds.cache) {
            try {
              const me = g.members.cache.get(client.user.id) || await g.members.fetch(client.user.id).catch(()=>null);
              if (!me || !me.permissions.has(PermissionFlagsBits.BanMembers)) continue;
              await g.bans.create(targetId, { reason: `Global ban added by ${interaction.user.tag}` }).catch(()=>{});
              results.push(`Banned in: ${g.name}`);
            } catch (err) {
              // ignore per-guild failures
            }
          }

          if (logMod) logMod.send({ embeds: [ createEmbed({ title: "🌐 Global Ban Executed", description: `User \`${targetId}\` added to global ban list.`, color: "#8e44ad", extra: results.length ? results.join("\n") : "No shared guilds banned (or lacked permissions).", footer: `Action by ${interaction.user.tag}` }) ] }).catch(()=>{});
          return replyInteraction(interaction, `✅ Global ban recorded for <@${targetId}>. Attempted bans logged.`);
        }

        if (custom.startsWith("ack-") || custom.startsWith("ackAlt-")) {
          // Acknowledge: update the original message embed footer & disable buttons
          try {
            const message = interaction.message;
            const originalEmbed = message?.embeds?.[0] ? EmbedBuilder.from(message.embeds[0]) : null;
            if (originalEmbed) {
              originalEmbed.setFooter({ text: `Acknowledged by ${interaction.user.tag}` }).setColor("#2ecc71");
              await message.edit({ embeds: [originalEmbed], components: [] }).catch(()=>{});
            }
            if (logMod) logMod.send({ embeds: [ createEmbed({ title: "✅ Incident Acknowledged", description: `Incident acknowledged by ${interaction.user.tag}`, color: "#2ecc71" }) ] }).catch(()=>{});
            return replyInteraction(interaction, `✅ Acknowledged.`);
          } catch (err) {
            console.error("Acknowledge action error:", err);
            return replyInteraction(interaction, "❌ Failed to acknowledge.");
          }
        }
      }

      // unknown button
      return replyInteraction(interaction, "❌ Unknown button action.");
    }

    // ---------- SLASH COMMANDS ----------
    if (!interaction.isChatInputCommand()) return;

    switch (interaction.commandName) {
      // INVOICE
      case "invoice": {
        if (!interaction.member.roles.cache.has(SUPPORT_ROLE_ID)) return replyInteraction(interaction, "❌ No permission.");
        const user = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");
        const desc = interaction.options.getString("description");
        const invoiceID = Math.floor(1000 + Math.random() * 9000);

        const channel = interaction.channel;
        if (channel) channel.setName(`invoice-${invoiceID}`).catch(()=>{});

        const embed = createEmbed({
          title: `🧾 Invoice #${invoiceID}`,
          description: `Invoice for **${desc}**`,
          color: "#3498db",
          extra: `Customer: ${user.tag}\nIssuer: ${interaction.user.tag}\nAmount: $${amount}\nStatus: Pending\nPayment Options: [Venmo](https://venmo.com/u/Nick-Welge) | [Paypal](https://www.paypal.com/paypalme/NickWelge) | [CashApp](https://cash.app/$KLHunter2008)`
        });

        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`complete-${invoiceID}`).setLabel("Mark Completed").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`deliver-${invoiceID}`).setLabel("Mark Delivered").setStyle(ButtonStyle.Success)
        );

        const message = await channel.send({ content: `<@${user.id}>`, embeds: [embed], components: [buttons] }).catch(()=>null);
        invoices[invoiceID] = { userID: user.id, issuerID: interaction.user.id, product: desc, amount, status: "pending", channelID: channel.id, messageID: message ? message.id : null, createdAt: Date.now() };

        if (logInvoice) logInvoice.send({ embeds: [embed] }).catch(()=>{});
        return replyInteraction(interaction, `✅ Invoice #${invoiceID} created in this channel.`);
      }

      // DELETE INVOICE
      case "deleteinvoice": {
        const id = interaction.options.getInteger("id");
        const invoice = invoices[id];
        if (!invoice) return replyInteraction(interaction, "❌ Invoice not found");
        // optional: try to remove message
        try {
          if (invoice.channelID && invoice.messageID) {
            const ch = await client.channels.fetch(invoice.channelID).catch(()=>null);
            if (ch) {
              const msg = await ch.messages.fetch(invoice.messageID).catch(()=>null);
              if (msg) await msg.delete().catch(()=>{});
            }
          }
        } catch {}
        delete invoices[id];
        if (logInvoice) logInvoice.send({ embeds: [ createEmbed({ title: `🗑️ Invoice #${id} Deleted`, description: `Invoice removed by ${interaction.user.tag}`, color: "#e74c3c" }) ] }).catch(()=>{});
        return replyInteraction(interaction, `✅ Invoice #${id} deleted`);
      }

      // SET ALT DAYS
      case "setaltdays": {
        altDays = interaction.options.getInteger("days");
        return replyInteraction(interaction, `✅ Alt detection set to ${altDays} days`);
      }

      // USERINFO
      case "userinfo": {
        const user = interaction.options.getUser("user");
        const m = await interaction.guild.members.fetch(user.id).catch(()=>null);
        // last message search — naive: search in cached messages of current channel
        const lastMsg = interaction.channel && interaction.channel.messages ? interaction.channel.messages.cache.filter(msg => msg.author.id === user.id).last() : null;
        const lastVC = m?.voice?.channel;
        const invoiceEntry = Object.entries(invoices).find(([k,v]) => v.userID === user.id);
        const modHistory = warnings[user.id] || [];
        const isUserAlt = m ? isAltAccount(m) : false;

        const statusInfo = invoiceEntry ? `Invoice #${invoiceEntry[0]} | ${invoiceEntry[1].status}` : "No Invoice Found";
        let embedColor = "#2ecc71"; // green
        let emoji = "✅";
        if (isUserAlt) { embedColor = "#ff0000"; emoji = "⚠️"; }
        else if (modHistory.length > 0) { embedColor = "#f1c40f"; emoji = "❓"; }

        const embed = new EmbedBuilder()
          .setTitle(`${emoji} User Info: ${user.tag}`)
          .setColor(embedColor)
          .addFields(
            { name: "Name", value: user.tag, inline: true },
            { name: "Discord ID", value: user.id, inline: true },
            { name: "Joined Server", value: m?.joinedAt?.toDateString() || "Unknown", inline: true },
            { name: "Account Created", value: user.createdAt.toDateString(), inline: true },
            { name: "Invoice Status", value: statusInfo, inline: true },
            { name: "Invoice Date", value: invoiceEntry ? new Date(invoiceEntry[1].createdAt).toDateString() : "N/A", inline: true },
            { name: "Roles", value: m ? (m.roles.cache.map(r => r.name).join(", ") || "None") : "None", inline: false },
            { name: "Last Message", value: lastMsg ? `${lastMsg.createdAt} in <#${lastMsg.channel.id}>` : "No messages found", inline: false },
            { name: "Last VC", value: lastVC ? `${lastVC.name} at ${new Date().toDateString()}` : "Never connected", inline: false },
            { name: "Moderation History", value: modHistory.length > 0 ? modHistory.join("\n") : "None", inline: false },
            { name: "Flags", value: isUserAlt ? "Alt Account Detected" : "None", inline: false }
          );
        return replyInteraction(interaction, { embeds: [embed] });
      }

      // WARN
      case "warn": {
        const user = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason");
        if (!warnings[user.id]) warnings[user.id] = [];
        warnings[user.id].push(reason);
        if (logMod) logMod.send({ embeds: [ createEmbed({ title: "⚠️ User Warned", description: `${user.tag} warned by ${interaction.user.tag}\nReason: ${reason}`, color: "#f39c12" }) ] }).catch(()=>{});
        return replyInteraction(interaction, `✅ ${user.tag} has been warned`);
      }

      // KICK
      case "kick": {
        const user = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason") || "No reason";
        const m = await interaction.guild.members.fetch(user.id).catch(()=>null);
        if (!m) return replyInteraction(interaction, "❌ Member not found");
        await m.kick(reason).catch(err => console.error("kick error:", err));
        if (logMod) logMod.send({ embeds: [ createEmbed({ title: "👢 User Kicked", description: `${user.tag} kicked by ${interaction.user.tag}\nReason: ${reason}`, color: "#e67e22" }) ] }).catch(()=>{});
        return replyInteraction(interaction, `✅ ${user.tag} was kicked`);
      }

      // BAN
      case "ban": {
        const user = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason") || "No reason";
        const m = await interaction.guild.members.fetch(user.id).catch(()=>null);
        if (!m) return replyInteraction(interaction, "❌ Member not found");
        await m.ban({ reason }).catch(err => console.error("ban error:", err));
        if (logMod) logMod.send({ embeds: [ createEmbed({ title: "⛔ User Banned", description: `${user.tag} banned by ${interaction.user.tag}\nReason: ${reason}`, color: "#c0392b" }) ] }).catch(()=>{});
        return replyInteraction(interaction, `✅ ${user.tag} was banned`);
      }

      // ADD ROLE
      case "addrole": {
        const user = interaction.options.getUser("user");
        const role = interaction.options.getRole("role");
        const m = await interaction.guild.members.fetch(user.id).catch(()=>null);
        if (!m) return replyInteraction(interaction, "❌ Member not found");
        await m.roles.add(role).catch(err => console.error("addrole error:", err));
        if (logMod) logMod.send({ embeds: [ createEmbed({ title: "➕ Role Added", description: `Added ${role.name} to ${user.tag}`, color: "#2ecc71" }) ] }).catch(()=>{});
        return replyInteraction(interaction, `✅ Added ${role.name} to ${user.tag}`);
      }

      // REMOVE ROLE
      case "removerole": {
        const user = interaction.options.getUser("user");
        const role = interaction.options.getRole("role");
        const m = await interaction.guild.members.fetch(user.id).catch(()=>null);
        if (!m) return replyInteraction(interaction, "❌ Member not found");
        await m.roles.remove(role).catch(err => console.error("removerole error:", err));
        if (logMod) logMod.send({ embeds: [ createEmbed({ title: "➖ Role Removed", description: `Removed ${role.name} from ${user.tag}`, color: "#e74c3c" }) ] }).catch(()=>{});
        return replyInteraction(interaction, `✅ Removed ${role.name} from ${user.tag}`);
      }

      // PURGE ROLES
      case "purgeroles": {
        const user = interaction.options.getUser("user");
        const m = await interaction.guild.members.fetch(user.id).catch(()=>null);
        if (!m) return replyInteraction(interaction, "❌ Member not found");
        await m.roles.set([]).catch(err => console.error("purgeroles error:", err));
        if (logMod) logMod.send({ embeds: [ createEmbed({ title: "🗑️ Roles Purged", description: `All roles removed from ${user.tag}`, color: "#9b59b6" }) ] }).catch(()=>{});
        return replyInteraction(interaction, `✅ All roles removed from ${user.tag}`);
      }

      default:
        return replyInteraction(interaction, "❌ Unknown command.");
    }
  } catch (err) {
    console.error("interactionCreate handler error:", err);
    try { return replyInteraction(interaction, "❌ Something went wrong."); } catch {}
  }
});

// ---------- EXPRESS KEEP-ALIVE ----------
const app = express();
app.get("/", (req, res) => res.send("Bot is running!"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✔ Web server running on port ${PORT}`));

// ---------- LOGIN ----------
client.login(TOKEN);

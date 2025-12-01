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
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

// ---------- ENV ----------
const TOKEN = process.env.DISCORD_TOKEN;
const SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID;
const INVOICE_LOG_CHANNEL = "1444496474690813972";
const MODERATION_LOG_CHANNEL = "1444845107084787722";
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
const invoices = {}; // { invoiceID: { userID, issuerID, product, amount, status, ticketID, date } }
const warnings = {}; // { userID: [reason1, reason2] }
let altDays = 7;

// ---------- HELPERS ----------
function isAltAccount(member) {
  if (!member || !member.user || !member.user.createdTimestamp) return false;
  const accountAge = Date.now() - member.user.createdTimestamp;
  return accountAge < altDays * 24 * 60 * 60 * 1000;
}

function createEmbed({ title, description, color = "#3498db", extra, footer, icon }) {
  const embed = new EmbedBuilder()
    .setTitle(title || "No Title")
    .setDescription(description || "No Description")
    .setColor(color)
    .setTimestamp();
  if (extra && typeof extra === "string" && extra.length > 0) embed.addFields({ name: "Extra Info", value: extra });
  if (footer) embed.setFooter({ text: footer, iconURL: icon });
  return embed;
}

// ---------- SLASH COMMANDS ----------
const commands = [
  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Open a ticket")
    .addStringOption(opt =>
      opt.setName("type")
        .setDescription("Type of ticket")
        .setRequired(true)
        .addChoices(
          { name: "Support", value: "support" },
          { name: "EUP Commissions", value: "eup" },
          { name: "Livery Commissions", value: "livery" }
        )
    ).toJSON(),

  new SlashCommandBuilder()
    .setName("invoice")
    .setDescription("Send a payment invoice")
    .addUserOption(opt => opt.setName("user").setDescription("User to invoice").setRequired(true))
    .addIntegerOption(opt => opt.setName("amount").setDescription("Amount").setRequired(true))
    .addStringOption(opt => opt.setName("description").setDescription("Product description").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("deleteinvoice")
    .setDescription("Delete an invoice")
    .addIntegerOption(opt => opt.setName("id").setDescription("Invoice ID").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("setaltdays")
    .setDescription("Set alt detection days")
    .addIntegerOption(opt => opt.setName("days").setDescription("Days").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Get user information")
    .addUserOption(opt => opt.setName("user").setDescription("The user").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a user")
    .addUserOption(opt => opt.setName("user").setDescription("User to warn").setRequired(true))
    .addStringOption(opt => opt.setName("reason").setDescription("Reason").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a user")
    .addUserOption(opt => opt.setName("user").setDescription("User to kick").setRequired(true))
    .addStringOption(opt => opt.setName("reason").setDescription("Reason"))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a user")
    .addUserOption(opt => opt.setName("user").setDescription("User to ban").setRequired(true))
    .addStringOption(opt => opt.setName("reason").setDescription("Reason"))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("addrole")
    .setDescription("Add a role to a user")
    .addUserOption(opt => opt.setName("user").setDescription("User").setRequired(true))
    .addRoleOption(opt => opt.setName("role").setDescription("Role").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("removerole")
    .setDescription("Remove a role from a user")
    .addUserOption(opt => opt.setName("user").setDescription("User").setRequired(true))
    .addRoleOption(opt => opt.setName("role").setDescription("Role").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("purgeroles")
    .setDescription("Remove all roles from a user")
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
    console.error(err);
  }
}
registerCommands();

// ---------- BOT EVENTS ----------
client.on("ready", () => console.log(`🤖 Bot online as ${client.user.tag}`));

client.on("interactionCreate", async i => {
  if (!i.isChatInputCommand() && !i.isButton()) return;

  const reply = msg => i.reply({ content: msg, ephemeral: false });
  const modLog = i.guild.channels.cache.get(MODERATION_LOG_CHANNEL);
  const invoiceLog = i.guild.channels.cache.get(INVOICE_LOG_CHANNEL);

  // ---------- ALT ACCOUNT CHECK ----------
  const member = await i.guild.members.fetch(i.user.id);
  const isAlt = isAltAccount(member);

  // ---------- BUTTON HANDLER ----------
  if (i.isButton()) {
    const [action, invoiceID] = i.customId.split("-");
    const invoice = invoices[invoiceID];
    if (!invoice) return reply("Invoice not found.");

    const user = await client.users.fetch(invoice.userID);
    const issuer = await client.users.fetch(invoice.issuerID);
    const ticketChannel = await i.guild.channels.fetch(invoice.ticketID);

    if (action === "complete") {
      invoice.status = "completed";
      const embed = createEmbed({
        title: `✅ Invoice #${invoiceID} Completed`,
        description: `Invoice for **${invoice.product}** is completed.`,
        color: "#f1c40f",
        extra: `Customer: ${user.tag}\nIssuer: ${issuer.tag}\nAmount: $${invoice.amount}`
      });
      await ticketChannel.send({ embeds: [embed] });
      if (invoiceLog) invoiceLog.send({ embeds: [embed] });
      return reply("✅ Invoice marked completed");
    }

    if (action === "deliver") {
      invoice.status = "delivered";
      const embed = createEmbed({
        title: `📦 Invoice #${invoiceID} Delivered`,
        description: `Invoice for **${invoice.product}** has been delivered.`,
        color: "#27ae60",
        extra: `Customer: ${user.tag}\nIssuer: ${issuer.tag}\nAmount: $${invoice.amount}`
      });
      await ticketChannel.send({ embeds: [embed] });
      if (invoiceLog) invoiceLog.send({ embeds: [embed] });
      return reply("✅ Invoice marked delivered");
    }
  }

  // ---------- COMMAND HANDLER ----------
  try {
    switch(i.commandName) {
      case "ticket": {
        const type = i.options.getString("type");
        const ping = type === "support" ? `<@&${SUPPORT_ROLE_ID}>` : "";
        const ticketChannel = await i.guild.channels.create({
          name: `${i.user.username}-${type}-ticket`,
          type: 0,
          permissionOverwrites: [
            { id: i.guild.id, deny: ["ViewChannel"] },
            { id: i.user.id, allow: ["ViewChannel","SendMessages"] },
            { id: SUPPORT_ROLE_ID, allow: ["ViewChannel","SendMessages"] },
          ]
        });
        const embed = createEmbed({
          title: `${type} Ticket`,
          description: `${ping}\nA staff member will assist you shortly.`,
          color: "#f1c40f"
        });
        await ticketChannel.send({ content: ping, embeds: [embed] });
        reply(`✅ Ticket created: ${ticketChannel}`);
        break;
      }

      case "invoice": {
        const user = i.options.getUser("user");
        const amount = i.options.getInteger("amount");
        const description = i.options.getString("description");
        const invoiceID = Math.floor(1000 + Math.random() * 9000);
        const ticketChannel = await i.guild.channels.create({
          name: `invoice-${invoiceID}`,
          type: 0,
          permissionOverwrites: [
            { id: i.guild.id, deny: ["ViewChannel"] },
            { id: i.user.id, allow: ["ViewChannel","SendMessages"] },
            { id: SUPPORT_ROLE_ID, allow: ["ViewChannel","SendMessages"] },
          ]
        });
        invoices[invoiceID] = { userID: user.id, issuerID: i.user.id, product: description, amount, status: "pending", ticketID: ticketChannel.id, date: new Date() };

        const embed = createEmbed({
          title: `🧾 Invoice #${invoiceID}`,
          description: `Invoice for **${description}**`,
          color: "#3498db",
          extra: `Customer: ${user.tag}\nIssuer: ${i.user.tag}\nAmount: $${amount}\nStatus: Pending\nPayment: [Venmo](https://venmo.com/u/Nick-Welge) | [Paypal](https://www.paypal.com/paypalme/NickWelge) | [CashApp](https://cash.app/$KLHunter2008)`
        });

        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`complete-${invoiceID}`).setLabel("Mark Completed").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`deliver-${invoiceID}`).setLabel("Mark Delivered").setStyle(ButtonStyle.Success)
        );

        await ticketChannel.send({ content: `<@${user.id}>`, embeds:[embed], components:[buttons] });
        if (invoiceLog) invoiceLog.send({ embeds:[embed] });
        reply(`✅ Invoice #${invoiceID} created in ticket: ${ticketChannel}`);
        break;
      }

      case "deleteinvoice": {
        const id = i.options.getInteger("id");
        const invoice = invoices[id];
        if (!invoice) return reply("❌ Invoice not found.");
        delete invoices[id];
        reply(`✅ Invoice #${id} deleted.`);
        if (invoiceLog) invoiceLog.send({ content: `🗑️ Invoice #${id} deleted by ${i.user.tag}` });
        break;
      }

      case "setaltdays": {
        altDays = i.options.getInteger("days");
        reply(`✅ Alt detection days set to ${altDays}`);
        break;
      }

      case "userinfo": {
        const user = i.options.getUser("user");
        const m = await i.guild.members.fetch(user.id);
        const now = new Date();
        const invoice = Object.entries(invoices).find(([id, inv]) => inv.userID === user.id)?.[1];

        // Last message
        let lastMessageTime = "No message found";
        let lastMessageChannel = "";
        try {
          const channels = i.guild.channels.cache.filter(c => c.isText());
          for (const [, ch] of channels) {
            const messages = await ch.messages.fetch({ limit: 100 });
            const userMsg = messages.find(msg => msg.author.id === user.id);
            if (userMsg) {
              lastMessageTime = userMsg.createdAt.toDateString();
              lastMessageChannel = `<#${ch.id}>`;
              break;
            }
          }
        } catch {}

        // Last VC join
        let lastVCJoin = "No VC activity";
        try {
          const vcState = m.voice;
          if (vcState.channelId) lastVCJoin = `<#${vcState.channelId}> at ${vcState.joinedAt ? vcState.joinedAt.toDateString() : "Unknown"}`;
        } catch {}

        // Moderation history
        let modHistory = warnings[user.id]?.join("\n") || "None";

        let flags = [];
        if (isAltAccount(m)) flags.push("⚠️ Alt Account Detected");

        let color = "#2ecc71"; // Green by default
        if (flags.length > 0) color = "#e74c3c"; // red if flagged
        else if (modHistory !== "None") color = "#f1c40f"; // yellow if moderation history

        const embed = createEmbed({
          title: `${flags.length>0?"⚠️ ":"✅ "}User Info: ${user.tag}`,
          color: color,
          extra: `Name: ${user.tag}
Discord ID: ${user.id}
Date Joined Server: ${m.joinedAt ? m.joinedAt.toDateString() : "Unknown"}
Account Created: ${user.createdAt ? user.createdAt.toDateString() : "Unknown"}
Invoice Status: ${invoice ? invoice.status+" (#"+Object.keys(invoices).find(id=>invoices[id]===invoice)+")" : "No Invoice Found"}
Invoice Date: ${invoice ? invoice.date.toDateString() : "N/A"}
Roles: ${m.roles.cache.map(r=>r.name).join(", ") || "None"}
Last Message: ${lastMessageTime} ${lastMessageChannel}
Last VC Join: ${lastVCJoin}
Moderation History: ${modHistory}
Flags: ${flags.join(", ") || "None"}`
        });

        reply({ embeds:[embed] });
        break;
      }

      // Add other moderation commands (warn, kick, ban, addrole, removerole, purgeroles) here with modLog
      default:
        reply("❌ Unknown command.");
        break;
    }
  } catch(err){ console.error(err); reply("❌ Something went wrong."); }
});

// ---------- EXPRESS KEEP-ALIVE ----------
const app = express();
app.get("/", (req,res)=>res.send("Bot is running!"));
const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log(`✔ Web server running on port ${PORT}`));

// ---------- LOGIN ----------
client.login(TOKEN);

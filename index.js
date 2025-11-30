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
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
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
  ],
});

// ---------- STORAGE ----------
const invoices = {};
const warnings = {};
let altDays = 7;

// ---------- HELPERS ----------
function isAltAccount(member) {
  const accountAge = Date.now() - member.user.createdTimestamp;
  return accountAge < altDays * 24 * 60 * 60 * 1000;
}

function createEmbed({ title, description, color = "#3498db", extra, footer }) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
  if (extra) embed.addFields({ name: "Extra Info", value: extra });
  if (footer) embed.setFooter({ text: footer });
  return embed;
}

// ---------- SLASH COMMANDS ----------
const commands = [
  // ...same commands as before (ticket, invoice, checkinvoice, etc.)
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
  const replyPublic = msg => i.reply({ content: msg, ephemeral: true });
  const logChannel = i.guild.channels.cache.get(LOG_CHANNEL_ID);
  const member = await i.guild.members.fetch(i.user.id);

  // ---------- ALT ACCOUNT ----------
  if (isAltAccount(member)) {
    const altEmbed = createEmbed({
      title: "⚠️ Alt Account Detected",
      description: `${member.user.tag} has an account younger than ${altDays} days.`,
      color: "#ff0000",
      footer: `Account Created: ${member.user.createdAt.toDateString()}`
    });
    if (logChannel) logChannel.send({ embeds: [altEmbed] });
  }

  // ---------- BUTTON HANDLER ----------
  if (i.isButton()) {
    const [action, invoiceID] = i.customId.split("-");
    const invoice = invoices[invoiceID];
    if (!invoice) return i.reply({ content: "Invoice not found", ephemeral: true });

    const user = await client.users.fetch(invoice.userID);
    const issuer = await client.users.fetch(invoice.issuerID);
    const ticketChannel = await i.guild.channels.fetch(invoice.ticketID);

    if (action === "complete") {
      invoice.status = "completed";
      const embed = createEmbed({
        title: `✅ Invoice #${invoiceID} Completed`,
        description: `Invoice for **${invoice.product}** is completed.`,
        color: "#f1c40f",
        extra: `Customer: ${user.tag}\nIssuer: ${issuer.tag}\nAmount: $${invoice.amount}`,
        footer: `Invoice ID: ${invoiceID}`
      });
      await ticketChannel.send({ embeds: [embed] });
      if (logChannel) logChannel.send({ embeds: [embed] });
      return i.reply({ content: "✅ Invoice marked completed", ephemeral: true });
    }

    if (action === "deliver") {
      invoice.status = "delivered";
      const embed = createEmbed({
        title: `📦 Invoice #${invoiceID} Delivered`,
        description: `Invoice for **${invoice.product}** has been delivered.`,
        color: "#27ae60",
        extra: `Customer: ${user.tag}\nIssuer: ${issuer.tag}\nAmount: $${invoice.amount}`,
        footer: `Invoice ID: ${invoiceID}`
      });
      await ticketChannel.send({ embeds: [embed] });
      if (logChannel) logChannel.send({ embeds: [embed] });
      return i.reply({ content: "✅ Invoice marked delivered", ephemeral: true });
    }
  }

  // ---------- COMMAND HANDLER ----------
  if (!i.isChatInputCommand()) return;
  try {
    switch(i.commandName) {
      case "invoice":
        if(!i.member.roles.cache.has(SUPPORT_ROLE_ID)) return replyPublic("❌ No permission.");
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
          ],
        });
        invoices[invoiceID] = { userID: user.id, issuerID: i.user.id, product: description, amount, status: "pending", ticketID: ticketChannel.id };

        const embed = createEmbed({
          title: `🧾 Invoice #${invoiceID}`,
          description: `Invoice for **${description}**`,
          color: "#3498db",
          extra: `Customer: ${user.tag}\nIssuer: ${i.user.tag}\nAmount: $${amount}\nStatus: Pending\nPayment: [Venmo](https://venmo.com/u/Nick-Welge) | [Paypal](https://www.paypal.com/paypalme/NickWelge) | [CashApp](https://cash.app/$KLHunter2008)`,
          footer: `Invoice ID: ${invoiceID}`
        });

        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`complete-${invoiceID}`).setLabel("Mark Completed").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`deliver-${invoiceID}`).setLabel("Mark Delivered").setStyle(ButtonStyle.Success)
        );
        await ticketChannel.send({ content:`<@${user.id}>`, embeds:[embed], components:[buttons] });
        await i.reply({ content: `✅ Invoice #${invoiceID} created in ticket: ${ticketChannel}`, ephemeral: true });
        break;

      case "setaltdays":
        altDays = i.options.getInteger("days");
        replyPublic(`✅ Alt detection days set to ${altDays}`);
        break;

      case "userinfo": {
        const user = i.options.getUser("user");
        const m = await i.guild.members.fetch(user.id);
        const embed = createEmbed({
          title: `ℹ️ User Info: ${user.tag}`,
          description: `User ID: ${user.id}\nJoined: ${m.joinedAt.toDateString()}\nAccount Created: ${user.createdAt.toDateString()}\nRoles: ${m.roles.cache.map(r=>r.name).join(", ")}`,
          color: "#3498db",
          extra: warnings[user.id]?.join("\n")||"No warnings"
        });
        await i.reply({ embeds:[embed], ephemeral:true });
        break;
      }

      // Add other commands (warn, kick, ban, addrole, removerole, purgeroles) here exactly as before
    }
  } catch(err){ console.error(err); replyPublic("❌ Something went wrong."); }
});

// ---------- EXPRESS KEEP-ALIVE ----------
const app = express();
app.get("/", (req,res)=>res.send("Bot is running!"));
const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log(`✔ Web server running on port ${PORT}`));

// ---------- LOGIN ----------
client.login(TOKEN);

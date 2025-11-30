import "dotenv/config";
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from "discord.js";

const TOKEN = process.env.DISCORD_TOKEN;
const SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const APP_ID = process.env.APP_ID;
const GUILD_ID = process.env.GUILD_ID;

// ---------------- CLIENT ----------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages]
});

// ---------------- IN-MEMORY STORAGE ----------------
const invoices = {}; // { invoiceID: { userID, issuerID, product, amount, status } }

// ---------------- SLASH COMMANDS ----------------
const commands = [
  new SlashCommandBuilder()
    .setName("invoice")
    .setDescription("Send a payment invoice to a member.")
    .addUserOption(opt => opt.setName("user").setDescription("User to invoice").setRequired(true))
    .addIntegerOption(opt => opt.setName("amount").setDescription("Amount to be paid").setRequired(true))
    .addStringOption(opt => opt.setName("description").setDescription("Product description").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("checkinvoice")
    .setDescription("Check the status of a customer's invoice.")
    .addIntegerOption(opt => opt.setName("id").setDescription("Invoice ID").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("completeinvoice")
    .setDescription("Notify a customer that their product is ready.")
    .addIntegerOption(opt => opt.setName("id").setDescription("Invoice ID").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("deliverproduct")
    .setDescription("Deliver product to customer by invoice ID.")
    .addIntegerOption(opt => opt.setName("id").setDescription("Invoice ID").setRequired(true))
    .addStringOption(opt => opt.setName("link").setDescription("Link to product").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .toJSON()
];

// ---------------- REGISTER COMMANDS ----------------
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log("Clearing global commands...");
    await rest.put(Routes.applicationCommands(APP_ID), { body: [] });

    console.log("Registering guild commands...");
    await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
    console.log("Commands registered!");
  } catch (err) { console.error(err); }
}
registerCommands();

// ---------------- EMBED FUNCTION ----------------
function createAuditEmbed({ invoiceID, amount, description, issuer, clientUser, type, extra }) {
  const now = new Date();
  const pad = n => n.toString().padStart(2, "0");
  const timestamp = `${pad(now.getDate())}/${pad(now.getMonth()+1)}/${now.getFullYear()} | ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const colors = { invoice: "#3498db", complete: "#2ecc71", deliver: "#27ae60" };
  const titles = { invoice: `🧾 Invoice #${invoiceID}`, complete: `✅ Invoice Completed #${invoiceID}`, deliver: `📦 Product Delivered #${invoiceID}` };
  const descs = { invoice: "A new invoice has been issued:", complete: "A product has been completed!", deliver: "The product has been delivered!" };

  const embed = new EmbedBuilder()
    .setColor(colors[type])
    .setTitle(titles[type])
    .setDescription(descs[type])
    .setAuthor({ name: issuer.tag, iconURL: issuer.displayAvatarURL() })
    .setThumbnail(clientUser.displayAvatarURL())
    .addFields(
      { name: "💰 Amount", value: type === "invoice" ? `$${amount}` : "Paid via payment links", inline: true },
      { name: "📝 Product / Description", value: description, inline: true },
      { name: "\u200B", value: "\u200B" },
      { name: "👤 Customer", value: clientUser.tag, inline: true },
      { name: "🆔 Customer ID", value: clientUser.id, inline: true },
      { name: "\u200B", value: "\u200B" },
      { name: "👮 Issued By", value: issuer.tag, inline: true },
      { name: "🆔 Issuer ID", value: issuer.id, inline: true }
    )
    .setFooter({ text: `📅 ${timestamp}` })
    .setTimestamp();

  if(extra) embed.addFields({ name: "🔗 Extra Info", value: extra });
  return embed;
}

// ---------------- BOT LOGIC ----------------
client.on("ready", () => console.log(`Bot online as ${client.user.tag}`));

client.on("interactionCreate", async i => {
  if(!i.isChatInputCommand()) return;
  const replyEphemeral = msg => i.reply({ content: msg, ephemeral: true });

  // -------- /invoice --------
  if(i.commandName === "invoice") {
    if(!i.member.roles.cache.has(SUPPORT_ROLE_ID)) return replyEphemeral("❌ No permission.");
    const user = i.options.getUser("user");
    const amount = i.options.getInteger("amount");
    const description = i.options.getString("description");
    const invoiceID = Math.floor(1000 + Math.random() * 9000);

    invoices[invoiceID] = { userID: user.id, issuerID: i.user.id, product: description, amount, status: "pending" };

    const invoiceDM = new EmbedBuilder()
      .setTitle(`📄 Your Invoice #${invoiceID}`)
      .setColor("#1abc9c")
      .setDescription(`Hello ${user.tag},\n\nYou have requested a **${description}**.`)
      .addFields(
        { name: "💰 Amount Due", value: `$${amount}`, inline: true },
        { name: "💳 Pay Here", value: "[CashApp](https://cash.app/$KLHunter2008)" }
      )
      .setFooter({ text: `Invoice ID: ${invoiceID} | Issued by ${i.user.tag}` })
      .setTimestamp();

    try { await user.send({ embeds: [invoiceDM] }); } 
    catch { return replyEphemeral("❌ Couldn't DM the user."); }

    await replyEphemeral(`✅ Invoice #${invoiceID} sent to ${user.tag}`);

    if(LOG_CHANNEL_ID) {
      const logChannel = i.guild.channels.cache.get(LOG_CHANNEL_ID);
      if(logChannel) logChannel.send({ embeds: [createAuditEmbed({ invoiceID, amount, description, issuer: i.user, clientUser: user, type: "invoice" })] });
    }
  }

  // -------- /checkinvoice --------
  if(i.commandName === "checkinvoice") {
    const id = i.options.getInteger("id");
    const inv = invoices[id];
    if(!inv) return replyEphemeral(`❌ No invoice found with ID ${id}`);
    const user = await client.users.fetch(inv.userID);
    const issuer = await client.users.fetch(inv.issuerID);
    await i.reply({ embeds: [createAuditEmbed({ invoiceID: id, amount: inv.amount, description: inv.product, issuer, clientUser: user, type: "invoice", extra: `Status: ${inv.status}` })] });
  }

  // -------- /completeinvoice --------
  if(i.commandName === "completeinvoice") {
    if(!i.member.roles.cache.has(SUPPORT_ROLE_ID)) return replyEphemeral("❌ No permission.");
    const id = i.options.getInteger("id");
    const inv = invoices[id];
    if(!inv) return replyEphemeral(`❌ No invoice found with ID ${id}`);

    inv.status = "completed";
    const user = await client.users.fetch(inv.userID);
    const issuer = await client.users.fetch(inv.issuerID);

    const completeDM = new EmbedBuilder()
      .setTitle(`🎉 Invoice #${id} Completed`)
      .setColor("#f1c40f")
      .setDescription(`Hello ${user.tag}, your **${inv.product}** is ready!`)
      .addFields(
        { name: "💳 Payment Options", value: "[PayPal](https://paypal.me/YourLink) | [Venmo](https://venmo.com/YourLink) | [Tebex](https://your-tebex-link-here)" }
      )
      .setFooter({ text: `Invoice ID: ${id}` })
      .setTimestamp();

    try { await user.send({ embeds: [completeDM] }); } 
    catch { return replyEphemeral(`❌ Couldn't DM ${user.tag}`); }

    await replyEphemeral(`✅ Customer notified about completion.`);
    if(LOG_CHANNEL_ID) {
      const logChannel = i.guild.channels.cache.get(LOG_CHANNEL_ID);
      if(logChannel) logChannel.send({ embeds: [createAuditEmbed({ invoiceID: id, amount: inv.amount, description: inv.product, issuer, clientUser: user, type: "complete" })] });
    }
  }

  // -------- /deliverproduct --------
  if(i.commandName === "deliverproduct") {
    if(!i.member.roles.cache.has(SUPPORT_ROLE_ID)) return replyEphemeral("❌ No permission.");
    const id = i.options.getInteger("id");
    const link = i.options.getString("link");
    const inv = invoices[id];
    if(!inv) return replyEphemeral(`❌ No invoice found with ID ${id}`);
    if(inv.status !== "completed") return replyEphemeral("❌ Invoice not marked as completed yet.");

    const user = await client.users.fetch(inv.userID);
    const issuer = await client.users.fetch(inv.issuerID);
    inv.status = "delivered";

    const deliverDM = new EmbedBuilder()
      .setTitle(`📦 Product Delivered #${id}`)
      .setColor("#27ae60")
      .setDescription(`Hello ${user.tag}, your **${inv.product}** has been delivered!`)
      .addFields(
        { name: "🔗 Product Link", value: link },
        { name: "💳 Payment Options", value: "[PayPal](https://paypal.me/YourLink) | [Venmo](https://venmo.com/YourLink) | [Tebex](https://your-tebex-link-here)" }
      )
      .setFooter({ text: `Invoice ID: ${id}` })
      .setTimestamp();

    try { await user.send({ embeds: [deliverDM] }); } 
    catch { return replyEphemeral(`❌ Couldn't DM ${user.tag}`); }

    await replyEphemeral(`✅ Product delivered to ${user.tag}`);
    if(LOG_CHANNEL_ID) {
      const logChannel = i.guild.channels.cache.get(LOG_CHANNEL_ID);
      if(logChannel) logChannel.send({ embeds: [createAuditEmbed({ invoiceID: id, amount: inv.amount, description: inv.product, issuer, clientUser: user, type: "deliver", extra: `Link: ${link}` })] });
    }
  }
});

client.login(TOKEN);

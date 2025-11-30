import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits
} from "discord.js";

const TOKEN = process.env.DISCORD_TOKEN;
const SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null;
const APP_ID = process.env.APP_ID;
const GUILD_ID = process.env.GUILD_ID; // Your test server ID

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ]
});

// ------------------ SLASH COMMANDS ------------------
const commands = [
  new SlashCommandBuilder()
    .setName("invoice")
    .setDescription("Send a payment invoice to a member.")
    .addUserOption(option =>
      option.setName("user").setDescription("User to invoice").setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName("amount").setDescription("Amount to be paid").setRequired(true)
    )
    .addStringOption(option =>
      option.setName("description").setDescription("What is this invoice for?").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("completeinvoice")
    .setDescription("Notify a customer that their product is ready.")
    .addUserOption(option =>
      option.setName("user").setDescription("Customer").setRequired(true)
    )
    .addStringOption(option =>
      option.setName("product").setDescription("Product name").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .toJSON()
];

// ------------------ REGISTER COMMANDS ------------------
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {
    // Clear global commands
    console.log("⚠️ Clearing all global commands...");
    await rest.put(Routes.applicationCommands(APP_ID), { body: [] });
    console.log("✅ Global commands cleared.");

    // Register guild commands for instant updates
    console.log("⚡ Registering guild commands...");
    await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
    console.log("✅ Guild commands registered.");
  } catch (error) {
    console.error("Error registering commands:", error);
  }
}
registerCommands();

// ------------------ PREMIUM AUDIT EMBED ------------------
function createAuditEmbed({ amount, description, issuer, clientUser }) {
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, "0");
  const timestamp = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} | ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  return new EmbedBuilder()
    .setColor("#2ecc71")
    .setTitle("🧾 Invoice Sent | Audit Log")
    .setDescription("A new invoice has been issued. Details below:")
    .setAuthor({ name: issuer.tag, iconURL: issuer.displayAvatarURL() })
    .setThumbnail(clientUser.displayAvatarURL())
    .addFields(
      { name: "💰 Amount Due", value: `$${amount}`, inline: true },
      { name: "📝 Product / Description", value: description, inline: true },
      { name: "\u200B", value: "\u200B", inline: false },
      { name: "👤 Client", value: clientUser.tag, inline: true },
      { name: "🆔 Client ID", value: clientUser.id, inline: true },
      { name: "\u200B", value: "\u200B", inline: false },
      { name: "👮 Issued By", value: issuer.tag, inline: true },
      { name: "🆔 Issuer ID", value: issuer.id, inline: true }
    )
    .setFooter({ text: `📅 ${timestamp}` })
    .setTimestamp();
}

// ------------------ BOT LOGIC ------------------
client.on("ready", () => {
  console.log(`Bot online as ${client.user.tag}`);
});

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;

  // --------- /invoice COMMAND ---------
  if (i.commandName === "invoice") {
    if (!i.member.roles.cache.has(SUPPORT_ROLE_ID)) {
      return i.reply({ content: "❌ You do not have permission.", ephemeral: true });
    }

    const user = i.options.getUser("user");
    const amount = i.options.getInteger("amount");
    const description = i.options.getString("description");

    // ---- DM to Customer ----
    const invoiceDM = new EmbedBuilder()
      .setTitle("📄 Your Invoice")
      .setColor("#2b6cb0")
      .setDescription(`Hello ${user.tag},\n\nYou have requested a **${description}**. Please pay the amount below to start the development of your product.`)
      .addFields(
        { name: "💰 Amount Due", value: `$${amount}` },
        { name: "📝 Product", value: description },
        { name: "Invoice Issued By", value: i.user.tag },
        { name: "💳 Payment Link", value: "[Pay on Tebex](https://your-tebex-link-here)" }
      )
      .setFooter({ text: `🕒 Invoice issued on ${new Date().toLocaleString()}` })
      .setTimestamp();

    try {
      await user.send({ embeds: [invoiceDM] });
    } catch {
      return i.reply({ content: "❌ I couldn't DM that user.", ephemeral: true });
    }

    await i.reply({ content: `✅ Invoice sent to **${user.tag}**`, ephemeral: true });

    // ---- Log in Audit Channel ----
    if (LOG_CHANNEL_ID) {
      const logChannel = i.guild.channels.cache.get(LOG_CHANNEL_ID);
      if (logChannel) {
        logChannel.send({ embeds: [createAuditEmbed({
          amount,
          description,
          issuer: i.user,
          clientUser: user
        })] });
      }
    }
  }

  // --------- /completeinvoice COMMAND ---------
  if (i.commandName === "completeinvoice") {
    if (!i.member.roles.cache.has(SUPPORT_ROLE_ID)) {
      return i.reply({ content: "❌ You do not have permission.", ephemeral: true });
    }

    const user = i.options.getUser("user");
    const product = i.options.getString("product");

    const readyEmbed = new EmbedBuilder()
      .setTitle("🎉 Your Product is Ready!")
      .setColor("#2ecc71")
      .setDescription(`Hello ${user.tag}, your **${product}** is complete!\n\nIf you haven’t paid yet, please do so via Tebex to receive your product.`)
      .addFields(
        { name: "💳 Payment Link", value: "[Pay on Tebex](https://your-tebex-link-here)" }
      )
      .setFooter({ text: `🕒 Completed on ${new Date().toLocaleString()}` })
      .setTimestamp();

    try {
      await user.send({ embeds: [readyEmbed] });
      await i.reply({ content: `✅ Product notification sent to ${user.tag}`, ephemeral: true });
    } catch {
      await i.reply({ content: `❌ Could not DM ${user.tag}`, ephemeral: true });
    }
  }
});

client.login(TOKEN);


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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ]
});

// ------- REGISTER SLASH COMMAND -------
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
    .toJSON()
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
    console.log("Commands registered globally.");
  } catch (error) {
    console.error("Error registering commands:", error);
  }
}
registerCommands();

// ------- COOL AUDIT EMBED FUNCTION -------
function createPremiumAuditEmbed({ amount, description, issuer, clientUser }) {
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, "0");
  const timestamp = `${pad(now.getDate())}/${pad(now.getMonth()+1)}/${now.getFullYear()} | ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  return new EmbedBuilder()
    .setColor("#2ecc71")
    .setTitle("🧾 Invoice Sent | Audit Log")
    .setDescription("A new invoice has been issued. Details below:")
    .setAuthor({ name: issuer.tag, iconURL: issuer.displayAvatarURL() })
    .setThumbnail(clientUser.displayAvatarURL())
    .addFields(
      // Invoice Info
      { name: "💰 Amount Due", value: `$${amount}`, inline: true },
      { name: "📝 Description / Product", value: description, inline: true },
      { name: "\u200B", value: "\u200B", inline: false },
      // Client Info
      { name: "👤 Client", value: clientUser.tag, inline: true },
      { name: "🆔 Client ID", value: clientUser.id, inline: true },
      { name: "\u200B", value: "\u200B", inline: false },
      // Issuer Info
      { name: "👮 Issued By", value: issuer.tag, inline: true },
      { name: "🆔 Issuer ID", value: issuer.id, inline: true }
    )
    .setFooter({ text: `📅 ${timestamp}` })
    .setTimestamp();
}

// ------- BOT LOGIC -------
client.on("ready", () => {
  console.log(`Bot online as ${client.user.tag}`);
});

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === "invoice") {
    // Permission check
    if (!i.member.roles.cache.has(SUPPORT_ROLE_ID)) {
      return i.reply({ content: "❌ You do not have permission.", ephemeral: true });
    }

    const user = i.options.getUser("user");
    const amount = i.options.getInteger("amount");
    const description = i.options.getString("description");

    // DM Embed
    const invoiceEmbed = new EmbedBuilder()
      .setTitle("📄 New Invoice")
      .setColor("#2b6cb0")
      .addFields(
        { name: "Amount Due", value: `$${amount}` },
        { name: "Description", value: description },
        { name: "Issued By", value: i.user.tag }
      )
      .setTimestamp();

    // Attempt DM
    try {
      await user.send({ embeds: [invoiceEmbed] });
    } catch {
      return i.reply({ content: "❌ I couldn't DM that user.", ephemeral: true });
    }

    await i.reply({ content: `✅ Invoice sent to **${user.tag}**`, ephemeral: true });

    // Audit log channel
    if (LOG_CHANNEL_ID) {
      const logChannel = i.guild.channels.cache.get(LOG_CHANNEL_ID);
      if (logChannel) {
        logChannel.send({ embeds: [createPremiumAuditEmbed({
          amount,
          description,
          issuer: i.user,
          clientUser: user
        })] });
      }
    }
  }
});

client.login(TOKEN);

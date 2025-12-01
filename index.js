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
  return Date.now() - member.user.createdTimestamp < altDays * 24 * 60 * 60 * 1000;
}

function createAuditEmbed({ title, description, color = "#3498db", extra }) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
  if (extra) embed.addFields({ name: "Extra Info", value: extra });
  return embed;
}

// ---------- SLASH COMMANDS ----------
const commands = [
  // Ticket
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

  // Invoice
  new SlashCommandBuilder()
    .setName("invoice")
    .setDescription("Send a payment invoice")
    .addUserOption(opt => opt.setName("user").setDescription("User to invoice").setRequired(true))
    .addIntegerOption(opt => opt.setName("amount").setDescription("Amount").setRequired(true))
    .addStringOption(opt => opt.setName("description").setDescription("Product description").setRequired(true))
    .toJSON(),

  // Set Alt Days
  new SlashCommandBuilder()
    .setName("setaltdays")
    .setDescription("Set alt detection days")
    .addIntegerOption(opt => opt.setName("days").setDescription("Days").setRequired(true))
    .toJSON(),

  // User Info
  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Get user information")
    .addUserOption(opt => opt.setName("user").setDescription("The user").setRequired(true))
    .toJSON(),

  // Warn
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a user")
    .addUserOption(opt => opt.setName("user").setDescription("User to warn").setRequired(true))
    .addStringOption(opt => opt.setName("reason").setDescription("Reason").setRequired(true))
    .toJSON(),

  // Kick
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a user")
    .addUserOption(opt => opt.setName("user").setDescription("User to kick").setRequired(true))
    .addStringOption(opt => opt.setName("reason").setDescription("Reason"))
    .toJSON(),

  // Ban
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a user")
    .addUserOption(opt => opt.setName("user").setDescription("User to ban").setRequired(true))
    .addStringOption(opt => opt.setName("reason").setDescription("Reason"))
    .toJSON(),

  // Add Role
  new SlashCommandBuilder()
    .setName("addrole")
    .setDescription("Add a role to a user")
    .addUserOption(opt => opt.setName("user").setDescription("User").setRequired(true))
    .addRoleOption(opt => opt.setName("role").setDescription("Role").setRequired(true))
    .toJSON(),

  // Remove Role
  new SlashCommandBuilder()
    .setName("removerole")
    .setDescription("Remove a role from a user")
    .addUserOption(opt => opt.setName("user").setDescription("User").setRequired(true))
    .addRoleOption(opt => opt.setName("role").setDescription("Role").setRequired(true))
    .toJSON(),

  // Purge Roles
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
  } catch (err) { console.error(err); }
}
registerCommands();

// ---------- BOT EVENTS ----------
client.on("ready", () => console.log(`🤖 Bot online as ${client.user.tag}`));

client.on("interactionCreate", async i => {
  if (!i.isChatInputCommand() && !i.isButton()) return;
  const replyPublic = msg => i.reply({ content: msg, ephemeral: true });
  const logChannel = i.guild.channels.cache.get(LOG_CHANNEL_ID);
  const member = await i.guild.members.fetch(i.user.id);

  // Alt account detection
  if (isAltAccount(member) && logChannel) {
    logChannel.send({
      embeds: [createAuditEmbed({
        title: "⚠️ Alt Account Detected",
        description: `${member.user.tag} has an account younger than ${altDays} days.`,
        color: "#ff0000"
      })]
    });
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
    } else if (action === "deliver") {
      invoice.status = "delivered";
    }

    const embed = createAuditEmbed({
      title: action === "complete" ? `✅ Invoice #${invoiceID} Completed` : `📦 Invoice #${invoiceID} Delivered`,
      description: `Invoice for **${invoice.product}** is now ${invoice.status}.`,
      color: action === "complete" ? "#f1c40f" : "#27ae60",
      extra: `Customer: ${user.tag}\nIssuer: ${issuer.tag}\nAmount: $${invoice.amount}`
    });

    await ticketChannel.send({ embeds: [embed] });
    if (logChannel) logChannel.send({ embeds: [embed] });
    return i.reply({ content: `✅ Invoice marked ${invoice.status}`, ephemeral: true });
  }

  // ---------- COMMAND HANDLER ----------
  try {
    switch(i.commandName) {
      case "ticket": {
        const type = i.options.getString("type");
        const everyonePing = type === "support" ? `<@&${SUPPORT_ROLE_ID}>` : "";
        const ticketChannel = await i.guild.channels.create({
          name: `${i.user.username}-${type}-ticket`,
          type: 0,
          permissionOverwrites: [
            { id: i.guild.id, deny: ["ViewChannel"] },
            { id: i.user.id, allow: ["ViewChannel","SendMessages"] },
            { id: SUPPORT_ROLE_ID, allow: ["ViewChannel","SendMessages"] },
          ],
        });
        const embed = new EmbedBuilder()
          .setTitle(`${type} Ticket`)
          .setDescription(`${everyonePing}\nA staff member will assist you shortly.`)
          .setColor("#f1c40f")
          .setTimestamp();
        await ticketChannel.send({ content: everyonePing, embeds: [embed] });
        await i.reply({ content: `✅ Ticket created: ${ticketChannel}`, ephemeral: true });
        break;
      }

      case "invoice": {
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

        const embed = new EmbedBuilder()
          .setTitle(`🧾 Invoice #${invoiceID}`)
          .setDescription(`Invoice for **${description}**`)
          .addFields(
            { name:"Customer", value:user.tag, inline:true },
            { name:"Issuer", value:i.user.tag, inline:true },
            { name:"Amount", value:`$${amount}`, inline:true },
            { name:"Status", value:"Pending", inline:true },
            { name:"Payment Options", value:"[Venmo](https://venmo.com/u/Nick-Welge) | [Paypal](https://www.paypal.com/paypalme/NickWelge) | [CashApp](https://cash.app/$KLHunter2008)" }
          ).setColor("#3498db").setTimestamp();

        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`complete-${invoiceID}`).setLabel("Mark Completed").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`deliver-${invoiceID}`).setLabel("Mark Delivered").setStyle(ButtonStyle.Success)
        );

        await ticketChannel.send({ content:`<@${user.id}>`, embeds:[embed], components:[buttons] });
        await i.reply({ content: `✅ Invoice #${invoiceID} created in ticket: ${ticketChannel}`, ephemeral: true });
        break;
      }

      case "setaltdays":
        altDays = i.options.getInteger("days");
        replyPublic(`✅ Alt detection days set to ${altDays}`);
        break;

      case "userinfo": {
        const user = i.options.getUser("user");
        const m = await i.guild.members.fetch(user.id);
        const embed = new EmbedBuilder()
          .setTitle(`ℹ️ User Info: ${user.tag}`)
          .setColor("#3498db")
          .addFields(
            { name:"ID", value:user.id, inline:true },
            { name:"Joined", value:m.joinedAt.toDateString(), inline:true },
            { name:"Account Created", value:user.createdAt.toDateString(), inline:true },
            { name:"Roles", value:m.roles.cache.map(r=>r.name).join(", "), inline:false },
            { name:"Warnings", value:(warnings[user.id]?.join("\n")||"None"), inline:false }
          );
        i.reply({ embeds:[embed], ephemeral:true });
        break;
      }

      case "warn": {
        const user = i.options.getUser("user");
        const reason = i.options.getString("reason");
        if(!warnings[user.id]) warnings[user.id]=[];
        warnings[user.id].push(reason);
        const embed = createAuditEmbed({ title:"⚠️ User Warned", description:`${user.tag} was warned.\nReason: ${reason}`, color:"#f39c12" });
        if(logChannel) logChannel.send({ embeds:[embed] });
        replyPublic(`✅ ${user.tag} has been warned.`);
        break;
      }

      case "kick": {
        const user = i.options.getUser("user");
        const reason = i.options.getString("reason")||"No reason";
        const m = await i.guild.members.fetch(user.id);
        await m.kick(reason);
        const embed = createAuditEmbed({ title:"👢 User Kicked", description:`${user.tag} was kicked.\nReason: ${reason}`, color:"#e67e22" });
        if(logChannel) logChannel.send({ embeds:[embed] });
        replyPublic(`✅ ${user.tag} was kicked.`);
        break;
      }

      case "ban": {
        const user = i.options.getUser("user");
        const reason = i.options.getString("reason")||"No reason";
        const m = await i.guild.members.fetch(user.id);
        await m.ban({ reason });
        const embed = createAuditEmbed({ title:"⛔ User Banned", description:`${user.tag} was banned.\nReason: ${reason}`, color:"#c0392b" });
        if(logChannel) logChannel.send({ embeds:[embed] });
        replyPublic(`✅ ${user.tag} was banned.`);
        break;
      }

      case "addrole": {
        const user = i.options.getUser("user");
        const role = i.options.getRole("role");
        const m = await i.guild.members.fetch(user.id);
        await m.roles.add(role);
        const embed = createAuditEmbed({ title:"➕ Role Added", description:`Added ${role.name} to ${user.tag}`, color:"#2ecc71" });
        if(logChannel) logChannel.send({ embeds:[embed] });
        replyPublic(`✅ Added ${role.name} to ${user.tag}`);
        break;
      }

      case "removerole": {
        const user = i.options.getUser("user");
        const role = i.options.getRole("role");
        const m = await i.guild.members.fetch(user.id);
        await m.roles.remove(role);
        const embed = createAuditEmbed({ title:"➖ Role Removed", description:`Removed ${role.name} from ${user.tag}`, color:"#e74c3c" });
        if(logChannel) logChannel.send({ embeds:[embed] });
        replyPublic(`✅ Removed ${role.name} from ${user.tag}`);
        break;
      }

      case "purgeroles": {
        const user = i.options.getUser("user");
        const m = await i.guild.members.fetch(user.id);
        await m.roles.set([]);
        const embed = createAuditEmbed({ title:"🗑️ Roles Purged", description:`All roles removed from ${user.tag}`, color:"#9b59b6" });
        if(logChannel) logChannel.send({ embeds:[embed] });
        replyPublic(`✅ All roles removed from ${user.tag}`);
        break;
      }

      default:
        replyPublic("❌ Unknown command.");
        break;
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

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
} from "discord.js";

// ---------- ENV ----------
const TOKEN = process.env.DISCORD_TOKEN;
const SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID;
const INVOICE_LOG_ID = "1444496474690813972"; // Invoice Audit Log
const MOD_LOG_ID = "1444845107084787722";     // Moderation Logs
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
const invoices = {}; // invoiceID: { userID, issuerID, product, amount, status, ticketID, createdAt }
const warnings = {}; // userID: [reason1, reason2]
let altDays = 7;

// ---------- HELPERS ----------
function isAltAccount(member) {
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

// ---------- SLASH COMMANDS ----------
const commands = [
  new SlashCommandBuilder().setName("ticket").setDescription("Open a ticket")
    .addStringOption(opt => opt.setName("type").setDescription("Type of ticket").setRequired(true)
      .addChoices(
        { name: "Support", value: "support" },
        { name: "EUP Commissions", value: "eup" },
        { name: "Livery Commissions", value: "livery" }
      )).toJSON(),

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
    console.error(err);
  }
}
registerCommands();

// ---------- BOT EVENTS ----------
client.on("ready", () => {
  console.log(`🤖 Bot online as ${client.user.tag}`);

  // ---------- AUTOMATIC INVOICE REMINDERS ----------
  setInterval(async () => {
    for (const [id, invoice] of Object.entries(invoices)) {
      if (invoice.status === "pending") {
        const user = await client.users.fetch(invoice.userID).catch(() => null);
        if (user) user.send(`Reminder: Invoice #${id} for **${invoice.product}** is still pending. Please complete the payment.`).catch(()=>{});
      }
    }
  }, 1000 * 60 * 60); // every 1 hour
});

// ---------- INTERACTION HANDLER ----------
client.on("interactionCreate", async interaction => {
  const logInvoice = interaction.guild.channels.cache.get(INVOICE_LOG_ID);
  const logMod = interaction.guild.channels.cache.get(MOD_LOG_ID);
  const member = await interaction.guild.members.fetch(interaction.user.id);

  const reply = (msg) => {
    if (!msg) msg = "❌ Something went wrong.";
    if (typeof msg === "string") interaction.reply({ content: msg, flags: 0 }).catch(()=>{});
    else if (msg.embeds) interaction.reply({ embeds: msg.embeds, flags: 0 }).catch(()=>{});
  };

  // ---------- ALT ACCOUNT DETECTION ----------
  let isAlt = isAltAccount(member);
  if (isAlt) {
    const embed = createEmbed({
      title: "⚠️ Alt Account Detected",
      description: `${member.user.tag} has an account younger than ${altDays} days.`,
      color: "#ff0000"
    });
    if(logMod) logMod.send({ embeds:[embed] });
  }

  // ---------- BUTTON HANDLER ----------
  if(interaction.isButton()){
    const [action, invoiceID] = interaction.customId.split("-");
    const invoice = invoices[invoiceID];
    if(!invoice) return reply("Invoice not found");

    const user = await client.users.fetch(invoice.userID);
    const issuer = await client.users.fetch(invoice.issuerID);
    const ticketChannel = await interaction.guild.channels.fetch(invoice.ticketID);

    if(action === "complete"){
      invoice.status="completed";
      const embed = createEmbed({
        title:`✅ Invoice #${invoiceID} Completed`,
        description:`Invoice for **${invoice.product}** is completed.`,
        color:"#f1c40f",
        extra:`Customer: ${user.tag}\nIssuer: ${issuer.tag}\nAmount: $${invoice.amount}`
      });
      if(ticketChannel) ticketChannel.send({embeds:[embed]});
      if(logInvoice) logInvoice.send({embeds:[embed]});
      return reply(`✅ Invoice #${invoiceID} marked completed`);
    }

    if(action === "deliver"){
      invoice.status="delivered";
      const embed = createEmbed({
        title:`📦 Invoice #${invoiceID} Delivered`,
        description:`Invoice for **${invoice.product}** delivered.`,
        color:"#27ae60",
        extra:`Customer: ${user.tag}\nIssuer: ${issuer.tag}\nAmount: $${invoice.amount}`
      });
      if(ticketChannel) ticketChannel.send({embeds:[embed]});
      if(logInvoice) logInvoice.send({embeds:[embed]});
      return reply(`✅ Invoice #${invoiceID} marked delivered`);
    }
  }

  // ---------- COMMAND HANDLER ----------
  if(!interaction.isChatInputCommand()) return;

  try{
    switch(interaction.commandName){
      case "ticket": {
        const type = interaction.options.getString("type");
        const ping = type==="support"?`<@&${SUPPORT_ROLE_ID}>`:"";
        const ticketChannel = await interaction.guild.channels.create({
          name:`${interaction.user.username}-${type}-ticket`,
          type:0,
          permissionOverwrites:[
            {id:interaction.guild.id,deny:["ViewChannel"]},
            {id:interaction.user.id,allow:["ViewChannel","SendMessages"]},
            {id:SUPPORT_ROLE_ID,allow:["ViewChannel","SendMessages"]},
          ]
        });
        const embed = createEmbed({title:`${type} Ticket`,description:`${ping}\nA staff member will assist you shortly.`,color:"#f1c40f"});
        await ticketChannel.send({content:ping,embeds:[embed]});
        reply(`✅ Ticket created: ${ticketChannel}`);
        break;
      }

      case "invoice": {
        if(!interaction.member.roles.cache.has(SUPPORT_ROLE_ID)) return reply("❌ No permission.");
        const user = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");
        const desc = interaction.options.getString("description");
        const invoiceID = Math.floor(1000+Math.random()*9000);

        const ticketChannel = await interaction.guild.channels.create({
          name:`invoice-${invoiceID}`,
          type:0,
          permissionOverwrites:[
            {id:interaction.guild.id,deny:["ViewChannel"]},
            {id:interaction.user.id,allow:["ViewChannel","SendMessages"]},
            {id:SUPPORT_ROLE_ID,allow:["ViewChannel","SendMessages"]},
          ]
        });

        invoices[invoiceID]={userID:user.id,issuerID:interaction.user.id,product:desc,amount,status:"pending",ticketID:ticketChannel.id,createdAt:Date.now()};

        const embed = createEmbed({
          title:`🧾 Invoice #${invoiceID}`,
          description:`Invoice for **${desc}**`,
          color:"#3498db",
          extra:`Customer: ${user.tag}\nIssuer: ${interaction.user.tag}\nAmount: $${amount}\nStatus: Pending\nPayment Options: [Venmo](https://venmo.com/u/Nick-Welge) | [Paypal](https://www.paypal.com/paypalme/NickWelge) | [CashApp](https://cash.app/$KLHunter2008)`
        });

        const buttons = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId(`complete-${invoiceID}`).setLabel("Mark Completed").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`deliver-${invoiceID}`).setLabel("Mark Delivered").setStyle(ButtonStyle.Success)
          );

        await ticketChannel.send({content:`<@${user.id}>`,embeds:[embed],components:[buttons]});
        if(logInvoice) logInvoice.send({embeds:[embed]});
        reply(`✅ Invoice #${invoiceID} created in ticket: ${ticketChannel}`);
        break;
      }

      case "deleteinvoice": {
        const id = interaction.options.getInteger("id");
        const invoice = invoices[id];
        if(!invoice) return reply("❌ Invoice not found");
        const ticketChannel = await interaction.guild.channels.fetch(invoice.ticketID);
        if(ticketChannel) ticketChannel.delete().catch(()=>{});
        delete invoices[id];
        if(logInvoice) logInvoice.send({embeds:[createEmbed({title:`🗑️ Invoice #${id} Deleted`,description:`Invoice removed by ${interaction.user.tag}`,color:"#e74c3c"})]});
        reply(`✅ Invoice #${id} deleted`);
        break;
      }

      case "setaltdays":
        altDays=interaction.options.getInteger("days");
        reply(`✅ Alt detection set to ${altDays} days`);
        break;

      case "userinfo": {
        const user = interaction.options.getUser("user");
        const m = await interaction.guild.members.fetch(user.id).catch(()=>null);
        const lastMsg = interaction.channel.messages.cache.filter(msg=>msg.author.id===user.id).last();
        const lastVC = m?.voice?.channel;
        const invoice = Object.entries(invoices).find(([k,v])=>v.userID===user.id);
        const modHistory = warnings[user.id] || [];
        const isUserAlt = m?isAltAccount(m):false;

        const statusInfo = invoice ? `Invoice #${Object.keys(invoices).find(k=>invoices[k].userID===user.id)} | ${invoices[Object.keys(invoices).find(k=>invoices[k].userID===user.id)].status}` : "No Invoice Found";
        let embedColor = "#2ecc71"; // green by default
        let emoji = "✅";

        if(isUserAlt){ embedColor="#ff0000"; emoji="⚠️"; }
        else if(modHistory.length>0){ embedColor="#f1c40f"; emoji="❓"; }

        const embed = new EmbedBuilder()
          .setTitle(`${emoji} User Info: ${user.tag}`)
          .setColor(embedColor)
          .addFields(
            {name:"Name",value:user.tag,inline:true},
            {name:"Discord ID",value:user.id,inline:true},
            {name:"Joined Server",value:m?.joinedAt?.toDateString()||"Unknown",inline:true},
            {name:"Account Created",value:user.createdAt.toDateString(),inline:true},
            {name:"Invoice Status",value:statusInfo,inline:true},
            {name:"Invoice Date",value:invoice?new Date(invoice.createdAt).toDateString():"N/A",inline:true},
            {name:"Roles",value:m?m.roles.cache.map(r=>r.name).join(", ")||"None":"None",inline:false},
            {name:"Last Message",value:lastMsg?`${lastMsg.createdAt} in <#${lastMsg.channel.id}>`:"No messages found",inline:false},
            {name:"Last VC",value:lastVC?`${lastVC.name} at ${new Date().toDateString()}`:"Never connected",inline:false},
            {name:"Moderation History",value:modHistory.length>0?modHistory.join("\n"):"None",inline:false},
            {name:"Flags",value:isUserAlt?"Alt Account Detected":"None",inline:false}
          );
        reply({embeds:[embed]});
        break;
      }

      case "warn":{
        const user = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason");
        if(!warnings[user.id]) warnings[user.id]=[];
        warnings[user.id].push(reason);
        if(logMod) logMod.send({embeds:[createEmbed({title:"⚠️ User Warned",description:`${user.tag} warned by ${interaction.user.tag}\nReason: ${reason}`,color:"#f39c12"})]});
        reply(`✅ ${user.tag} has been warned`);
        break;
      }

      case "kick":{
        const user = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason")||"No reason";
        const m = await interaction.guild.members.fetch(user.id);
        await m.kick(reason);
        if(logMod) logMod.send({embeds:[createEmbed({title:"👢 User Kicked",description:`${user.tag} kicked by ${interaction.user.tag}\nReason: ${reason}`,color:"#e67e22"})]});
        reply(`✅ ${user.tag} was kicked`);
        break;
      }

      case "ban":{
        const user = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason")||"No reason";
        const m = await interaction.guild.members.fetch(user.id);
        await m.ban({reason});
        if(logMod) logMod.send({embeds:[createEmbed({title:"⛔ User Banned",description:`${user.tag} banned by ${interaction.user.tag}\nReason: ${reason}`,color:"#c0392b"})]});
        reply(`✅ ${user.tag} was banned`);
        break;
      }

      case "addrole":{
        const user = interaction.options.getUser("user");
        const role = interaction.options.getRole("role");
        const m = await interaction.guild.members.fetch(user.id);
        await m.roles.add(role);
        if(logMod) logMod.send({embeds:[createEmbed({title:"➕ Role Added",description:`Added ${role.name} to ${user.tag}`,color:"#2ecc71"})]});
        reply(`✅ Added ${role.name} to ${user.tag}`);
        break;
      }

      case "removerole":{
        const user = interaction.options.getUser("user");
        const role = interaction.options.getRole("role");
        const m = await interaction.guild.members.fetch(user.id);
        await m.roles.remove(role);
        if(logMod) logMod.send({embeds:[createEmbed({title:"➖ Role Removed",description:`Removed ${role.name} from ${user.tag}`,color:"#e74c3c"})]});
        reply(`✅ Removed ${role.name} from ${user.tag}`);
        break;
      }

      case "purgeroles":{
        const user = interaction.options.getUser("user");
        const m = await interaction.guild.members.fetch(user.id);
        await m.roles.set([]);
        if(logMod) logMod.send({embeds:[createEmbed({title:"🗑️ Roles Purged",description:`All roles removed from ${user.tag}`,color:"#9b59b6"})]});
        reply(`✅ All roles removed from ${user.tag}`);
        break;
      }

      default: reply("❌ Unknown command."); break;
    }
  } catch(err){console.error(err); reply("❌ Something went wrong.");}
});

// ---------- EXPRESS KEEP-ALIVE ----------
const app = express();
app.get("/", (req,res)=>res.send("Bot is running!"));
const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log(`✔ Web server running on port ${PORT}`));

// ---------- LOGIN ----------
client.login(TOKEN);

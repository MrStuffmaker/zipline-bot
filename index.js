// index.js
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { deployCommands } from './deploy-commands.js';
import { registerInteractionHandler } from './handlers/interactionCreate.js';
import fs from 'fs';
import chalk from 'chalk';

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

function logSuccess(msg) {
  console.log(chalk.green('[SUCCESS]'), msg);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, () => {
  logSuccess(`Logged in as ${client.user.tag}`);
  client.user.setPresence({
    status: 'online',
    activities: [{
      name: 'www.stuffmaker.net',
      type: 4,
    }],
  });
});

// register interaction handler
registerInteractionHandler(client);

await deployCommands(config.discordToken, config.clientId);
await client.login(config.discordToken);

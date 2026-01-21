import { REST, Routes, ApplicationCommandType } from 'discord.js';
import { data as ziplineData } from './commands/zipline.js';
import chalk from 'chalk';

function logInfo(msg) { console.log(chalk.blue('[INFO]'), msg); }
function logSuccess(msg) { console.log(chalk.green('[SUCCESS]'), msg); }
function logError(error, ctx = '') {
  console.error(chalk.red('[ERROR]'), ctx, error);
}

export async function deployCommands(token, clientId) {
  const rest = new REST({ version: '10' }).setToken(token);

  // Slash command
  const ziplineJson = ziplineData.toJSON();
  ziplineJson.contexts = [0, 1, 2]; // GUILD, BOT_DM, PRIVATE_CHANNEL

  // Message context menu command
  const ziplineMessageCommand = {
    name: 'Upload with Zipline',
    type: ApplicationCommandType.Message, // 3 
    contexts: [0, 1, 2],                 // same contexts
  };

  try {
    logInfo('Registering global application commands...');
    await rest.put(
      Routes.applicationCommands(clientId),
      { body: [ziplineJson, ziplineMessageCommand] },
    );
    logSuccess('Application commands registered successfully.');
  } catch (err) {
    logError(err, 'Registering application commands');
  }
}
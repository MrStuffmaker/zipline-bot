import { Events, MessageFlags, ApplicationCommandType } from 'discord.js';
import {
  execute as executeZipline,
  handleComponents as handleZiplineComponents,
  handleMessageUpload as handleZiplineMessageUpload
} from '../commands/zipline.js';
import chalk from 'chalk';

function logError(error, ctx = '') {
  console.error(chalk.red('[ERROR]'), ctx);
  if (error instanceof Error) console.error(chalk.red(error.stack));
  else console.error(chalk.red(error));
}

export function registerInteractionHandler(client) {
  client.on(Events.InteractionCreate, async interaction => {
    try {
      // Slash commands
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'zipline') {
          await executeZipline(interaction);
        }
        return;
      }

      // Message context menu: "Upload with Zipline"
      if (
        interaction.isMessageContextMenuCommand() &&
        interaction.commandName === 'Upload with Zipline'
      ) {
        await handleZiplineMessageUpload(interaction);
        return;
      }

      // Components & modals for zipline (buttons, modals, pagination, settings)
      const handled = await handleZiplineComponents(interaction);
      if (handled) return;
    } catch (error) {
      logError(error, 'InteractionHandler');
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply('❌ An error occurred.');
        } else {
          await interaction.reply({
            content: '❌ An error occurred.',
            flags: MessageFlags.Ephemeral
          });
        }
      } catch {
        // ignore follow-up errors
      }
    }
  });
}
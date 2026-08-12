'use strict';

require('dotenv').config();

/**
 * Central config. Secrets are ONLY ever read from process.env.
 * Nothing in this file is sent to the browser.
 */
const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,

  mongodbUri: process.env.MONGODB_URI || '',

  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',

  // Comma-separated list of allowed browser origins in production.
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // How many prior messages of a conversation to replay into the model.
  historyLimit: Number(process.env.HISTORY_LIMIT) || 20,

  // Treat cached hiscores older than this (minutes) as stale.
  playerCacheMinutes: Number(process.env.PLAYER_CACHE_MINUTES) || 30,
};

config.isProduction = config.env === 'production';

/**
 * Reports which required environment variables are missing.
 * We warn instead of crashing so /health and the frontend still work,
 * which makes local setup far easier to debug.
 */
function checkEnv() {
  const missing = [];
  if (!config.mongodbUri) missing.push('MONGODB_URI');
  if (!config.openaiApiKey) missing.push('OPENAI_API_KEY');
  return missing;
}

module.exports = { config, checkEnv };

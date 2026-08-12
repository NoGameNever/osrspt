'use strict';

const mongoose = require('mongoose');
const { config } = require('./config');

let state = {
  configured: Boolean(config.mongodbUri),
  connected: false,
  lastError: null,
};

/**
 * Connects to MongoDB Atlas. Never throws — a database outage should
 * degrade the app (chat still answers, nothing persists) rather than
 * take the whole process down.
 */
async function connectDb() {
  if (!config.mongodbUri) {
    state.configured = false;
    console.warn('[db] MONGODB_URI is not set — running without persistence.');
    return false;
  }

  mongoose.connection.on('connected', () => {
    state.connected = true;
    state.lastError = null;
    console.log('[db] connected');
  });
  mongoose.connection.on('disconnected', () => {
    state.connected = false;
    console.warn('[db] disconnected');
  });
  mongoose.connection.on('error', (err) => {
    state.connected = false;
    state.lastError = err.message;
    console.error('[db] error:', err.message);
  });

  try {
    await mongoose.connect(config.mongodbUri, {
      serverSelectionTimeoutMS: 10000,
    });
    state.connected = true;
    return true;
  } catch (err) {
    state.connected = false;
    state.lastError = err.message;
    // Deliberately log only the message, never the full URI/credentials.
    console.error('[db] initial connection failed:', err.message);
    return false;
  }
}

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

function dbStatus() {
  if (!state.configured) return 'not-configured';
  return isDbReady() ? 'connected' : 'disconnected';
}

async function disconnectDb() {
  try {
    await mongoose.connection.close();
  } catch (_) {
    /* ignore */
  }
}

module.exports = { connectDb, disconnectDb, isDbReady, dbStatus };

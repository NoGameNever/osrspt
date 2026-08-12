'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { config, checkEnv } = require('./config');
const { dbStatus } = require('./db');
const ai = require('./services/openai');
const { notFound, errorHandler } = require('./middleware/errors');

const chatRouter = require('./routes/chat');
const playerRouter = require('./routes/player');
const pricesRouter = require('./routes/prices');

function createApp() {
  const app = express();

  // Render / any reverse proxy: needed for correct client IPs in rate limiting.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  // Frontend is served from the same origin, so CORS is only needed if an
  // explicit allow-list is configured.
  if (config.corsOrigins.length > 0) {
    app.use(cors({ origin: config.corsOrigins, methods: ['GET', 'POST'] }));
  } else if (!config.isProduction) {
    app.use(cors({ origin: true }));
  }

  app.use(express.json({ limit: '32kb' }));

  // --- Health (never rate limited, no secrets) ---
  app.get('/health', (req, res) => {
    const missing = checkEnv();
    res.json({
      status: 'ok',
      env: config.env,
      uptimeSeconds: Math.round(process.uptime()),
      database: dbStatus(),
      ai: ai.isConfigured() ? 'configured' : 'not-configured',
      // Names only — never values.
      missingEnv: missing,
    });
  });

  // --- Rate limiting ---
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' } },
  });

  const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 12,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      error: { code: 'RATE_LIMITED', message: 'Too many chat messages. Wait a moment.' },
    },
  });

  const lookupLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      error: { code: 'RATE_LIMITED', message: 'Too many hiscores lookups. Wait a moment.' },
    },
  });

  // Price data is served from an in-memory cache, so it is cheap for us but
  // still worth bounding.
  const pricesLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 40,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      error: { code: 'RATE_LIMITED', message: 'Too many price lookups. Wait a moment.' },
    },
  });

  app.use('/api', apiLimiter);
  app.use('/api/chat', chatLimiter, chatRouter);
  app.use('/api/player/lookup', lookupLimiter);
  app.use('/api/player', playerRouter);
  app.use('/api/prices', pricesLimiter, pricesRouter);

  // --- Static frontend ---
  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      maxAge: config.isProduction ? '1h' : 0,
      extensions: ['html'],
    })
  );

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };

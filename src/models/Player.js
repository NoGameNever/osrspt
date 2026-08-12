'use strict';

const mongoose = require('mongoose');

/**
 * A cached snapshot of PUBLIC OSRS hiscores data for an RSN.
 * We store no personal information — only the display name the user
 * typed and the publicly published hiscores numbers.
 */
const SkillSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    rank: { type: Number, default: -1 },
    level: { type: Number, default: 1 },
    xp: { type: Number, default: 0 },
  },
  { _id: false }
);

const ActivitySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    rank: { type: Number, default: -1 },
    score: { type: Number, default: -1 },
  },
  { _id: false }
);

const PlayerSchema = new mongoose.Schema(
  {
    // Normalized lowercase key so lookups are case-insensitive.
    rsnKey: { type: String, required: true, unique: true, index: true },
    // The RSN as displayed / typed.
    rsn: { type: String, required: true },
    publicStats: {
      source: { type: String, default: 'osrs-hiscores' },
      mode: { type: String, default: 'main' },
      combatLevel: { type: Number, default: null },
      totalLevel: { type: Number, default: null },
      totalXp: { type: Number, default: null },
      skills: { type: [SkillSchema], default: [] },
      activities: { type: [ActivitySchema], default: [] },
    },
    lastUpdated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Player || mongoose.model('Player', PlayerSchema);

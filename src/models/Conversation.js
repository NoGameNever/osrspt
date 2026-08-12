'use strict';

const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
    content: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ConversationSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    // The RSN the session is currently operating on, if the user gave one.
    rsn: { type: String, default: null },
    // Whether the user granted permission to fetch public hiscores in this session.
    lookupPermissionGranted: { type: Boolean, default: false },
    messages: { type: [MessageSchema], default: [] },
  },
  { timestamps: true } // gives us createdAt / updatedAt
);

module.exports =
  mongoose.models.Conversation || mongoose.model('Conversation', ConversationSchema);

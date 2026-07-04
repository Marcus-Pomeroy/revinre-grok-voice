const express = require('express');
const twilio = require('twilio');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

// In-memory notepad: call_sid -> lead info
const callLeadMap = {};

// Bridge to Grok Voice
app.post('/voice', (req, res) => {
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial answerOnBridge="true" record="record-from-answer">
    <Sip>${process.env.XAI_SIP_URI}</Sip>
  </Dial>
</Response>`);
});

// Start outbound call from Zapier (pass lead info)
app.post('/call', async (req, res) => {
  try {
    const { to, lofty_lead_id, lead_name, lead_email } = req.body;

    const call = await client.calls.create({
      url: `${process.env.PUBLIC_URL}/voice`,
      to,
      from: process.env.TWILIO_NUMBER,
      method: 'POST',
      record: true,
      statusCallback: `${process.env.PUBLIC_URL}/status`

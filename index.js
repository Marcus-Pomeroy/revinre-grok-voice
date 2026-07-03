const express = require('express');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(express.json());

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

// Twilio fetches this when the lead answers -> bridges the call into Grok/Brad
app.post('/voice', (req, res) => {
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial answerOnBridge="true">
    <Sip>sip:${process.env.TWILIO_NUMBER.replace('+','+')}@sip.voice.x.ai;transport=tls</Sip>
  </Dial>
</Response>`);
});

// Zapier calls this to start the outbound call
app.post('/call', async (req, res) => {
  try {
    const { to } = req.body;
    const call = await client.calls.create({
      url: `${process.env.PUBLIC_URL}/voice`,
      to,
      from: process.env.TWILIO_NUMBER,
      method: 'POST'
    });
    res.json({ success: true, call_sid: call.sid });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on 0.0.0.0:${PORT}`));

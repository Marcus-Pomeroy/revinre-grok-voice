const express = require('express');
const twilio = require('twilio');

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Revinre Grok voice app is running');
});

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

app.post('/call', async (req, res) => {
  try {
    const { to } = req.body;

    const call = await client.calls.create({
      url: `https://api.x.ai/v1/voice/agents/${process.env.AGENT_ID}/call`,
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on 0.0.0.0:${PORT}`);
});

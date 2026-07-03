const express = require('express');
const twilio = require('twilio');

const app = express();
app.use(express.json());

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

app.post('/call', async (req, res) => {
  try {
    const { to } = req.body;
    const call = await client.calls.create({
      url: `https://api.x.ai/v1/voice/agents/${process.env.AGENT_ID}/call`,
      to: to,
      from: process.env.TWILIO_NUMBER,
      method: 'POST'
    });
    res.json({ success: true, call_sid: call.sid });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

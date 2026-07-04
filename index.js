const express = require('express');
const twilio = require('twilio');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

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
      record: true,                    // Enable recording
      statusCallback: `${process.env.PUBLIC_URL}/status`, // Optional: get status updates
      statusCallbackMethod: 'POST'
    });

    res.json({ 
      success: true, 
      call_sid: call.sid,
      lofty_lead_id,
      message: "Call started. Check /call/" + call.sid + " later for full details."
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get full call data (this is what you'll call from Zapier later)
app.get('/call/:callSid', async (req, res) => {
  try {
    const callSid = req.params.callSid;

    const twilioCall = await client.calls(callSid).fetch();

    let xaiData = null;
    try {
      const xaiRes = await axios.get(`https://api.x.ai/v1/voice/calls/${callSid}`, {
        headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` }
      });
      xaiData = xaiRes.data;
    } catch (e) {
      xaiData = "No xAI transcript available yet";
    }

    const responseData = {
      call_sid: callSid,
      lofty_lead_id: req.query.lofty_lead_id || "unknown",
      status: twilioCall.status,
      duration: twilioCall.duration,
      from: twilioCall.from,
      to: twilioCall.to,
      recording_url: twilioCall.recordingUrl,
      price: twilioCall.price,
      xai_transcript: xaiData,
      timestamp: new Date().toISOString()
    };

    res.json(responseData);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Optional: Status callback from Twilio
app.post('/status', (req, res) => {
  console.log("Call status update:", req.body);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on 0.0.0.0:${PORT}`));

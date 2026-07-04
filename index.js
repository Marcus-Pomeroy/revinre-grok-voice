const express = require('express');
const twilio = require('twilio');

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
    const { to, lofty_lead_id, lead_name, lead_email, property_address } = req.body;

    const call = await client.calls.create({
      url: `${process.env.PUBLIC_URL}/voice`,
      to,
      from: process.env.TWILIO_NUMBER,
      method: 'POST',
      record: true,
      statusCallback: `${process.env.PUBLIC_URL}/status`,
      statusCallbackMethod: 'POST'
    });

    callLeadMap[call.sid] = {
      lofty_lead_id: lofty_lead_id || "unknown",
      lead_name: lead_name || "unknown",
      lead_email: lead_email || "unknown",
      property_address: property_address || "unknown",
      created_at: new Date().toISOString()
    };

    console.log(`Call started: ${call.sid} for lead ${lofty_lead_id} (${lead_name}) property: ${property_address}`);

    res.json({
      success: true,
      call_sid: call.sid,
      lofty_lead_id,
      message: "Call started. Check /call/" + call.sid + " later for full details."
    });
  } catch (error) {
    console.error("Error starting call:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper: fetch Voice Intelligence transcript for a recording SID
async function fetchVoiceIntelligenceTranscript(recordingSid) {
  try {
    const transcripts = await client.intelligence.v2.transcripts.list({
      sourceSid: recordingSid,
      limit: 1
    });

    if (transcripts.length === 0) {
      return { status: "not_found", text: null, sentences: [] };
    }

    const transcript = transcripts[0];

    if (transcript.status !== "completed") {
      return { status: transcript.status, text: null, sentences: [] };
    }

    // Fetch sentences
    const sentences = await client.intelligence.v2
      .transcripts(transcript.sid)
      .sentences
      .list({ limit: 500 });

    const formatted = sentences.map(s => ({
      speaker: s.mediaChannel !== undefined ? `speaker_${s.mediaChannel}` : "speaker",
      text: s.transcript || s.text || "",
      confidence: s.confidence
    }));

    const fullText = formatted.map(s => `${s.speaker}: ${s.text}`).join('\n');

    return {
      status: "completed",
      transcript_sid: transcript.sid,
      text: fullText,
      sentences: formatted
    };
  } catch (error) {
    console.log("Transcript fetch error:", error.message);
    return { status: "error", text: null, sentences: [], error: error.message };
  }
}

// Get full call data (Zapier hits this to update Lofty)
app.get('/call/:callSid', async (req, res) => {
  try {
    const callSid = req.params.callSid;

    const leadInfo = callLeadMap[callSid] || {
      lofty_lead_id: req.query.lofty_lead_id || "unknown",
      lead_name: "unknown",
      lead_email: "unknown",
      property_address: "unknown",
      created_at: null
    };

    const twilioCall = await client.calls(callSid).fetch();

    let recording_url = null;
    let recording_sid = null;
    let recording_duration = null;
    try {
      const recordings = await client.recordings.list({ callSid, limit: 1 });
      if (recordings.length > 0) {
        recording_sid = recordings[0].sid;
        recording_url = `https://api.twilio.com${recordings[0].uri.replace('.json', '.mp3')}`;
        recording_duration = recordings[0].duration;
      }
    } catch (e) {
      console.log("No recording available yet:", e.message);
    }

    // Voice Intelligence transcript (auto-created since Auto Transcribe is ON)
    let transcript_status = "no_recording";
    let transcript_text = null;
    let transcript_sentences = [];
    if (recording_sid) {
      const vi = await fetchVoiceIntelligenceTranscript(recording_sid);
      transcript_status = vi.status;
      transcript_text = vi.text;
      transcript_sentences = vi.sentences;
    }

    let outcome = "unknown";
    if (twilioCall.status === "completed") outcome = "answered";
    else if (twilioCall.status === "no-answer") outcome = "no_answer";
    else if (twilioCall.status === "busy") outcome = "busy";
    else if (twilioCall.status === "failed") outcome = "failed";
    else if (twilioCall.status === "canceled") outcome = "canceled";
    else if (twilioCall.status === "in-progress") outcome = "in_progress";

    const responseData = {
      call_sid: callSid,
      lofty_lead_id: leadInfo.lofty_lead_id,
      lead_name: leadInfo.lead_name,
      lead_email: leadInfo.lead_email,
      property_address: leadInfo.property_address,
      status: twilioCall.status,
      outcome,
      duration: twilioCall.duration,
      from: twilioCall.from,
      to: twilioCall.to,
      price: twilioCall.price,
      start_time: twilioCall.startTime,
      end_time: twilioCall.endTime,
      recording_sid,
      recording_url,
      recording_duration,
      transcript_status,
      transcript_text,
      transcript_sentences,
      created_at: leadInfo.created_at,
      fetched_at: new Date().toISOString()
    };

    res.json(responseData);
  } catch (error) {
    console.error("Error fetching call:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Debug: list all calls in memory
app.get('/calls', (req, res) => {
  const calls = Object.entries(callLeadMap).map(([sid, info]) => ({
    call_sid: sid,
    ...info
  }));
  res.json({ count: calls.length, calls });
});

// Status callback from Twilio
app.post('/status', (req, res) => {
  console.log("Call status update:", req.body.CallSid, req.body.CallStatus);
  res.sendStatus(200);
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on 0.0.0.0:${PORT}`));

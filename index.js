const express = require('express');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

// In-memory notepad: call_sid -> lead info
const callLeadMap = {};

// Destination map: what Sara says -> real phone number
const TRANSFER_DESTINATIONS = {
  revinre: process.env.REVINRE_TRANSFER_NUMBER || '+18882688021',
  hunt:    process.env.HUNT_TRANSFER_NUMBER    || '+16027309912'
};

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
      lead_phone: to,
      created_at: new Date().toISOString(),
      status: "initiated"
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

// ============================================================
// TRANSFER FLOW (Twilio-driven, replaces Grok's native transfer)
// ============================================================

// Grok Voice's transfer_call tool hits this endpoint.
// Body: { destination: "revinre" | "hunt" }
// We find the active call, then Twilio Call Update swaps in new TwiML.
app.post('/transfer', async (req, res) => {
  try {
    const destination = (req.body.destination || '').toLowerCase().trim();

    // Validate destination
    if (!TRANSFER_DESTINATIONS[destination]) {
      console.error(`Transfer failed: unknown destination "${destination}"`);
      return res.status(400).json({
        success: false,
        error: `Unknown destination "${destination}". Must be one of: ${Object.keys(TRANSFER_DESTINATIONS).join(', ')}`
      });
    }

    // Find the currently-active call from our in-memory map.
    // We look for the most recently-created call still in progress.
    const activeCalls = Object.entries(callLeadMap)
      .filter(([_, info]) => info.status === "in-progress" || info.status === "initiated" || info.status === "ringing")
      .sort((a, b) => new Date(b[1].created_at) - new Date(a[1].created_at));

    if (activeCalls.length === 0) {
      console.error("Transfer failed: no active call found in callLeadMap");
      return res.status(404).json({
        success: false,
        error: "No active call found to transfer"
      });
    }

    const [callSid, leadInfo] = activeCalls[0];
    const targetNumber = TRANSFER_DESTINATIONS[destination];

    console.log(`Transfer requested: call ${callSid} -> ${destination} (${targetNumber})`);

    // Update the live Twilio call with new TwiML that dials the human
    const twimlUrl = `${process.env.PUBLIC_URL}/twiml/dial/${destination}`;

    await client.calls(callSid).update({
      url: twimlUrl,
      method: 'POST'
    });

    console.log(`Transfer executed: ${callSid} -> ${targetNumber} via ${twimlUrl}`);

    // Mark the transfer intent on the lead record for later Voice Intelligence correlation
    callLeadMap[callSid].transfer_destination = destination;
    callLeadMap[callSid].transfer_target = targetNumber;
    callLeadMap[callSid].transfer_initiated_at = new Date().toISOString();

    return res.json({
      success: true,
      call_sid: callSid,
      destination,
      target_number: targetNumber,
      message: `Transferring to ${destination}`
    });
  } catch (error) {
    console.error("Transfer error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// TwiML endpoint that Twilio hits after Call Update.
// Returns <Dial> to the human number with a whisper played to the answering agent.
// answerOnBridge=true keeps the lead hearing ringing (no dead air) while whisper plays to the agent.
app.post('/twiml/dial/:destination', (req, res) => {
  const destination = (req.params.destination || '').toLowerCase().trim();
  const targetNumber = TRANSFER_DESTINATIONS[destination];

  res.type('text/xml');

  if (!targetNumber) {
    // Unknown destination — say a fallback and hang up
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">I'm sorry, we couldn't complete the transfer. You can reach our team directly at six oh two, five six two, seven two two two. Have a great day.</Say>
  <Hangup/>
</Response>`);
    return;
  }

  // Whisper URL includes destination + call context for dynamic message
  const whisperUrl = `${process.env.PUBLIC_URL}/twiml/whisper/${destination}`;

  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial answerOnBridge="true" callerId="${process.env.TWILIO_NUMBER}">
    <Number url="${whisperUrl}">${targetNumber}</Number>
  </Dial>
</Response>`);
});

// Whisper TwiML — played ONLY to the answering agent before the bridge.
// Lead continues to hear ringing (thanks to answerOnBridge=true on the parent Dial).
app.post('/twiml/whisper/:destination', (req, res) => {
  const destination = (req.params.destination || '').toLowerCase().trim();

  // Find the most recently transferred call for context
  const recentTransfer = Object.entries(callLeadMap)
    .filter(([_, info]) => info.transfer_destination === destination && info.transfer_initiated_at)
    .sort((a, b) => new Date(b[1].transfer_initiated_at) - new Date(a[1].transfer_initiated_at))[0];

  let whisperText;
  const teamName = destination === 'hunt' ? 'Hunt Mortgage' : 'Revinree';

  if (recentTransfer) {
    const info = recentTransfer[1];
    const leadName = info.lead_name && info.lead_name !== 'unknown' ? info.lead_name : null;
    const propertyAddress = info.property_address && info.property_address !== 'unknown' ? info.property_address : null;

    const parts = [`Incoming ${teamName} lead from Realtor.com.`];
    if (leadName) parts.push(`Lead name: ${leadName}.`);
    if (propertyAddress) parts.push(`Property: ${propertyAddress}.`);
    parts.push(`Full details in Lofty.`);
    whisperText = parts.join(' ');
  } else {
    whisperText = `Incoming ${teamName} lead from Realtor.com. Full details in Lofty.`;
  }

  console.log(`Whisper playing for ${destination}: ${whisperText}`);

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${whisperText}</Say>
</Response>`);
});

// ============================================================
// VOICE INTELLIGENCE / LOFTY UPDATE PIPELINE (unchanged)
// ============================================================

async function fetchVoiceIntelligenceData(recordingSid) {
  try {
    const transcripts = await client.intelligence.v2.transcripts.list({
      sourceSid: recordingSid,
      limit: 1
    });

    if (transcripts.length === 0) {
      return { status: "not_found", text: null, sentences: [], operators: [] };
    }

    const transcript = transcripts[0];

    if (transcript.status !== "completed") {
      return { status: transcript.status, text: null, sentences: [], operators: [] };
    }

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

    let operators = [];
    try {
      const operatorResults = await client.intelligence.v2
        .transcripts(transcript.sid)
        .operatorResults
        .list({ limit: 50 });

      operators = operatorResults.map(op => ({
        name: op.name,
        operator_type: op.operatorType,
        matched: op.matchProbability > 0.5 || (op.extractResults && Object.keys(op.extractResults).length > 0) || (op.matchedUtterances && op.matchedUtterances.length > 0),
        match_probability: op.matchProbability,
        matched_utterances: op.matchedUtterances || [],
        predicted_label: op.predictedLabel,
        predicted_probability: op.predictedProbability
      }));
    } catch (opErr) {
      console.log("Operator results fetch error:", opErr.message);
    }

    return {
      status: "completed",
      transcript_sid: transcript.sid,
      text: fullText,
      sentences: formatted,
      operators
    };
  } catch (error) {
    console.log("Transcript fetch error:", error.message);
    return { status: "error", text: null, sentences: [], operators: [], error: error.message };
  }
}

function deriveOutcome(twilioStatus, operators, leadInfo) {
  if (twilioStatus === "no-answer") return "no_answer";
  if (twilioStatus === "busy") return "busy";
  if (twilioStatus === "failed") return "failed";
  if (twilioStatus === "canceled") return "canceled";
  if (twilioStatus === "in-progress") return "in_progress";

  const matched = (name) => operators.find(op => op.name === name && op.matched);

  if (matched("Voicemail Detection") || matched("Voicemail Left")) {
    return "left_voicemail";
  }

  // If Railway actually executed a transfer, trust that outcome over operator matches
  if (leadInfo && leadInfo.transfer_destination) {
    if (leadInfo.transfer_destination === "hunt") return "Transferred_To_HUNT_Mortgage";
    if (leadInfo.transfer_destination === "revinre") return "Transferred_To_REVINRE";
  }

  if (matched("Transferred to Hunt Mortgage")) return "Transferred_To_HUNT_Mortgage";
  if (matched("Transferred to REVINRE")) return "Transferred_To_REVINRE";
  if (matched("Transfer Initiated")) return "Transferred_Unknown";
  if (matched("Not Interested")) return "follow_up_needed";

  return "follow_up_needed";
}

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

    let transcript_status = "no_recording";
    let transcript_text = null;
    let transcript_sentences = [];
    let operators = [];
    if (recording_sid) {
      const vi = await fetchVoiceIntelligenceData(recording_sid);
      transcript_status = vi.status;
      transcript_text = vi.text;
      transcript_sentences = vi.sentences;
      operators = vi.operators;
    }

    const outcome = deriveOutcome(twilioCall.status, operators, leadInfo);

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
      operators,
      transfer_destination: leadInfo.transfer_destination || null,
      transfer_target: leadInfo.transfer_target || null,
      transfer_initiated_at: leadInfo.transfer_initiated_at || null,
      created_at: leadInfo.created_at,
      fetched_at: new Date().toISOString()
    };

    res.json(responseData);
  } catch (error) {
    console.error("Error fetching call:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/calls', (req, res) => {
  const calls = Object.entries(callLeadMap).map(([sid, info]) => ({
    call_sid: sid,
    ...info
  }));
  res.json({ count: calls.length, calls });
});

// Status callback from Twilio — keeps callLeadMap.status current so /transfer can find active calls
app.post('/status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log("Call status update:", CallSid, CallStatus);
  if (callLeadMap[CallSid]) {
    callLeadMap[CallSid].status = CallStatus;
  }
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on 0.0.0.0:${PORT}`));

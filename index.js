const express = require('express');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

// In-memory notepad: call_sid -> lead info
const callLeadMap = {};

// Agent roster: which agents to fan out to per destination.
// Adding/removing agents = edit this map. Numbers must be E.164 format.
// lofty_user_id must match the userId Lofty API expects for lead assignment.
const AGENT_ROSTER = {
  revinre: [
    { name: "Marcus Pomeroy", phone: "+16235567626", lofty_user_id: 844762677574243, lofty_email: "marcus.pomeroy@revinre.com" }
    // Add more Revinre agents here as we roll out wider
  ],
  hunt: [
    { name: "Marcus Pomeroy", phone: "+16235567626", lofty_user_id: 844762677574243, lofty_email: "marcus.pomeroy@revinre.com" }
    // Add Hunt Mortgage agents here as we roll out wider
  ]
};

// Ring timeout for the fanout (seconds). If nobody picks up, Sara's fallback plays.
const DIAL_TIMEOUT_SECONDS = 25;

// Lookup helper: find agent info from the phone number that Twilio reports as answered
function findAgentByPhone(phone) {
  if (!phone) return null;
  const normalized = phone.replace(/[^0-9+]/g, '');
  for (const dest of Object.keys(AGENT_ROSTER)) {
    const match = AGENT_ROSTER[dest].find(a => a.phone.replace(/[^0-9+]/g, '') === normalized);
    if (match) return { ...match, destination: dest };
  }
  return null;
}

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

    // Validate destination against the agent roster
    if (!AGENT_ROSTER[destination] || AGENT_ROSTER[destination].length === 0) {
      console.error(`Transfer failed: unknown or empty destination "${destination}"`);
      return res.status(400).json({
        success: false,
        error: `Unknown destination "${destination}". Must be one of: ${Object.keys(AGENT_ROSTER).join(', ')}`
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
    const agentCount = AGENT_ROSTER[destination].length;

    console.log(`Transfer requested: call ${callSid} -> ${destination} (fanning out to ${agentCount} agent(s))`);

    // Update the live Twilio call with new TwiML that fans out to agents
    const twimlUrl = `${process.env.PUBLIC_URL}/twiml/dial/${destination}`;

    await client.calls(callSid).update({
      url: twimlUrl,
      method: 'POST'
    });

    console.log(`Transfer executed: ${callSid} -> ${destination} fanout via ${twimlUrl}`);

    // Mark the transfer intent on the lead record for later Voice Intelligence correlation
    callLeadMap[callSid].transfer_destination = destination;
    callLeadMap[callSid].transfer_initiated_at = new Date().toISOString();

    return res.json({
      success: true,
      call_sid: callSid,
      destination,
      agent_count: agentCount,
      message: `Transferring to ${destination} (fanning out to ${agentCount} agent(s))`
    });
  } catch (error) {
    console.error("Transfer error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// TwiML endpoint that Twilio hits after Call Update.
// Dials each agent in the roster in parallel, with whisper attached to each Number.
// Whoever picks up first hears the whisper on their leg; lead hears ringing (no dead air).
app.post('/twiml/dial/:destination', (req, res) => {
  const destination = (req.params.destination || '').toLowerCase().trim();
  const agents = AGENT_ROSTER[destination];

  res.type('text/xml');

  if (!agents || agents.length === 0) {
    console.error(`No agents configured for destination "${destination}"`);
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">I'm sorry, we couldn't complete the transfer. You can reach our team directly at six oh two, five six two, seven two two two. Have a great day.</Say>
  <Hangup/>
</Response>`);
    return;
  }

  const whisperUrl = `${process.env.PUBLIC_URL}/twiml/whisper/${destination}`;
  const actionUrl = `${process.env.PUBLIC_URL}/dial-completed/${destination}`;

  // Build one <Number> element per agent with whisper attached
  const numberElements = agents
    .map(a => `    <Number url="${whisperUrl}">${a.phone}</Number>`)
    .join('\n');

  // Short hold message so the lead doesn't hear dead air while we dial the agent.
  // Twilio's <Dial> after an already-answered call produces silence until bridge —
  // this <Say> covers that gap. Kept short so it doesn't hold up the transfer.
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">One moment, connecting you now.</Say>
  <Dial answerOnBridge="true" callerId="${process.env.TWILIO_NUMBER}" timeout="${DIAL_TIMEOUT_SECONDS}" action="${actionUrl}" method="POST">
${numberElements}
  </Dial>
</Response>`);
});

// Called by Twilio when the <Dial> ends (successful bridge, no-answer, busy, etc.).
// If completed, identify which agent answered and (a) update Lofty (b) SMS the agent.
app.post('/dial-completed/:destination', async (req, res) => {
  const destination = (req.params.destination || '').toLowerCase().trim();
  const { DialCallStatus, DialCallSid, DialCallDuration, CallSid: parentCallSid } = req.body;

  console.log(`Dial completed: destination=${destination} status=${DialCallStatus} childSid=${DialCallSid} parentSid=${parentCallSid} duration=${DialCallDuration}`);

  // Always respond immediately — continue whatever's left in the parent TwiML flow.
  // Empty <Response> just lets the parent call end naturally.
  res.type('text/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  // Only process successful bridges
  if (DialCallStatus !== 'completed' && DialCallStatus !== 'answered') {
    console.log(`Dial ended without connection (${DialCallStatus}) — skipping Lofty/SMS updates`);
    return;
  }

  if (!DialCallSid) {
    console.log(`No DialCallSid — cannot identify answering agent`);
    return;
  }

  // Post-response async work: identify agent, update Lofty, send SMS
  try {
    const childCall = await client.calls(DialCallSid).fetch();
    const answeredNumber = childCall.to;
    console.log(`Answering leg to: ${answeredNumber}`);

    const agent = findAgentByPhone(answeredNumber);
    if (!agent) {
      console.warn(`No agent match for answered number ${answeredNumber}`);
      return;
    }

    // Find lead info from callLeadMap using the parent call SID
    const leadInfo = callLeadMap[parentCallSid] || {};

    // Record who answered
    if (callLeadMap[parentCallSid]) {
      callLeadMap[parentCallSid].answered_by_agent = {
        name: agent.name,
        phone: agent.phone,
        lofty_user_id: agent.lofty_user_id,
        answered_at: new Date().toISOString()
      };
    }

    // Kick off Lofty reassignment + SMS in parallel
    await Promise.allSettled([
      assignLeadInLofty(leadInfo.lofty_lead_id, agent.lofty_user_id, agent.name, agent.lofty_email),
      sendAgentSms(agent, leadInfo)
    ]);
  } catch (err) {
    console.error(`dial-completed post-processing error: ${err.message}`);
  }
});

// Assign the Lofty lead to the specific agent that answered the transfer.
// Lofty API is inconsistent between OpenAPI schema (array root, role+assignee)
// and their guide (object root with `assignees`). We try the array form first
// per the OpenAPI schema, then fall back to the guide form if that 400s.
async function assignLeadInLofty(loftyLeadId, loftyUserId, agentName, agentEmail) {
  if (!loftyLeadId || loftyLeadId === 'unknown') {
    console.warn(`assignLeadInLofty: missing loftyLeadId — skipping`);
    return;
  }
  if (!process.env.LOFTY_API_KEY) {
    console.warn(`assignLeadInLofty: LOFTY_API_KEY not set — skipping`);
    return;
  }

  const url = `${process.env.LOFTY_API_BASE || 'https://api.lofty.com'}/v1.0/leads/${loftyLeadId}/assignment`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `token ${process.env.LOFTY_API_KEY}`
  };

  // Prefer email if provided (matches OpenAPI example); otherwise stringify user ID
  const assigneeValue = agentEmail || String(loftyUserId);

  // Attempt 1: OpenAPI schema — array root with role + assignee
  const bodyA = [{ role: 'Agent', assignee: assigneeValue }];
  // Attempt 2: Guide format — object with `assignees` array and numeric userId
  const bodyB = { assignees: [{ userId: loftyUserId }] };
  // Attempt 3: Same as B but userId as string (JS number precision safety)
  const bodyC = { assignees: [{ userId: String(loftyUserId) }] };

  const attempts = [
    { label: 'array/role+assignee', body: bodyA },
    { label: 'assignees/userId(number)', body: bodyB },
    { label: 'assignees/userId(string)', body: bodyC }
  ];

  for (const attempt of attempts) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(attempt.body)
      });
      const text = await resp.text();
      if (resp.ok) {
        console.log(`Lofty assignment success [${attempt.label}]: lead ${loftyLeadId} -> ${agentName} (${loftyUserId})`);
        return;
      }
      console.warn(`Lofty assignment attempt [${attempt.label}] failed: HTTP ${resp.status} body=${text}`);
      // Only retry on 400 — other errors (401/403/404) won't be fixed by a different body shape
      if (resp.status !== 400) {
        console.error(`Lofty assignment giving up on non-400 status ${resp.status}`);
        return;
      }
    } catch (err) {
      console.error(`Lofty assignment error [${attempt.label}]: ${err.message}`);
    }
  }
  console.error(`Lofty assignment: all ${attempts.length} body-shape attempts failed for lead ${loftyLeadId}`);
}

// Send SMS to the answering agent with lead context
async function sendAgentSms(agent, leadInfo) {
  if (!agent.phone) return;

  const lines = [`🏠 Revinree AI-qualified lead just transferred to you.`];
  if (leadInfo.lead_name && leadInfo.lead_name !== 'unknown') lines.push(`Name: ${leadInfo.lead_name}`);
  if (leadInfo.lead_phone) lines.push(`Phone: ${leadInfo.lead_phone}`);
  if (leadInfo.lead_email && leadInfo.lead_email !== 'unknown') lines.push(`Email: ${leadInfo.lead_email}`);
  if (leadInfo.property_address && leadInfo.property_address !== 'unknown') lines.push(`Property: ${leadInfo.property_address}`);
  lines.push(`Full transcript + qualification will be in Lofty shortly.`);

  const messageBody = lines.join('\n');

  try {
    const msg = await client.messages.create({
      to: agent.phone,
      from: process.env.TWILIO_NUMBER,
      body: messageBody
    });
    console.log(`Agent SMS sent to ${agent.name} (${agent.phone}): ${msg.sid}`);
  } catch (err) {
    console.error(`Agent SMS error: ${err.message}`);
  }
}

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

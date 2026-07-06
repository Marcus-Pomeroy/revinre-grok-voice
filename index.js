const express = require('express');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

// In-memory notepad: call_sid -> lead info
const callLeadMap = {};

// Conference tracking: conferenceName -> { parentCallSid, agentCallSids: [], answeredAgent: null, timeoutHandle: null }
const conferenceMap = {};

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

// Ring timeout for the fanout (seconds). If nobody picks up, we redirect the lead to a "call you back" message.
const DIAL_TIMEOUT_SECONDS = 20;

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

// Bridge to Grok Voice via xAI's SIP endpoint.
app.post('/voice', (req, res) => {
  const callSid = req.body.CallSid;
  const lead = (callSid && callLeadMap[callSid]) || {};
  const sipUri = process.env.XAI_SIP_URI || '';

  console.log(`[/voice] CallSid=${callSid} routing to Grok Voice (lead=${lead.lead_name || 'unknown'} property=${lead.property_address || 'unknown'})`);

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial answerOnBridge="true" record="record-from-answer">
    <Sip>${sipUri}</Sip>
  </Dial>
</Response>`);
});

// Normalize helpers
function firstNameOnly(fullName) {
  if (!fullName || typeof fullName !== 'string') return "unknown";
  const cleaned = fullName.trim();
  if (!cleaned || cleaned.toLowerCase() === 'unknown') return "unknown";
  const first = cleaned.split(/\s+/)[0].replace(/[^\p{L}\p{M}'\-]/gu, '');
  return first || "unknown";
}

function streetOnly(addr) {
  if (!addr || typeof addr !== 'string') return "unknown";
  const cleaned = addr.trim();
  if (!cleaned || cleaned.toLowerCase() === 'unknown') return "unknown";
  const street = cleaned.split(',')[0].trim();
  return street || "unknown";
}

// XML escape for safe injection into TwiML
function xmlEscape(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Start outbound call from Zapier
app.post('/call', async (req, res) => {
  try {
    const { to, lofty_lead_id, lead_name, lead_email, property_address } = req.body;

    const normalizedName = firstNameOnly(lead_name);
    const normalizedAddress = streetOnly(property_address);

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
      lead_name: normalizedName,
      lead_name_full: lead_name || "unknown",
      lead_email: lead_email || "unknown",
      property_address: normalizedAddress,
      property_address_full: property_address || "unknown",
      lead_phone: to,
      created_at: new Date().toISOString(),
      status: "initiated"
    };

    console.log(`Call started: ${call.sid} for lead ${lofty_lead_id} (raw="${lead_name}" → sara="${normalizedName}") property: raw="${property_address}" → sara="${normalizedAddress}"`);

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
// TRANSFER FLOW — Conference-based with hold music + simultaneous fanout
// ============================================================

// Sara's transfer_call tool hits this endpoint.
// Body: { destination, beds, baths, timeline, pre_approval, area, must_haves }
app.post('/transfer', async (req, res) => {
  try {
    const destination = (req.body.destination || '').toLowerCase().trim();

    // Capture qualification data — used later in whisper
    const qualification = {
      beds: req.body.beds || 'unspecified',
      baths: req.body.baths || 'unspecified',
      timeline: req.body.timeline || 'unspecified',
      pre_approval: req.body.pre_approval || 'unspecified',
      area: req.body.area || 'unspecified',
      must_haves: req.body.must_haves || 'none'
    };

    // Validate destination
    if (!AGENT_ROSTER[destination] || AGENT_ROSTER[destination].length === 0) {
      console.error(`Transfer failed: unknown or empty destination "${destination}"`);
      return res.status(400).json({
        success: false,
        error: `Unknown destination "${destination}". Must be one of: ${Object.keys(AGENT_ROSTER).join(', ')}`
      });
    }

    // Find active call
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
    const agents = AGENT_ROSTER[destination];
    const conferenceName = `revinre-lead-${callSid}`;

    console.log(`Transfer requested: call ${callSid} -> ${destination} conference=${conferenceName} agents=${agents.length}`);
    console.log(`Qualification data: ${JSON.stringify(qualification)}`);

    // Store transfer metadata + qualification for whisper lookup
    callLeadMap[callSid].transfer_destination = destination;
    callLeadMap[callSid].transfer_initiated_at = new Date().toISOString();
    callLeadMap[callSid].qualification = qualification;
    callLeadMap[callSid].conference_name = conferenceName;

    // Initialize conference tracking
    conferenceMap[conferenceName] = {
      parentCallSid: callSid,
      destination,
      qualification,
      agentCallSids: [],
      answeredAgent: null,
      createdAt: new Date().toISOString()
    };

    // Step 1: Redirect the lead's call into the Conference (with hold music)
    const leadTwimlUrl = `${process.env.PUBLIC_URL}/twiml/lead-hold/${encodeURIComponent(conferenceName)}`;
    await client.calls(callSid).update({
      url: leadTwimlUrl,
      method: 'POST'
    });
    console.log(`Lead ${callSid} redirected to conference ${conferenceName} via ${leadTwimlUrl}`);

    // Step 2: Dial all agents simultaneously — each dial creates a new call whose TwiML puts them in the same conference
    const agentDialPromises = agents.map(async (agent) => {
      try {
        const agentTwimlUrl = `${process.env.PUBLIC_URL}/twiml/agent-join/${encodeURIComponent(conferenceName)}?agent_phone=${encodeURIComponent(agent.phone)}`;
        const agentCall = await client.calls.create({
          to: agent.phone,
          from: process.env.TWILIO_NUMBER,
          url: agentTwimlUrl,
          method: 'POST',
          timeout: DIAL_TIMEOUT_SECONDS,
          statusCallback: `${process.env.PUBLIC_URL}/agent-status/${encodeURIComponent(conferenceName)}`,
          statusCallbackMethod: 'POST',
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
        });
        conferenceMap[conferenceName].agentCallSids.push({ sid: agentCall.sid, phone: agent.phone, name: agent.name });
        console.log(`Agent dial started: ${agent.name} (${agent.phone}) callSid=${agentCall.sid}`);
        return { agent, callSid: agentCall.sid };
      } catch (err) {
        console.error(`Failed to dial agent ${agent.name} (${agent.phone}): ${err.message}`);
        return null;
      }
    });

    await Promise.allSettled(agentDialPromises);

    // Step 3: Start the fallback timer — if no agent joins in DIAL_TIMEOUT_SECONDS + 5, play "call you back"
    setTimeout(async () => {
      const conf = conferenceMap[conferenceName];
      if (conf && !conf.answeredAgent) {
        console.log(`Timeout: no agent joined conference ${conferenceName} — playing fallback to lead`);
        try {
          await client.calls(callSid).update({
            url: `${process.env.PUBLIC_URL}/twiml/no-agent-available`,
            method: 'POST'
          });
        } catch (err) {
          console.error(`Failed to redirect lead to fallback: ${err.message}`);
        }
        // Cancel all outstanding agent legs
        for (const a of conf.agentCallSids) {
          try {
            const call = await client.calls(a.sid).fetch();
            if (call.status === 'queued' || call.status === 'ringing' || call.status === 'initiated') {
              await client.calls(a.sid).update({ status: 'canceled' });
              console.log(`Canceled unanswered agent leg: ${a.name} (${a.sid})`);
            }
          } catch (e) {
            // ignore
          }
        }
      }
    }, (DIAL_TIMEOUT_SECONDS + 5) * 1000);

    return res.json({
      success: true,
      call_sid: callSid,
      destination,
      conference: conferenceName,
      agent_count: agents.length,
      message: `Lead moved to conference. Dialing ${agents.length} agent(s) simultaneously.`
    });
  } catch (error) {
    console.error("Transfer error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// TwiML: lead joins the conference with hold music
app.post('/twiml/lead-hold/:conferenceName', (req, res) => {
  const conferenceName = decodeURIComponent(req.params.conferenceName || '');
  const waitUrl = `${process.env.PUBLIC_URL}/hold-music`;
  const statusCallbackUrl = `${process.env.PUBLIC_URL}/conference-events/${encodeURIComponent(conferenceName)}`;

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial answerOnBridge="true">
    <Conference
      startConferenceOnEnter="false"
      endConferenceOnExit="true"
      waitUrl="${xmlEscape(waitUrl)}"
      waitMethod="POST"
      statusCallback="${xmlEscape(statusCallbackUrl)}"
      statusCallbackMethod="POST"
      statusCallbackEvent="start end join leave">${xmlEscape(conferenceName)}</Conference>
  </Dial>
</Response>`);
});

// TwiML: agent joins the conference AFTER hearing the whisper
app.post('/twiml/agent-join/:conferenceName', (req, res) => {
  const conferenceName = decodeURIComponent(req.params.conferenceName || '');
  const agentPhone = req.query.agent_phone || 'unknown';
  const whisperUrl = `${process.env.PUBLIC_URL}/twiml/whisper/${encodeURIComponent(conferenceName)}`;
  const statusCallbackUrl = `${process.env.PUBLIC_URL}/conference-events/${encodeURIComponent(conferenceName)}`;

  console.log(`Agent TwiML requested: conference=${conferenceName} phone=${agentPhone}`);

  // Agent hears whisper via <Play> of whisper TwiML? No — whisper is <Say>, so we need
  // to inline it. But we don't want to duplicate the whisper text-building logic here.
  // Solution: use <Redirect> pattern OR play whisper directly then <Dial><Conference>.
  // Twilio's Conference supports a `whisperUrl` — but that's only for <Number> dials.
  // For Conference join, the standard pattern is: <Say>whisper</Say><Dial><Conference/></Dial>
  // We'll fetch the whisper text via a helper and inline it here.

  const whisperText = buildWhisperText(conferenceName);

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${xmlEscape(whisperText)}</Say>
  <Dial answerOnBridge="true">
    <Conference
      startConferenceOnEnter="true"
      endConferenceOnExit="true"
      beep="false"
      statusCallback="${xmlEscape(statusCallbackUrl)}"
      statusCallbackMethod="POST"
      statusCallbackEvent="join leave">${xmlEscape(conferenceName)}</Conference>
  </Dial>
</Response>`);
});

// Build the rich whisper text from stored qualification data
function buildWhisperText(conferenceName) {
  const conf = conferenceMap[conferenceName];
  const teamName = conf?.destination === 'hunt' ? 'Hunt Mortgage' : 'Revinree';

  if (!conf) {
    return `Incoming ${teamName} lead from Realtor.com. Full details in Lofty. Connecting now.`;
  }

  const info = callLeadMap[conf.parentCallSid] || {};
  const q = conf.qualification || {};

  const leadName = (info.lead_name_full && info.lead_name_full !== 'unknown')
    ? info.lead_name_full
    : (info.lead_name && info.lead_name !== 'unknown' ? info.lead_name : null);
  const propertyAddress = (info.property_address_full && info.property_address_full !== 'unknown')
    ? info.property_address_full
    : (info.property_address && info.property_address !== 'unknown' ? info.property_address : null);

  const parts = [`Incoming ${teamName} lead from Realtor.com.`];
  if (leadName) parts.push(`Name: ${leadName}.`);
  if (propertyAddress) parts.push(`Property: ${propertyAddress}.`);

  // Rich qualification fields — in the priority order the user specified
  if (q.beds && q.beds !== 'unspecified' && q.baths && q.baths !== 'unspecified') {
    parts.push(`Looking for ${q.beds} bed, ${q.baths} bath.`);
  } else if (q.beds && q.beds !== 'unspecified') {
    parts.push(`Looking for ${q.beds} bedrooms.`);
  } else if (q.baths && q.baths !== 'unspecified') {
    parts.push(`Looking for ${q.baths} bathrooms.`);
  }
  if (q.timeline && q.timeline !== 'unspecified') {
    parts.push(`Timeline: ${q.timeline}.`);
  }
  if (q.pre_approval && q.pre_approval !== 'unspecified') {
    parts.push(`Financing: ${q.pre_approval === 'yes' ? 'pre-approved' : q.pre_approval === 'no' ? 'not pre-approved' : q.pre_approval}.`);
  }
  if (q.area && q.area !== 'unspecified') {
    parts.push(`Area: ${q.area}.`);
  }
  if (q.must_haves && q.must_haves !== 'none' && q.must_haves !== 'unspecified') {
    parts.push(`Must-haves: ${q.must_haves}.`);
  }
  parts.push(`Connecting now.`);
  return parts.join(' ');
}

// Legacy whisper endpoint — kept for backward compat but not used in Conference flow
app.post('/twiml/whisper/:conferenceName', (req, res) => {
  const conferenceName = decodeURIComponent(req.params.conferenceName || '');
  const whisperText = buildWhisperText(conferenceName);
  console.log(`Whisper (legacy endpoint) for ${conferenceName}: ${whisperText}`);
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${xmlEscape(whisperText)}</Say>
</Response>`);
});

// Hold music TwiML — soft-rock playlist loop from Twilio's public S3 bucket
// (Royalty-free, Creative Commons). Loops continuously; agent's arrival ends it.
app.post('/hold-music', (req, res) => {
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play loop="0">http://com.twilio.music.soft-rock.s3.amazonaws.com/_ghost_-_promo_2_sample_pack.mp3</Play>
</Response>`);
});
// Also accept GET (Twilio sometimes fetches waitUrl via GET)
app.get('/hold-music', (req, res) => {
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play loop="0">http://com.twilio.music.soft-rock.s3.amazonaws.com/_ghost_-_promo_2_sample_pack.mp3</Play>
</Response>`);
});

// Fallback TwiML when no agent picks up
app.post('/twiml/no-agent-available', (req, res) => {
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thanks for holding. All of our agents are currently unavailable. Someone from REVINRE will call you back shortly. Have a great day.</Say>
  <Hangup/>
</Response>`);
});

// Conference event webhook — fires on start/end/join/leave
app.post('/conference-events/:conferenceName', async (req, res) => {
  res.sendStatus(200);
  const conferenceName = decodeURIComponent(req.params.conferenceName || '');
  const { StatusCallbackEvent, ConferenceSid, CallSid, ParticipantLabel, StartConferenceOnEnter } = req.body;
  console.log(`Conference event: ${conferenceName} event=${StatusCallbackEvent} callSid=${CallSid} confSid=${ConferenceSid}`);

  const conf = conferenceMap[conferenceName];
  if (!conf) {
    console.warn(`No conferenceMap entry for ${conferenceName}`);
    return;
  }

  // participant-join event — check whether this is an agent (not the lead)
  if (StatusCallbackEvent === 'participant-join') {
    // Is this an agent leg? Check against tracked agent call SIDs
    const agentEntry = conf.agentCallSids.find(a => a.sid === CallSid);
    if (agentEntry && !conf.answeredAgent) {
      conf.answeredAgent = { sid: CallSid, phone: agentEntry.phone, name: agentEntry.name, joined_at: new Date().toISOString() };
      console.log(`FIRST AGENT JOINED: ${agentEntry.name} (${agentEntry.phone}) — canceling other agent legs`);

      // Cancel all other agent legs
      const otherLegs = conf.agentCallSids.filter(a => a.sid !== CallSid);
      for (const other of otherLegs) {
        try {
          const call = await client.calls(other.sid).fetch();
          if (call.status === 'queued' || call.status === 'ringing' || call.status === 'initiated') {
            await client.calls(other.sid).update({ status: 'canceled' });
            console.log(`Canceled other agent leg: ${other.name} (${other.sid})`);
          }
        } catch (e) {
          // ignore
        }
      }

      // Update Lofty + send SMS (post-answer work)
      const agent = findAgentByPhone(agentEntry.phone);
      const leadInfo = callLeadMap[conf.parentCallSid] || {};
      if (agent) {
        if (callLeadMap[conf.parentCallSid]) {
          callLeadMap[conf.parentCallSid].answered_by_agent = {
            name: agent.name,
            phone: agent.phone,
            lofty_user_id: agent.lofty_user_id,
            answered_at: new Date().toISOString()
          };
        }
        await Promise.allSettled([
          assignLeadInLofty(leadInfo.lofty_lead_id, agent.lofty_user_id, agent.name, agent.lofty_email),
          sendAgentSms(agent, leadInfo)
        ]);
      }
    }
  }

  if (StatusCallbackEvent === 'conference-end') {
    console.log(`Conference ended: ${conferenceName}`);
    // Cleanup in-memory tracking after a short delay to allow any final events
    setTimeout(() => { delete conferenceMap[conferenceName]; }, 60000);
  }
});

// Agent-leg status webhook — logs each agent's call progression
app.post('/agent-status/:conferenceName', (req, res) => {
  res.sendStatus(200);
  const conferenceName = decodeURIComponent(req.params.conferenceName || '');
  const { CallSid, CallStatus } = req.body;
  console.log(`Agent status: conference=${conferenceName} callSid=${CallSid} status=${CallStatus}`);
});

// Assign the Lofty lead to the specific agent that answered the transfer.
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

  const assigneeValue = agentEmail || String(loftyUserId);
  const bodyA = [{ role: 'Agent', assignee: assigneeValue }];
  const bodyB = { assignees: [{ userId: loftyUserId }] };
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

  const smsName = (leadInfo.lead_name_full && leadInfo.lead_name_full !== 'unknown')
    ? leadInfo.lead_name_full
    : leadInfo.lead_name;
  const smsAddress = (leadInfo.property_address_full && leadInfo.property_address_full !== 'unknown')
    ? leadInfo.property_address_full
    : leadInfo.property_address;

  const lines = [`🏠 Revinree AI-qualified lead just transferred to you.`];
  if (smsName && smsName !== 'unknown') lines.push(`Name: ${smsName}`);
  if (leadInfo.lead_phone) lines.push(`Phone: ${leadInfo.lead_phone}`);
  if (leadInfo.lead_email && leadInfo.lead_email !== 'unknown') lines.push(`Email: ${leadInfo.lead_email}`);
  if (smsAddress && smsAddress !== 'unknown') lines.push(`Property: ${smsAddress}`);
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
      qualification: leadInfo.qualification || null,
      answered_by_agent: leadInfo.answered_by_agent || null,
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

// Status callback from Twilio
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

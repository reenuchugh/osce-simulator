require('dotenv').config();
const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { loadAllCases } = require('./lib/caseParser');
const groq = require('./lib/groqClient');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CASES_DIR = path.join(__dirname, 'cases');
const sessions = {}; // sessionId -> { caseId, caseData, mode, transcript, hard, rapid, startTime }

function getCases() {
  return loadAllCases(CASES_DIR);
}

app.get('/api/cases', (req, res) => {
  try {
    const cases = getCases().map(c => ({ id: c.id, title: c.meta.title, stationType: c.meta.stationType, duration: c.meta.duration }));
    res.json({ cases });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/session/load', (req, res) => {
  const { caseId } = req.body;
  try {
    const cases = getCases();
    const caseData = cases.find(c => c.id === caseId);
    if (!caseData) return res.status(404).json({ error: 'Case not found' });

    const sessionId = uuidv4();
    sessions[sessionId] = {
      caseId,
      caseData,
      mode: 'instructions',
      transcript: [],
      hard: false,
      rapid: false,
      startTime: null
    };

    res.json({
      sessionId,
      title: caseData.meta.title,
      stationType: caseData.meta.stationType,
      duration: caseData.meta.duration,
      candidateInstructions: caseData.candidateInstructions
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function buildSPSystemPrompt(session) {
  const { sp, meta } = session.caseData;
  let difficulty = session.hard
    ? 'The patient is behaving in a more difficult manner (impatient, guarded, tangential, or emotionally reactive) WITHOUT changing any clinical facts.'
    : 'The patient behaves naturally and cooperatively appropriate to the emotional state described.';
  let length = session.rapid
    ? 'Keep every reply very short (1 short sentence).'
    : 'Keep replies short and natural (1-3 sentences).';

  return `You are a standardized patient (SP) in a Canadian NAC OSCE exam station titled "${meta.title}" (${meta.stationType}).

STRICT RULES:
- Stay fully in character as the patient at all times.
- Reveal ONLY information the candidate appropriately asks for. Give ONE piece of information at a time. Do NOT volunteer multiple facts in one reply.
- Do NOT teach, hint, diagnose, summarize, or suggest what the candidate should ask.
- Do NOT reveal red flag information unless the candidate asks a question that would appropriately elicit it.
- Show realistic emotion consistent with: ${sp.Emotion || 'neutral'}.
- Use Canadian clinical/cultural context (e.g., OHIP, family doctor, walk-in clinic, Canadian geography).
- If the candidate verbalizes a specific physical exam maneuver, respond with the relevant finding from the findings list below. Otherwise do not give exam findings.
- Do NOT invent findings not listed below.
- ${difficulty}
- ${length}

HIDDEN CASE FACTS (never dump these; reveal only when asked appropriately):
Opening line: ${sp.Opening || ''}
History: ${sp.History || ''}
Red flags (reveal only if asked directly/appropriately): ${sp['Red flags'] || 'none'}
PMHx: ${sp.PMHx || ''}
Medications: ${sp.Medications || ''}
Allergies: ${sp.Allergies || ''}
Social: ${sp.Social || ''}
Family: ${sp.Family || ''}
Patient's underlying concern (reveal if asked "what worries you" or similar): ${sp['Patient concern'] || ''}
Challenge question to pose at some natural point in the conversation if the candidate gives an opening (only once): ${sp['Challenge question'] || 'none'}
Physical exam findings (ONLY reveal the specific finding if that specific maneuver is verbalized by candidate): ${sp['Physical findings'] || 'none'}

Respond only with what the patient would say/do next, in first person, no stage directions except brief bracketed emotional cues if essential (e.g., [wincing]).`;
}

app.post('/api/session/start', async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  session.mode = 'sp';
  session.startTime = Date.now();
  const opening = session.caseData.sp.Opening || '...';
  session.transcript.push({ role: 'assistant', content: opening });
  res.json({ reply: opening, mode: 'sp' });
});

app.post('/api/session/message', async (req, res) => {
  const { sessionId, text } = req.body;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const upper = (text || '').trim().toUpperCase();

  if (upper === 'HARD') {
    session.hard = true;
    return res.json({ reply: null, systemNote: 'Difficulty increased.', mode: session.mode });
  }
  if (upper === 'RAPID') {
    session.rapid = true;
    return res.json({ reply: null, systemNote: 'Rapid mode on.', mode: session.mode });
  }
  if (upper === 'END' || upper === 'EXAMINER') {
    session.mode = 'examiner';
    const oral = session.caseData.examiner['Oral questions'];
    const msg = oral
      ? `Station time is complete. EXAMINER MODE.\n\nOral questions:\n${oral}\n\nPlease respond to these questions.`
      : `Station time is complete. EXAMINER MODE.\n\nNo oral questions for this station. Type FEEDBACK to receive your scoring.`;
    session.transcript.push({ role: 'system', content: '[Switched to EXAMINER MODE]' });
    return res.json({ reply: msg, mode: 'examiner' });
  }
  if (upper === 'FEEDBACK') {
    return generateFeedback(session, res);
  }

  if (session.mode === 'sp') {
    session.transcript.push({ role: 'user', content: text });
    try {
      const systemPrompt = buildSPSystemPrompt(session);
      const messages = [
        { role: 'system', content: systemPrompt },
        ...session.transcript
          .filter(t => t.role === 'user' || t.role === 'assistant')
          .map(t => ({ role: t.role, content: t.content }))
      ];
      const reply = await groq.chat(messages, { temperature: 0.8, max_tokens: 200 });
      session.transcript.push({ role: 'assistant', content: reply });
      res.json({ reply, mode: 'sp' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  } else if (session.mode === 'examiner') {
    // candidate answering oral questions
    session.transcript.push({ role: 'user', content: `[Oral answer] ${text}` });
    res.json({ reply: 'Answer recorded. Continue answering remaining questions, or type FEEDBACK when done.', mode: 'examiner' });
  } else {
    res.json({ reply: 'Station not started. Say START.', mode: session.mode });
  }
});

async function generateFeedback(session, res) {
  const { examiner, meta } = session.caseData;
  const transcriptText = session.transcript
    .map(t => `${t.role.toUpperCase()}: ${t.content}`)
    .join('\n');

  const prompt = `You are a Canadian NAC OSCE examiner. Score the following candidate performance for station "${meta.title}" (${meta.stationType}) STRICTLY according to the case checklist below. Do not claim this is official MCC scoring.

CASE CHECKLIST:
Key features: ${examiner['Key features'] || 'N/A'}
Critical safety issues: ${examiner['Critical safety issues'] || 'N/A'}
Oral questions: ${examiner['Oral questions'] || 'N/A'}
Expected answers: ${examiner['Expected answers'] || 'N/A'}

FULL ENCOUNTER TRANSCRIPT:
${transcriptText}

Provide feedback under EXACTLY these 8 headers, concise bullet points under each:
1. Key features achieved
2. Key features missed
3. Critical safety omissions
4. Clinical reasoning
5. Communication and empathy
6. Canadian professionalism
7. Confidence
8. Three improvement drills`;

  try {
    const feedback = await groq.chat(
      [
        { role: 'system', content: 'You are a rigorous but fair Canadian OSCE examiner giving structured written feedback.' },
        { role: 'user', content: prompt }
      ],
      { temperature: 0.4, max_tokens: 900 }
    );
    session.mode = 'done';
    res.json({ reply: feedback, mode: 'done' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

const PORT = process.env.PORT || 3344;
app.listen(PORT, () => {
  console.log(`OSCE Simulator running at http://localhost:${PORT}`);
});

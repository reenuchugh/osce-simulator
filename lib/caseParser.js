const fs = require('fs');
const path = require('path');

// Sections we split the raw case .txt on
const SP_FIELDS = [
  'Opening', 'Emotion', 'History', 'Red flags', 'PMHx', 'Medications',
  'Allergies', 'Social', 'Family', 'Patient concern', 'Challenge question',
  'Physical findings'
];
const EXAM_FIELDS = [
  'Key features', 'Critical safety issues', 'Oral questions', 'Expected answers'
];

function parseCase(raw) {
  const lines = raw.split(/\r?\n/);
  const meta = {};
  let i = 0;

  // Header lines: TITLE, STATION TYPE, DURATION
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('TITLE:')) meta.title = l.replace('TITLE:', '').trim();
    else if (l.startsWith('STATION TYPE:')) meta.stationType = l.replace('STATION TYPE:', '').trim();
    else if (l.startsWith('DURATION:')) meta.duration = parseInt(l.replace('DURATION:', '').trim(), 10) || 8;
    else if (l.startsWith('CANDIDATE INSTRUCTIONS:')) break;
  }

  // Candidate instructions: everything until "SP:"
  let candidateInstructions = '';
  i++;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === 'SP:') { i++; break; }
    candidateInstructions += lines[i] + '\n';
  }
  candidateInstructions = candidateInstructions.trim();

  // Parse SP block until "EXAMINER:"
  const sp = {};
  let currentField = null;
  let buffer = [];
  const flushSP = () => {
    if (currentField) sp[currentField] = buffer.join('\n').trim();
    buffer = [];
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === 'EXAMINER:') { flushSP(); i++; break; }
    const fieldMatch = SP_FIELDS.find(f => line.trim().startsWith(f + ':'));
    if (fieldMatch) {
      flushSP();
      currentField = fieldMatch;
      buffer.push(line.trim().slice((fieldMatch + ':').length).trim());
    } else {
      buffer.push(line);
    }
  }

  // Parse EXAMINER block to end of file
  const examiner = {};
  currentField = null;
  buffer = [];
  const flushExam = () => {
    if (currentField) examiner[currentField] = buffer.join('\n').trim();
    buffer = [];
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    const fieldMatch = EXAM_FIELDS.find(f => line.trim().startsWith(f + ':'));
    if (fieldMatch) {
      flushExam();
      currentField = fieldMatch;
      buffer.push(line.trim().slice((fieldMatch + ':').length).trim());
    } else {
      buffer.push(line);
    }
  }
  flushExam();

  return { meta, candidateInstructions, sp, examiner };
}

function loadAllCases(casesDir) {
  const files = fs.readdirSync(casesDir).filter(f => f.endsWith('.txt')).sort();
  return files.map(f => {
    const id = path.basename(f, '.txt');
    const raw = fs.readFileSync(path.join(casesDir, f), 'utf8');
    const parsed = parseCase(raw);
    return { id, file: f, ...parsed };
  });
}

module.exports = { parseCase, loadAllCases };

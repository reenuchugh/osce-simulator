let sessionId = null;
let durationMin = 8;
let timerInterval = null;
let secondsLeft = 0;
let recognizing = false;
let recognition = null;

const caseSelect = document.getElementById('caseSelect');
const loadBtn = document.getElementById('loadBtn');
const setupCard = document.getElementById('setupCard');
const instructionsCard = document.getElementById('instructionsCard');
const stationCard = document.getElementById('stationCard');
const caseTitle = document.getElementById('caseTitle');
const instructionsDiv = document.getElementById('instructions');
const stationTypeBadge = document.getElementById('stationTypeBadge');
const durationBadge = document.getElementById('durationBadge');
const startBtn = document.getElementById('startBtn');
const chatlog = document.getElementById('chatlog');
const textInput = document.getElementById('textInput');
const micBtn = document.getElementById('micBtn');
const hardBtn = document.getElementById('hardBtn');
const rapidBtn = document.getElementById('rapidBtn');
const endBtn = document.getElementById('endBtn');
const feedbackBtn = document.getElementById('feedbackBtn');
const timerDiv = document.getElementById('timer');

async function loadCases() {
  const res = await fetch('/api/cases');
  const data = await res.json();
  caseSelect.innerHTML = data.cases.map(c => `<option value="${c.id}">${c.id.toUpperCase()} — ${c.title} (${c.stationType})</option>`).join('');
}
loadCases();

loadBtn.onclick = async () => {
  const caseId = caseSelect.value;
  const res = await fetch('/api/session/load', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ caseId })
  });
  const data = await res.json();
  if (data.error) { alert(data.error); return; }
  sessionId = data.sessionId;
  durationMin = data.duration || 8;
  caseTitle.textContent = data.title;
  instructionsDiv.textContent = data.candidateInstructions;
  stationTypeBadge.textContent = data.stationType;
  durationBadge.textContent = `${durationMin} min`;
  setupCard.style.display = 'none';
  instructionsCard.style.display = 'block';
};

startBtn.onclick = async () => {
  const res = await fetch('/api/session/start', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ sessionId })
  });
  const data = await res.json();
  instructionsCard.style.display = 'none';
  stationCard.style.display = 'block';
  addMsg('patient', data.reply);
  speak(data.reply);
  startTimer(durationMin * 60);
};

function startTimer(seconds) {
  secondsLeft = seconds;
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    secondsLeft--;
    updateTimerDisplay();
    if (secondsLeft <= 0) {
      clearInterval(timerInterval);
      addMsg('system', "Time's up! Type END or say END to finish.");
    }
  }, 1000);
}
function updateTimerDisplay() {
  const m = Math.floor(Math.max(secondsLeft,0) / 60).toString().padStart(2,'0');
  const s = Math.max(secondsLeft,0) % 60;
  timerDiv.textContent = `${m}:${s.toString().padStart(2,'0')}`;
  if (secondsLeft <= 60) timerDiv.style.color = '#ff6b6b';
}

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = text;
  chatlog.appendChild(div);
  chatlog.scrollTop = chatlog.scrollHeight;
}

async function sendMessage(text) {
  if (!text || !text.trim()) return;
  const isCommand = ['HARD','RAPID','END','EXAMINER','FEEDBACK'].includes(text.trim().toUpperCase());
  addMsg(isCommand ? 'system' : 'candidate', text);
  const res = await fetch('/api/session/message', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ sessionId, text })
  });
  const data = await res.json();
  if (data.error) { addMsg('system', 'Error: ' + data.error); return; }
  if (data.systemNote) addMsg('system', data.systemNote);
  if (data.reply) {
    const role = data.mode === 'examiner' || data.mode === 'done' ? 'examiner' : 'patient';
    addMsg(role, data.reply);
    if (data.mode === 'sp') speak(data.reply);
  }
  if (data.mode === 'examiner') {
    clearInterval(timerInterval);
    feedbackBtn.style.display = 'inline-block';
  }
  if (data.mode === 'done') {
    feedbackBtn.style.display = 'none';
  }
}

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const text = textInput.value;
    textInput.value = '';
    sendMessage(text);
  }
});

hardBtn.onclick = () => sendMessage('HARD');
rapidBtn.onclick = () => sendMessage('RAPID');
endBtn.onclick = () => sendMessage('END');
feedbackBtn.onclick = () => sendMessage('FEEDBACK');

// Voice: speech recognition (STT)
function setupRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    micBtn.disabled = true;
    micBtn.title = 'Speech recognition not supported in this browser. Use Chrome.';
    return;
  }
  recognition = new SpeechRecognition();
  recognition.lang = 'en-CA';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    const text = event.results[0][0].transcript;
    sendMessage(text);
  };
  recognition.onend = () => {
    recognizing = false;
    micBtn.classList.remove('recording');
    micBtn.textContent = '🎤 Speak';
  };
  recognition.onerror = (e) => {
    recognizing = false;
    micBtn.classList.remove('recording');
    micBtn.textContent = '🎤 Speak';
  };
}
setupRecognition();

micBtn.onclick = () => {
  if (!recognition) return;
  if (recognizing) {
    recognition.stop();
    return;
  }
  recognizing = true;
  micBtn.classList.add('recording');
  micBtn.textContent = '🔴 Listening...';
  recognition.start();
};

// Voice: speech synthesis (TTS)
function speak(text) {
  if (!window.speechSynthesis) return;
  const clean = text.replace(/\[.*?\]/g, ''); // strip bracketed stage directions
  const utter = new SpeechSynthesisUtterance(clean);
  utter.lang = 'en-CA';
  utter.rate = 1.0;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}

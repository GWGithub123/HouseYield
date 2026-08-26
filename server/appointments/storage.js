// Simple JSON file persistence for appointments (MVP)
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'server', 'data');
const FILE_PATH = path.join(DATA_DIR, 'appointments.json');

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE_PATH)) fs.writeFileSync(FILE_PATH, JSON.stringify({ appointments: [], attempts: [], events: [] }, null, 2));
}

export function loadAll() {
  ensureFile();
  const raw = fs.readFileSync(FILE_PATH, 'utf8');
  return JSON.parse(raw);
}

export function saveAll(data) {
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2));
}

export function insertAppointment(apt) {
  const db = loadAll();
  db.appointments.push(apt);
  saveAll(db);
  return apt;
}

export function updateAppointment(apt) {
  const db = loadAll();
  const idx = db.appointments.findIndex(a => a.id === apt.id);
  if (idx !== -1) {
    db.appointments[idx] = apt;
    saveAll(db);
  }
  return apt;
}

export function listAppointments() {
  return loadAll().appointments;
}

export function getAppointment(id) {
  return loadAll().appointments.find(a => a.id === id) || null;
}

export function insertAttempt(att) {
  const db = loadAll();
  db.attempts.push(att);
  saveAll(db);
  return att;
}

export function updateAttempt(att) {
  const db = loadAll();
  const idx = db.attempts.findIndex(a => a.id === att.id);
  if (idx !== -1) {
    db.attempts[idx] = att;
    saveAll(db);
  }
  return att;
}

export function listAttemptsForRequest(requestId) {
  return loadAll().attempts.filter(a => a.requestId === requestId);
}

export function insertEvent(evt) {
  const db = loadAll();
  db.events.push(evt);
  saveAll(db);
  return evt;
}

export function listEvents(requestId) {
  return loadAll().events.filter(e => e.requestId === requestId);
}

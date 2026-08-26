import { newProposedSlot } from './models.js';

// Generate 3 default slots across next 3 business days within 9-5 local (assume Eastern for now)
export function generateInitialSlots({ days = 3, windows = [ [9,12], [12,15], [15,18] ] } = {}) {
  const slots = [];
  const now = new Date();
  let dayCursor = 0;
  while (slots.length < 3 && dayCursor < days + 5) { // safety cap
    const d = new Date(now.getTime());
    d.setDate(d.getDate() + dayCursor);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) { // skip weekends
      dayCursor++;
      continue;
    }
    windows.forEach(([startH, endH]) => {
      if (slots.length >= 3) return;
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), startH, 0, 0, 0);
      const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), endH, 0, 0, 0);
      if (start < now) return; // skip past
      const spanHours = endH - startH;
      const score = 1 - (dayCursor * 0.1) - (spanHours > 3 ? 0.05 : 0); // simple decay scoring
      slots.push(newProposedSlot({ start: start.toISOString(), end: end.toISOString(), score }));
    });
    dayCursor++;
  }
  return slots.sort((a,b) => b.score - a.score).slice(0,3);
}

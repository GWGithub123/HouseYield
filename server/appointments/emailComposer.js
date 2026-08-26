import { newActionToken } from './tokens.js';

export function composeSchedulingEmail({ request, provider, slots, baseUrl }) {
  const slotLines = slots.map((s,i)=>`Option ${i+1}: ${fmt(s.start)} – ${fmt(s.end)}`).join('\n');
  const tokens = slots.map((s,i)=>({ i, token: newActionToken({ requestId: request.id, action: 'confirm', slotId: s.id }) }));
  const altToken = newActionToken({ requestId: request.id, action: 'propose' });
  const subject = `Service Request – ${shortIssue(request)} – ${request.address}`;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif">\n<h3>Service Request</h3>\n<p>${escapeHtml(request.issueDescription)}</p>\n<p><strong>Proposed Time Windows (local):</strong><br/>${slots.map((s,i)=>`<div>Option ${i+1}: ${fmt(s.start)} – ${fmt(s.end)} <a href='${baseUrl}/api/appointments/confirm?token=${tokens[i].token}&slot=${i}'>Confirm</a></div>`).join('')} </p>\n<p>Need a different time? <a href='${baseUrl}/api/appointments/propose?token=${altToken}'>Suggest another</a></p>\n<hr/><small>This request was generated automatically. Reply with an alternative time if none of the above work.</small>\n<!-- SCHED_META:${JSON.stringify({ requestId: request.id, slots: slots.map(s=>({id:s.id,start:s.start,end:s.end})) })} -->\n</body></html>`;
  return { subject, html, debug: { slotLines, tokens, altToken } };
}

function fmt(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
}
function shortIssue(request){
  return (request.extractedIssue || request.issueDescription).slice(0,40);
}
function escapeHtml(str=''){return str.replace(/[&<>]/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));}

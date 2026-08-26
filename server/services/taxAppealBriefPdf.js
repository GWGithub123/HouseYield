import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const PAGE = {
  width: 612,
  height: 792,
  marginX: 54,
  marginTop: 54,
  marginBottom: 54,
};

function money(value) {
  if (!Number.isFinite(value)) return '—';
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

function pct(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

function formatDate(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export async function generateTaxAppealBriefPdf(brief) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);

  let page = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - PAGE.marginTop;
  const contentWidth = PAGE.width - PAGE.marginX * 2;

  function ensureSpace(height = 14) {
    if (y - height < PAGE.marginBottom) {
      page = pdf.addPage([PAGE.width, PAGE.height]);
      y = PAGE.height - PAGE.marginTop;
    }
  }

  function drawLine(text, { size = 10, useBold = false, color = rgb(0.1, 0.1, 0.1), indent = 0 } = {}) {
    ensureSpace(size + 4);
    page.drawText(String(text), {
      x: PAGE.marginX + indent,
      y,
      size,
      font: useBold ? bold : font,
      color,
      maxWidth: contentWidth - indent,
    });
    y -= size + 4;
  }

  drawLine('Property Tax Appeal — Comparable Sales Summary', { size: 16, useBold: true });
  drawLine('HouseYield research packet (verify all figures before filing)', { size: 9, color: rgb(0.35, 0.35, 0.35) });
  y -= 6;

  drawLine(`Property: ${brief.subject?.address || brief.address}`, { useBold: true });
  drawLine(`Generated: ${formatDate(brief.generatedAt)}`);
  drawLine(`Appeal strength (screening): ${String(brief.appealStrength || 'unknown').toUpperCase()}`);
  y -= 8;

  drawLine('Assessment vs market (from recorded comps)', { size: 12, useBold: true });
  drawLine(`Assessed value (${brief.subject?.taxYear || 'latest'} roll): ${money(brief.assessment?.assessedValue)}`);
  drawLine(`Opinion of value (comp-based): ${money(brief.assessment?.opinionOfValue)}`);
  drawLine(`Over-assessment: ${money(brief.assessment?.overAssessmentAmount)} (${pct(brief.assessment?.overAssessmentPct)})`);
  if (brief.projectedSavings?.annual != null) {
    drawLine(`Estimated annual savings if reduced to comp value: ${money(brief.projectedSavings.annual)} (${money(brief.projectedSavings.monthly)}/mo)`);
  }
  y -= 8;

  drawLine('Subject property facts', { size: 12, useBold: true });
  drawLine(`Beds / baths: ${brief.subject?.beds ?? '—'} / ${brief.subject?.baths ?? '—'}`);
  drawLine(`Living area: ${brief.subject?.sqft ? `${Math.round(brief.subject.sqft).toLocaleString()} sq ft` : '—'}`);
  drawLine(`Year built: ${brief.subject?.yearBuilt ?? '—'}`);
  drawLine(`Property type: ${brief.subject?.propertyType || '—'}`);
  y -= 8;

  drawLine('Comparable sales (verify against county records)', { size: 12, useBold: true });
  if (!brief.comparables?.length) {
    drawLine('No qualifying comps found — gather 3–5 verified sales before filing.', { color: rgb(0.6, 0.2, 0.1) });
  } else {
    brief.comparables.forEach((comp, index) => {
      y -= 2;
      drawLine(`${index + 1}. ${comp.address || 'Unknown address'}`, { useBold: true });
      drawLine(`   Sale: ${money(comp.salePrice)} on ${formatDate(comp.saleDate)}`, { indent: 8 });
      drawLine(`   ${comp.bedrooms ?? '—'} bd / ${comp.bathrooms ?? '—'} ba · ${comp.squareFootage ? `${Math.round(comp.squareFootage).toLocaleString()} sq ft` : '—'} · ${comp.pricePerSqft ? `$${comp.pricePerSqft}/sqft` : '—'}`, { indent: 8 });
      if (comp.distanceMiles != null) {
        drawLine(`   Distance: ${comp.distanceMiles.toFixed(2)} mi`, { indent: 8 });
      }
    });
  }
  y -= 8;

  if (brief.factualIssues?.length) {
    drawLine('Items to verify on assessor record', { size: 12, useBold: true });
    brief.factualIssues.forEach((issue) => {
      drawLine(`• ${issue.message}`, { indent: 4 });
    });
    y -= 6;
  }

  drawLine('Next steps', { size: 12, useBold: true });
  (brief.nextSteps || []).slice(0, 5).forEach((step) => {
    drawLine(`• ${step}`, { indent: 4 });
  });
  y -= 8;

  drawLine('Important disclaimers', { size: 11, useBold: true });
  (brief.disclaimers || []).forEach((line) => {
    drawLine(line, { size: 8, color: rgb(0.35, 0.35, 0.35) });
  });

  drawLine('Do not submit AVM estimates as evidence. Use verified comparable sales only.', {
    size: 8,
    color: rgb(0.5, 0.2, 0.1),
  });

  return pdf.save();
}

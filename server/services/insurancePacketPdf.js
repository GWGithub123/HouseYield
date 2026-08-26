import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const PAGE = { width: 612, height: 792, marginX: 48, top: 58, bottom: 54 };
const COLORS = {
  navy: rgb(0.055, 0.125, 0.205),
  blue: rgb(0.09, 0.32, 0.55),
  cyan: rgb(0.08, 0.55, 0.67),
  green: rgb(0.09, 0.49, 0.34),
  amber: rgb(0.75, 0.42, 0.08),
  red: rgb(0.68, 0.18, 0.2),
  ink: rgb(0.12, 0.15, 0.18),
  muted: rgb(0.38, 0.43, 0.48),
  line: rgb(0.82, 0.85, 0.88),
  soft: rgb(0.95, 0.965, 0.975),
  white: rgb(1, 1, 1),
};

function dateLabel(value, includeTime = false) {
  if (!value) return 'Not documented';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Not documented';
  return parsed.toLocaleString('en-US', includeTime
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
}

function yesNo(value, noLabel = 'Not verified') {
  return value === true ? 'Verified' : noLabel;
}

function valueOrMissing(value) {
  return value === null || value === undefined || value === '' ? 'Not documented' : String(value);
}

function truncate(value, max = 80) {
  const text = String(value || '');
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

async function embedEvidenceImages(pdf, urls = []) {
  const allowedHosts = new Set(['firebasestorage.googleapis.com', 'storage.googleapis.com']);
  const embedded = [];
  for (const rawUrl of urls.slice(0, 8)) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) continue;
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) continue;
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > 8 * 1024 * 1024) continue;
      const contentType = response.headers.get('content-type') || '';
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 8 * 1024 * 1024) continue;
      const image = contentType.includes('png')
        ? await pdf.embedPng(bytes)
        : contentType.includes('jpeg') || contentType.includes('jpg')
          ? await pdf.embedJpg(bytes)
          : null;
      if (image) embedded.push({ image, url: rawUrl });
    } catch {
      // The evidence remains listed in the manifest if preview embedding fails.
    }
  }
  return embedded;
}

class PacketRenderer {
  constructor(pdf, snapshot, title) {
    this.pdf = pdf;
    this.snapshot = snapshot;
    this.title = title;
    this.pages = [];
    this.page = null;
    this.y = 0;
  }

  async initialize() {
    this.font = await this.pdf.embedFont(StandardFonts.Helvetica);
    this.bold = await this.pdf.embedFont(StandardFonts.HelveticaBold);
    this.italic = await this.pdf.embedFont(StandardFonts.HelveticaOblique);
  }

  addPage(section = this.title) {
    this.page = this.pdf.addPage([PAGE.width, PAGE.height]);
    this.pages.push(this.page);
    this.y = PAGE.height - PAGE.top;
    if (this.pages.length > 1) {
      this.page.drawText('HOUSEYIELD  /  WATER-LOSS MITIGATION', {
        x: PAGE.marginX,
        y: PAGE.height - 30,
        size: 7.5,
        font: this.bold,
        color: COLORS.blue,
      });
      this.page.drawText(truncate(section.toUpperCase(), 58), {
        x: PAGE.width - PAGE.marginX - this.bold.widthOfTextAtSize(truncate(section.toUpperCase(), 58), 7.5),
        y: PAGE.height - 30,
        size: 7.5,
        font: this.bold,
        color: COLORS.muted,
      });
      this.page.drawLine({
        start: { x: PAGE.marginX, y: PAGE.height - 38 },
        end: { x: PAGE.width - PAGE.marginX, y: PAGE.height - 38 },
        thickness: 0.7,
        color: COLORS.line,
      });
    }
    return this.page;
  }

  ensure(height, section) {
    if (!this.page || this.y - height < PAGE.bottom) this.addPage(section);
  }

  wrap(text, size, font = this.font, width = PAGE.width - PAGE.marginX * 2) {
    const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!words.length) return [''];
    const lines = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  paragraph(text, options = {}) {
    const size = options.size || 9.5;
    const font = options.font || this.font;
    const width = options.width || PAGE.width - PAGE.marginX * 2;
    const lineHeight = options.lineHeight || size * 1.4;
    const lines = this.wrap(text, size, font, width);
    this.ensure(lines.length * lineHeight + (options.after ?? 7), options.section);
    for (const line of lines) {
      this.page.drawText(line, {
        x: options.x || PAGE.marginX,
        y: this.y,
        size,
        font,
        color: options.color || COLORS.ink,
      });
      this.y -= lineHeight;
    }
    this.y -= options.after ?? 7;
  }

  heading(text, section = text) {
    this.ensure(34, section);
    this.y -= 2;
    this.page.drawText(text, {
      x: PAGE.marginX,
      y: this.y,
      size: 14,
      font: this.bold,
      color: COLORS.navy,
    });
    this.y -= 10;
    this.page.drawLine({
      start: { x: PAGE.marginX, y: this.y },
      end: { x: PAGE.width - PAGE.marginX, y: this.y },
      thickness: 1.1,
      color: COLORS.cyan,
    });
    this.y -= 16;
  }

  subheading(text, section) {
    this.ensure(25, section);
    this.page.drawText(text, {
      x: PAGE.marginX,
      y: this.y,
      size: 10.5,
      font: this.bold,
      color: COLORS.blue,
    });
    this.y -= 17;
  }

  callout(title, body, tone = 'blue', section) {
    const color = tone === 'green' ? COLORS.green : tone === 'amber' ? COLORS.amber : tone === 'red' ? COLORS.red : COLORS.blue;
    const bodyLines = this.wrap(body, 9, this.font, PAGE.width - PAGE.marginX * 2 - 30);
    const height = 36 + bodyLines.length * 12;
    this.ensure(height + 8, section);
    this.page.drawRectangle({
      x: PAGE.marginX,
      y: this.y - height + 10,
      width: PAGE.width - PAGE.marginX * 2,
      height,
      color: COLORS.soft,
      borderColor: color,
      borderWidth: 1,
    });
    this.page.drawRectangle({
      x: PAGE.marginX,
      y: this.y - height + 10,
      width: 4,
      height,
      color,
    });
    this.page.drawText(title, { x: PAGE.marginX + 15, y: this.y - 10, size: 10, font: this.bold, color });
    let lineY = this.y - 27;
    for (const line of bodyLines) {
      this.page.drawText(line, { x: PAGE.marginX + 15, y: lineY, size: 9, font: this.font, color: COLORS.ink });
      lineY -= 12;
    }
    this.y -= height + 4;
  }

  keyValues(entries, columns = 2, section) {
    const gap = 16;
    const width = (PAGE.width - PAGE.marginX * 2 - gap * (columns - 1)) / columns;
    for (let index = 0; index < entries.length; index += columns) {
      const row = entries.slice(index, index + columns);
      const rowHeight = Math.max(...row.map(([, value]) => 29 + this.wrap(valueOrMissing(value), 9.2, this.bold, width).length * 11));
      this.ensure(rowHeight + 7, section);
      row.forEach(([label, value], column) => {
        const x = PAGE.marginX + column * (width + gap);
        this.page.drawText(String(label).toUpperCase(), { x, y: this.y, size: 6.8, font: this.bold, color: COLORS.muted });
        const lines = this.wrap(valueOrMissing(value), 9.2, this.bold, width);
        lines.forEach((line, lineIndex) => {
          this.page.drawText(line, { x, y: this.y - 14 - lineIndex * 11, size: 9.2, font: this.bold, color: COLORS.ink });
        });
      });
      this.y -= rowHeight;
    }
    this.y -= 3;
  }

  table(headers, rows, widths, section) {
    const totalWidth = PAGE.width - PAGE.marginX * 2;
    const resolved = widths.map((width) => width * totalWidth);
    const drawHeader = () => {
      this.ensure(24, section);
      this.page.drawRectangle({ x: PAGE.marginX, y: this.y - 16, width: totalWidth, height: 21, color: COLORS.navy });
      let x = PAGE.marginX + 6;
      headers.forEach((header, index) => {
        this.page.drawText(truncate(header.toUpperCase(), 30), { x, y: this.y - 9, size: 6.5, font: this.bold, color: COLORS.white });
        x += resolved[index];
      });
      this.y -= 22;
    };
    drawHeader();
    rows.forEach((row, rowIndex) => {
      const wrappedCells = row.map((value, index) => this.wrap(valueOrMissing(value), 7.5, this.font, resolved[index] - 10));
      const height = Math.max(23, Math.max(...wrappedCells.map((lines) => lines.length)) * 10 + 9);
      if (this.y - height < PAGE.bottom) {
        this.addPage(section);
        drawHeader();
      }
      if (rowIndex % 2 === 0) {
        this.page.drawRectangle({ x: PAGE.marginX, y: this.y - height + 4, width: totalWidth, height, color: COLORS.soft });
      }
      let x = PAGE.marginX + 6;
      wrappedCells.forEach((lines, cellIndex) => {
        lines.forEach((line, lineIndex) => {
          this.page.drawText(line, { x, y: this.y - 9 - lineIndex * 10, size: 7.5, font: this.font, color: COLORS.ink });
        });
        x += resolved[cellIndex];
      });
      this.y -= height;
    });
    this.y -= 10;
  }

  bullets(items, section) {
    for (const item of items.filter(Boolean)) {
      const lines = this.wrap(item, 9, this.font, PAGE.width - PAGE.marginX * 2 - 18);
      this.ensure(lines.length * 12 + 4, section);
      this.page.drawCircle({ x: PAGE.marginX + 3, y: this.y + 3, size: 2, color: COLORS.cyan });
      lines.forEach((line, index) => {
        this.page.drawText(line, { x: PAGE.marginX + 14, y: this.y - index * 12, size: 9, font: this.font, color: COLORS.ink });
      });
      this.y -= lines.length * 12 + 4;
    }
    this.y -= 4;
  }

  architecture(nodes, section) {
    this.ensure(104, section);
    const gap = 7;
    const width = (PAGE.width - PAGE.marginX * 2 - gap * (nodes.length - 1)) / nodes.length;
    nodes.forEach((node, index) => {
      const x = PAGE.marginX + index * (width + gap);
      this.page.drawRectangle({
        x,
        y: this.y - 62,
        width,
        height: 54,
        color: index === nodes.length - 1 ? COLORS.navy : COLORS.soft,
        borderColor: index === nodes.length - 1 ? COLORS.navy : COLORS.line,
        borderWidth: 1,
      });
      const lines = this.wrap(node, 7.3, this.bold, width - 12).slice(0, 4);
      lines.forEach((line, lineIndex) => {
        this.page.drawText(line, {
          x: x + 6,
          y: this.y - 27 - lineIndex * 9,
          size: 7.3,
          font: this.bold,
          color: index === nodes.length - 1 ? COLORS.white : COLORS.ink,
        });
      });
      if (index < nodes.length - 1) {
        this.page.drawLine({
          start: { x: x + width, y: this.y - 35 },
          end: { x: x + width + gap, y: this.y - 35 },
          thickness: 1.2,
          color: COLORS.cyan,
        });
      }
    });
    this.y -= 76;
  }

  imageGallery(items, section) {
    if (!items.length) return;
    const gap = 14;
    const boxWidth = (PAGE.width - PAGE.marginX * 2 - gap) / 2;
    const boxHeight = 155;
    for (let index = 0; index < items.length; index += 2) {
      this.ensure(boxHeight + 28, section);
      items.slice(index, index + 2).forEach((item, column) => {
        const x = PAGE.marginX + column * (boxWidth + gap);
        this.page.drawRectangle({
          x,
          y: this.y - boxHeight,
          width: boxWidth,
          height: boxHeight,
          color: COLORS.soft,
          borderColor: COLORS.line,
          borderWidth: 1,
        });
        const scale = Math.min((boxWidth - 10) / item.image.width, (boxHeight - 10) / item.image.height);
        const width = item.image.width * scale;
        const height = item.image.height * scale;
        this.page.drawImage(item.image, {
          x: x + (boxWidth - width) / 2,
          y: this.y - boxHeight + (boxHeight - height) / 2,
          width,
          height,
        });
        this.page.drawText(truncate(new URL(item.url).pathname.split('/').pop() || 'Installation evidence', 44), {
          x,
          y: this.y - boxHeight - 12,
          size: 6.5,
          font: this.font,
          color: COLORS.muted,
        });
      });
      this.y -= boxHeight + 25;
    }
  }

  finalize() {
    const verification = this.snapshot.verificationCode || 'DRAFT';
    const shortHash = this.snapshot.snapshotHash ? this.snapshot.snapshotHash.slice(0, 16) : 'not issued';
    this.pages.forEach((page, index) => {
      page.drawLine({
        start: { x: PAGE.marginX, y: 36 },
        end: { x: PAGE.width - PAGE.marginX, y: 36 },
        thickness: 0.6,
        color: COLORS.line,
      });
      page.drawText(`HouseYield  |  ${verification}  |  SHA-256 ${shortHash}`, {
        x: PAGE.marginX,
        y: 22,
        size: 6.5,
        font: this.font,
        color: COLORS.muted,
      });
      const pageText = `Page ${index + 1} of ${this.pages.length}`;
      page.drawText(pageText, {
        x: PAGE.width - PAGE.marginX - this.font.widthOfTextAtSize(pageText, 6.5),
        y: 22,
        size: 6.5,
        font: this.font,
        color: COLORS.muted,
      });
    });
  }
}

function commissioned(snapshot) {
  return snapshot.commissioning.automaticShutoffEnabled === true &&
    snapshot.commissioning.unattendedShutoffVerified === true &&
    snapshot.commissioning.waterFlowStoppedVerified === true;
}

function drawCover(renderer, subtitle) {
  const { snapshot } = renderer;
  const ready = snapshot.commissioningStatus.readyForSubmission;
  const issued = snapshot.documentStatus === 'issued';
  renderer.addPage('Cover');
  renderer.page.drawRectangle({ x: 0, y: 515, width: PAGE.width, height: 277, color: COLORS.navy });
  renderer.page.drawRectangle({ x: 0, y: 505, width: PAGE.width, height: 10, color: COLORS.cyan });
  renderer.page.drawText('HOUSEYIELD', { x: PAGE.marginX, y: 744, size: 11, font: renderer.bold, color: COLORS.cyan });
  renderer.page.drawText('WATER-LOSS MITIGATION', { x: PAGE.marginX, y: 682, size: 25, font: renderer.bold, color: COLORS.white });
  renderer.page.drawText('EVIDENCE PACKET', { x: PAGE.marginX, y: 650, size: 25, font: renderer.bold, color: COLORS.white });
  renderer.y = 618;
  renderer.paragraph(subtitle, {
    x: PAGE.marginX,
    width: 440,
    size: 10.5,
    lineHeight: 15,
    color: rgb(0.8, 0.87, 0.92),
    after: 0,
  });
  renderer.y = 468;
  renderer.page.drawText(snapshot.property.address, { x: PAGE.marginX, y: renderer.y, size: 17, font: renderer.bold, color: COLORS.navy });
  renderer.y -= 32;
  const statusText = issued ? 'SEALED ISSUANCE' : ready ? 'READY - DOWNLOAD COMBINED PACKET TO SEAL' : 'DRAFT - NOT READY FOR SUBMISSION';
  const statusColor = issued ? COLORS.green : ready ? COLORS.blue : COLORS.amber;
  renderer.page.drawRectangle({ x: PAGE.marginX, y: renderer.y - 4, width: 264, height: 24, color: statusColor });
  renderer.page.drawText(statusText, { x: PAGE.marginX + 10, y: renderer.y + 4, size: 8.2, font: renderer.bold, color: COLORS.white });
  renderer.y -= 48;
  renderer.keyValues([
    ['Automatic shutoff', commissioned(snapshot) ? 'Commissioned and flow-tested' : 'Not fully verified'],
    ['Leak detection', `${snapshot.systemSummary.leakSensorCount} enrolled point sensor(s)`],
    ['Monitoring evidence', snapshot.monitoringEvidence?.telemetryContinuityPercent == null
      ? 'History not yet sufficient'
      : `${snapshot.monitoringEvidence.telemetryContinuityPercent}% hourly telemetry continuity`],
    ['Packet reference', snapshot.verificationCode],
    ['Issued / generated', dateLabel(snapshot.issuedAt || snapshot.generatedAt, true)],
    ['Installer attestation', snapshot.commissioning.attestationSignedAt
      ? `${snapshot.commissioning.attestationSignerName} / ${dateLabel(snapshot.commissioning.attestationSignedAt)}`
      : 'Not signed'],
    ['Annual recertification', snapshot.annualCertification?.packetEligible
      ? `${String(snapshot.annualCertification.status).replace(/_/g, ' ')} / due ${dateLabel(snapshot.annualCertification.nextDueAt)}`
      : String(snapshot.annualCertification?.status || 'not certified').replace(/_/g, ' ')],
  ], 2, 'Cover');
  renderer.callout(
    commissioned(snapshot) ? 'Documented protection' : 'Important draft limitation',
    commissioned(snapshot)
      ? 'The saved commissioning record states that the automatic shutoff path was enabled, operated without attendance during testing, stopped water flow, and restored service after the test.'
      : 'This packet must not be described as proof of a functioning automatic shutoff until the shutoff, stopped-flow, restoration, and installer-attestation checks are complete.',
    commissioned(snapshot) ? 'green' : 'amber',
    'Cover',
  );
}

/**
 * The point-of-leak detection bullet, with a denominator when we have one.
 *
 * A bare "4 documented locations" is unusable to an underwriter, so where the
 * property records support an expected wet-location count the bullet states the
 * fraction and, importantly, what the denominator rests on. Where they do not,
 * it falls back to the old bare count rather than inventing a basis: an
 * unqualified percentage in an insurance document is exactly the kind of claim
 * `INSURANCE_PACKET_STANDARDS.md` exists to prevent.
 */
function coverageBullet(systemSummary) {
  const enrolled = `${systemSummary.leakSensorCount} enrolled sensor(s)`;
  const expected = systemSummary.expectedWetLocationCount;
  const monitored = systemSummary.monitoredWetLocationCount ?? 0;

  if (!expected) {
    return `Point-of-leak detection: ${enrolled} across ${systemSummary.monitoredLocationCount || 0} documented location(s).`;
  }

  return `Point-of-leak detection: ${enrolled} covering ${monitored} of ${expected} expected wet location(s)`
    + ` (${systemSummary.coveragePercent}%). ${systemSummary.basis}`;
}

function renderExecutive(renderer) {
  const snapshot = renderer.snapshot;
  const commissioning = snapshot.commissioning;
  renderer.heading('1. Underwriting submission summary');
  renderer.paragraph(snapshot.underwritingNarrative.request);
  renderer.callout('Carrier qualification notice', snapshot.underwritingNarrative.qualificationNotice, 'blue');
  renderer.keyValues([
    ['Insured / applicant', snapshot.insuredContact.name],
    ['Carrier / policy', [commissioning.insurerName, commissioning.policyNumber].filter(Boolean).join(' / ')],
    ['Property type', snapshot.propertyFacts.propertyType],
    ['Occupancy', snapshot.propertyFacts.occupancyType],
    ['Year built', snapshot.propertyFacts.yearBuilt],
    ['Living area', snapshot.propertyFacts.livingAreaSqFt ? `${Number(snapshot.propertyFacts.livingAreaSqFt).toLocaleString()} sq ft` : null],
    ['Installed', dateLabel(commissioning.installDate)],
    ['Latest shutoff test', dateLabel(commissioning.latestSuccessfulTestDate)],
  ], 2, 'Underwriting summary');
  renderer.subheading('Protection classification', 'Underwriting summary');
  renderer.bullets([
    coverageBullet(snapshot.systemSummary),
    commissioned(snapshot)
      ? 'Automatic main-water shutoff: documented as enabled and functionally tested, including stopped-flow verification.'
      : 'Automatic main-water shutoff: installation may be recorded, but the complete commissioning evidence is not yet present.',
    `Freeze-risk monitoring: ${snapshot.sensors.filter((sensor) => sensor.type === 'temperature_humidity' || sensor.type === 'temperature').length} environmental device(s).`,
    `Active response record: ${snapshot.responseOperations.maintenanceRequestsRecorded} maintenance record(s), ${snapshot.responseOperations.completedMaintenanceRequests} completed.`,
  ], 'Underwriting summary');
  renderer.subheading('Live property protection architecture', 'Protection architecture');
  renderer.architecture([
    'Leak and climate sensors',
    'Shelly gateway / property network',
    'HouseYield monitoring and alert logic',
    'Shelly dry-contact relay',
    'EcoNet Bulldog main-water actuator',
  ], 'Protection architecture');
  renderer.paragraph(
    'The diagram is a functional property-twin summary generated from the enrolled equipment and saved commissioning record. It is not a manufacturer wiring diagram.',
    { size: 7.8, color: COLORS.muted },
  );
}

function renderInventory(renderer) {
  const snapshot = renderer.snapshot;
  renderer.heading('2. Installed equipment and coverage');
  renderer.paragraph('Inventory is generated from property-assigned IoT records. Model, firmware, identifier, location, and current telemetry state are shown where recorded.');
  const rows = snapshot.sensors.map((sensor) => [
    sensor.manufacturer || 'Not recorded',
    sensor.model || sensor.name || sensor.type,
    sensor.protectionRole || sensor.type,
    sensor.location,
    sensor.mac || sensor.deviceId,
    sensor.status,
  ]);
  renderer.table(
    ['Manufacturer', 'Model / device', 'Protection role', 'Location', 'Identifier', 'State'],
    rows.length ? rows : [['-', 'No property devices found', '-', '-', '-', '-']],
    [0.14, 0.19, 0.21, 0.16, 0.18, 0.12],
    'Equipment inventory',
  );
  renderer.subheading('Installation-operations reconciliation', 'Equipment inventory');
  renderer.keyValues([
    ['Install-kit status', snapshot.installationOperations?.installKitStatus],
    ['Bench-provisioned devices', snapshot.installationOperations?.benchProvisionedDeviceCount ?? 0],
    ['Latest bench provisioning', dateLabel(snapshot.installationOperations?.benchProvisionedAt, true)],
    ['Unreconciled provisioned devices', snapshot.installationOperations?.unreconciledProvisionedDeviceIds?.length ?? 0],
  ], 2, 'Equipment inventory');
  if (snapshot.installationOperations?.disclosure) {
    renderer.paragraph(snapshot.installationOperations.disclosure, {
      size: 7.8,
      color: COLORS.muted,
      section: 'Equipment inventory',
    });
  }
  renderer.subheading('Automatic shutoff assembly', 'Equipment inventory');
  renderer.keyValues([
    ['Valve / actuator', snapshot.commissioning.hardwareModel],
    ['Valve serial', snapshot.commissioning.shutoffSerialNumber],
    ['Relay serial', snapshot.commissioning.relaySerialNumber],
    ['Valve location', snapshot.commissioning.valveLocation],
    ['Main water line', snapshot.commissioning.primaryWaterLineLocation],
    ['Battery backup', yesNo(snapshot.commissioning.batteryBackupInstalled, 'Not documented')],
  ], 2, 'Equipment inventory');
  renderer.subheading('Manufacturer and installer credentials', 'Equipment inventory');
  const shellyCredentialVerified =
    snapshot.commissioning.shellyPartnerStatus === 'verified' &&
    snapshot.commissioning.shellyCredentialDocumentUrls?.length > 0;
  const econetCredentialVerified =
    snapshot.commissioning.econetPartnerStatus === 'verified' &&
    snapshot.commissioning.econetCredentialDocumentUrls?.length > 0;
  renderer.bullets([
    `Shelly installer / partner status: ${shellyCredentialVerified ? `documented (${snapshot.commissioning.shellyCredentialId || 'credential on file'})` : 'not asserted in this packet'}.`,
    `EcoNet Controls installer / partner status: ${econetCredentialVerified ? `documented (${snapshot.commissioning.econetCredentialId || 'credential on file'})` : 'not asserted in this packet'}.`,
    'Manufacturer names identify installed products only. They do not imply that a carrier has approved HouseYield or this installation.',
  ], 'Equipment inventory');
}

function renderMonitoring(renderer) {
  const snapshot = renderer.snapshot;
  const evidence = snapshot.monitoringEvidence || {};
  renderer.heading('3. Monitoring continuity and system health');
  renderer.callout(
    'Evidence methodology',
    evidence.methodology || 'No historical monitoring methodology was available when this draft was generated.',
    evidence.telemetryContinuityPercent == null ? 'amber' : 'blue',
    'Monitoring evidence',
  );
  renderer.keyValues([
    ['Requested lookback', `${evidence.requestedLookbackDays || 30} days`],
    ['Observed period', evidence.firstObservedAt && evidence.lastObservedAt
      ? `${dateLabel(evidence.firstObservedAt, true)} to ${dateLabel(evidence.lastObservedAt, true)}`
      : 'No qualifying history'],
    ['Telemetry observations', evidence.observationCount ?? 0],
    ['Hourly intervals observed', evidence.observedHourlyIntervals ?? 0],
    ['Telemetry continuity', evidence.telemetryContinuityPercent == null ? 'Insufficient history' : `${evidence.telemetryContinuityPercent}%`],
    ['Devices represented', `${evidence.devicesWithTelemetry ?? 0} of ${evidence.enrolledDeviceCount ?? snapshot.sensors.length}`],
    ['Currently healthy / enrolled', `${evidence.currentlyHealthyDeviceCount ?? 0} / ${evidence.enrolledDeviceCount ?? snapshot.sensors.length}`],
    ['Always-on devices online', `${evidence.alwaysOnDevicesOnline ?? 0} / ${evidence.alwaysOnDeviceCount ?? 0}`],
    ['Latest automated health check', snapshot.annualCertification?.latestAutomatedHealthCheck
      ? `${String(snapshot.annualCertification.latestAutomatedHealthCheck.status).toUpperCase()} / ${dateLabel(snapshot.annualCertification.latestAutomatedHealthCheck.checkedAt, true)}`
      : 'No automated check recorded'],
  ], 2, 'Monitoring evidence');
  if (snapshot.annualCertification?.latestAutomatedHealthCheck) {
    renderer.paragraph(snapshot.annualCertification.latestAutomatedHealthCheck.limitation, {
      size: 7.8,
      color: COLORS.muted,
      section: 'Monitoring evidence',
    });
  }
  if (evidence.dataLimitReached) {
    renderer.callout(
      'Observation cap reached',
      'The packet query reached its evidence-row cap. The stated continuity is calculated from the returned observation range and should not be read as full-period uptime.',
      'amber',
      'Monitoring evidence',
    );
  }
  renderer.subheading('Current device-health evidence', 'Monitoring evidence');
  renderer.table(
    ['Device', 'Role', 'Location', 'Current state', 'Last observed'],
    snapshot.sensors.map((sensor) => [
      sensor.model || sensor.name,
      sensor.protectionRole,
      sensor.location,
      sensor.status,
      dateLabel(sensor.lastSeen, true),
    ]),
    [0.21, 0.25, 0.18, 0.13, 0.23],
    'Monitoring evidence',
  );
  renderer.subheading('Alert and response operations', 'Response operations');
  renderer.bullets([
    snapshot.responseOperations.serviceDescription,
    `Open alerts when generated: ${snapshot.systemSummary.activeAlerts}. Water-related alerts in the returned history: ${snapshot.systemSummary.floodAlertCount}.`,
    `Maintenance workflow evidence: ${snapshot.responseOperations.openMaintenanceRequests} open and ${snapshot.responseOperations.completedMaintenanceRequests} completed record(s) in the returned property history.`,
    snapshot.responseOperations.disclosure,
  ], 'Response operations');
}

function renderCommissioning(renderer) {
  const snapshot = renderer.snapshot;
  const c = snapshot.commissioning;
  renderer.heading('4. Installation and functional commissioning');
  renderer.keyValues([
    ['Installer', [c.installerName, c.installerCompany].filter(Boolean).join(' / ')],
    ['License / credential', c.installerLicenseNumber],
    ['Installer contact', [c.installerEmail, c.installerPhone].filter(Boolean).join(' / ')],
    ['Installation method', c.installationMethod],
    ['Test performed by', c.testPerformedBy],
    ['Test method', c.testMethod],
    ['Valve travel time', c.valveTravelSeconds != null ? `${c.valveTravelSeconds} seconds` : null],
    ['Latest successful test', dateLabel(c.latestSuccessfulTestDate)],
  ], 2, 'Commissioning');
  renderer.table(
    ['Commissioning control', 'Result', 'Evidence date'],
    [
      ['Automatic leak detection enabled', yesNo(c.automaticLeakDetectionEnabled), dateLabel(c.leakAlertVerifiedAt)],
      ['Automatic shutoff enabled', yesNo(c.automaticShutoffEnabled), dateLabel(c.latestSuccessfulTestDate)],
      ['Unattended shutoff operation', yesNo(c.unattendedShutoffVerified), dateLabel(c.latestSuccessfulTestDate)],
      ['Water flow stopped at fixture', yesNo(c.waterFlowStoppedVerified), dateLabel(c.latestSuccessfulTestDate)],
      ['Water service restored after test', yesNo(c.waterServiceRestoredVerified), dateLabel(c.latestSuccessfulTestDate)],
      ['Remote command path', yesNo(Boolean(c.remoteCommandVerifiedAt)), dateLabel(c.remoteCommandVerifiedAt)],
      ['Leak alert path', yesNo(Boolean(c.leakAlertVerifiedAt)), dateLabel(c.leakAlertVerifiedAt)],
      ['Manual override / restore', yesNo(c.manualOverrideVerified), dateLabel(c.latestSuccessfulTestDate)],
      ['Network validation', yesNo(c.wifiValidated), dateLabel(c.latestSuccessfulTestDate)],
    ],
    [0.5, 0.21, 0.29],
    'Commissioning',
  );
  renderer.subheading('Installer attestation', 'Attestation');
  renderer.paragraph(
    c.attestationConsentText ||
      'No electronic installer attestation has been captured. Typed signer metadata alone is not treated as a completed e-signature.',
    { font: c.attestationConsentText ? renderer.italic : renderer.font },
  );
  renderer.keyValues([
    ['Signer', [c.attestationSignerName, c.attestationSignerTitle].filter(Boolean).join(' / ')],
    ['Signer email', c.attestationSignerEmail],
    ['Signed at', dateLabel(c.attestationSignedAt, true)],
    ['Signed evidence', c.signedAttestationDocumentUrls?.length ? `${c.signedAttestationDocumentUrls.length} document(s)` : 'None'],
  ], 2, 'Attestation');

  renderer.subheading('Annual water-loss protection recertification', 'Annual recertification');
  const certificationSummary = snapshot.annualCertification || {};
  const certification = certificationSummary.latestCertified || certificationSummary.latest;
  if (!certification) {
    renderer.callout(
      'No annual functional certification',
      'The guided annual leak-detection, alert-delivery, automatic-shutoff, stopped-flow, restoration, and technician e-signature protocol has not been completed.',
      'amber',
      'Annual recertification',
    );
  } else {
    renderer.keyValues([
      ['Certification status', String(certificationSummary.status || certification.status).replace(/_/g, ' ')],
      ['Protocol', certification.protocolVersion],
      ['Certification ID', certification.id],
      ['Technician', [certification.technician?.name, certification.technician?.company].filter(Boolean).join(' / ')],
      ['Certified at', dateLabel(certification.certifiedAt, true)],
      ['Expires / next due', dateLabel(certification.expiresAt || certification.nextDueAt)],
      ['Inventory fingerprint', certification.inventoryFingerprint],
      ['Signed-document seal', certification.sealedDocumentHash],
    ], 2, 'Annual recertification');
    renderer.table(
      ['Annual test control', 'Result', 'Recorded'],
      (certification.steps || []).map((step) => [
        step.label,
        String(step.result || 'pending').replace(/_/g, ' ').toUpperCase(),
        dateLabel(step.testedAt, true),
      ]),
      [0.55, 0.2, 0.25],
      'Annual recertification',
    );
    if (certificationSummary.inventoryChanged) {
      renderer.callout(
        'Material inventory change detected',
        'The current enrolled-device fingerprint differs from the last signed certification. A new functional recertification is required before insurer submission.',
        'amber',
        'Annual recertification',
      );
    }
  }
}

function renderEvidence(renderer) {
  const snapshot = renderer.snapshot;
  const c = snapshot.commissioning;
  renderer.heading('5. Evidence manifest, verification, and limitations');
  const evidenceRows = [
    ['Installation / placement photos', c.evidencePhotoUrls],
    ['Portal activation / health captures', c.appScreenshotUrls],
    ['Invoices / purchase records', c.invoiceDocumentUrls],
    ['Signed installer attestations', c.signedAttestationDocumentUrls],
    ['Shelly credential evidence', c.shellyCredentialDocumentUrls],
    ['EcoNet credential evidence', c.econetCredentialDocumentUrls],
    ['Other supporting records', c.supportingDocumentUrls],
  ];
  renderer.table(
    ['Evidence category', 'Count', 'Recorded references'],
    evidenceRows.map(([label, urls]) => [
      label,
      Array.isArray(urls) ? urls.length : 0,
      Array.isArray(urls) && urls.length ? urls.map((url) => truncate(url, 65)).join(' | ') : 'None recorded',
    ]),
    [0.29, 0.1, 0.61],
    'Evidence manifest',
  );
  if (snapshot.evidenceAssetManifest?.length) {
    renderer.subheading('Immutable evidence-asset seals', 'Evidence asset seals');
    renderer.table(
      ['Category', 'SHA-256', 'Bytes'],
      snapshot.evidenceAssetManifest.map((asset) => [
        String(asset.category || '').replace(/_/g, ' '),
        asset.sha256,
        asset.byteLength,
      ]),
      [0.3, 0.55, 0.15],
      'Evidence asset seals',
    );
  }
  if (renderer.embeddedEvidenceImages?.length) {
    renderer.subheading('Installation evidence previews', 'Evidence previews');
    renderer.imageGallery(renderer.embeddedEvidenceImages, 'Evidence previews');
    renderer.paragraph(
      'Preview images are embedded from the recorded HouseYield evidence files. The manifest remains the authoritative attachment index.',
      { size: 7.8, color: COLORS.muted, section: 'Evidence previews' },
    );
  }
  renderer.subheading('Submission readiness', 'Evidence manifest');
  renderer.table(
    ['Requirement', 'Status', 'Detail'],
    snapshot.submissionChecklist.map((item) => [
      item.label,
      item.status.toUpperCase(),
      item.detail,
    ]),
    [0.39, 0.15, 0.46],
    'Evidence manifest',
  );
  renderer.subheading('Packet integrity and verification', 'Verification');
  renderer.keyValues([
    ['Document status', snapshot.documentStatus === 'issued' ? 'Sealed issuance' : 'Draft'],
    ['Packet ID', snapshot.packetId],
    ['Verification code', snapshot.verificationCode],
    ['SHA-256 snapshot hash', snapshot.snapshotHash],
    ['Generated / issued', dateLabel(snapshot.issuedAt || snapshot.generatedAt, true)],
    ['Verification endpoint', snapshot.documentStatus === 'issued'
      ? `/api/insurance/certificate/verify/${snapshot.verificationCode}`
      : 'Available after a complete packet is issued'],
  ], 1, 'Verification');
  renderer.callout(
    'Not an insurance guarantee',
    'This packet documents HouseYield records and observed telemetry. It does not amend insurance coverage, certify code compliance, warrant uninterrupted connectivity, guarantee emergency response, or guarantee a premium credit. The carrier must independently determine device and installation eligibility.',
    'amber',
    'Limitations',
  );
  renderer.paragraph(
    'Primary carrier patterns used for packet design: Chubb water-loss guidance (installation certificate or installed-device photo plus invoice); Nationwide Smart Home activation requirements; Travelers water-sensor and water-shutoff protective-device categories; American Family Safe, Secure, Smart Home guidance; and manufacturer verification-letter patterns published by Flo by Moen and Phyn. Program rules must be re-confirmed with the carrier at submission.',
    { size: 8, color: COLORS.muted, section: 'Sources' },
  );
}

async function buildPdf(snapshot, options = {}) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(options.title || 'HouseYield Water-Loss Mitigation Evidence Packet');
  pdf.setAuthor('HouseYield');
  pdf.setSubject('Property-specific water-loss mitigation and commissioning evidence');
  pdf.setKeywords(['water leak detection', 'automatic shutoff', 'insurance underwriting', 'commissioning']);
  pdf.setCreationDate(new Date(snapshot.issuedAt || snapshot.generatedAt || Date.now()));
  const renderer = new PacketRenderer(pdf, snapshot, options.title || 'HouseYield Evidence Packet');
  await renderer.initialize();
  renderer.embeddedEvidenceImages = options.includeEvidence === false
    ? []
    : await embedEvidenceImages(pdf, snapshot.commissioning.evidencePhotoUrls || []);
  drawCover(renderer, options.subtitle || 'Property-specific installation, commissioning, monitoring, and response evidence for insurer review.');
  if (options.includeExecutive !== false) renderExecutive(renderer);
  if (options.includeInventory !== false) renderInventory(renderer);
  if (options.includeMonitoring !== false) renderMonitoring(renderer);
  if (options.includeCommissioning !== false) renderCommissioning(renderer);
  if (options.includeEvidence !== false) renderEvidence(renderer);
  renderer.finalize();
  return pdf.save();
}

export async function generateInsuranceOverviewPdf(snapshot) {
  return buildPdf(snapshot, {
    title: 'HouseYield Water-Loss Mitigation Program Overview',
    subtitle: 'Property protection architecture, enrolled equipment, monitoring evidence, and underwriting context.',
    includeCommissioning: false,
    includeEvidence: false,
  });
}

export async function generateInsuranceCertificatePdf(snapshot) {
  return buildPdf(snapshot, {
    title: 'HouseYield Installation and Commissioning Certificate',
    subtitle: 'Property-specific equipment, installation, functional test, monitoring, and installer-attestation record.',
    includeExecutive: false,
  });
}

export async function generateCombinedInsurancePacketPdf(snapshot) {
  return buildPdf(snapshot, {
    title: 'HouseYield Water-Loss Mitigation Evidence Packet',
  });
}

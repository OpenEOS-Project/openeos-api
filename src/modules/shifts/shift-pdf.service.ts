import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';
import { ShiftPlan, ShiftRegistrationStatus } from '../../database/entities';

@Injectable()
export class ShiftPdfService {
  private readonly logger = new Logger(ShiftPdfService.name);
  /** Resolved absolute path to the brand logo bundled with the API. The
   *  Docker image copies `/app/assets/logo_dark.png`; in dev, working dir
   *  is the repo root so the same relative resolution lands on it. */
  private readonly logoPath = this.resolveLogoPath();

  private resolveLogoPath(): string | null {
    const candidates = [
      path.resolve(process.cwd(), 'assets/logo_dark.png'),
      path.resolve(__dirname, '../../../assets/logo_dark.png'),
      path.resolve(__dirname, '../../../../assets/logo_dark.png'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  /**
   * Renders a shift plan as a landscape A4 PDF in calendar / matrix form:
   * - Rows = jobs (down the short vertical edge)
   * - Columns = chronological shift slots, grouped under a date header
   *   (across the long horizontal edge)
   * - Each cell lists the confirmed helpers for that job × shift, or '—'
   *   when nothing is scheduled there.
   *
   * The table is column-bound to A4 landscape with a sensible minimum
   * column width; when there are more shift columns than fit on one page
   * we slice the column list into page-sized chunks and emit one page per
   * chunk (with the job-name column repeated as the row header).
   */
  async generateShiftPlanPdf(plan: ShiftPlan): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margin: 36,
        info: { Title: plan.name, Author: 'OpenEOS' },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Draw the page header (logo + plan name + timestamp) at the top of
      // every NEW page. Fires for pages 2+; page 1 gets it explicitly below.
      doc.on('pageAdded', () => this.drawPageHeader(doc, plan));

      try {
        this.drawPageHeader(doc, plan);
        this.renderPlan(doc, plan);
      } catch (err) {
        reject(err as Error);
        return;
      }

      doc.end();
    });
  }

  /** Brand header at the top of every page: OpenEOS logo on the left, plan
   *  name beside it, generation timestamp right-aligned. Falls back to a
   *  text wordmark when the logo asset can't be located. */
  private drawPageHeader(doc: PDFKit.PDFDocument, plan: ShiftPlan): void {
    const left = doc.page.margins.left;
    const top = 16;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const logoHeight = 18;
    let textStartX = left;

    if (this.logoPath) {
      try {
        doc.image(this.logoPath, left, top, { height: logoHeight });
        // Image width — pdfkit doesn't expose it directly post-draw; trust
        // the aspect to land somewhere around 80pt for our wordmark logo.
        textStartX = left + 86;
      } catch (err) {
        this.logger.warn(`Logo couldn't be embedded into PDF: ${(err as Error).message}`);
        doc.font('Helvetica-Bold').fontSize(13).fillColor('#10b981')
          .text('OpenEOS', left, top + 2, { lineBreak: false });
        textStartX = left + doc.widthOfString('OpenEOS');
      }
    } else {
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#10b981')
        .text('OpenEOS', left, top + 2, { lineBreak: false });
      textStartX = left + doc.widthOfString('OpenEOS');
    }

    // Plan name next to the logo
    doc.font('Helvetica').fontSize(11).fillColor('#444')
      .text(`  ·  ${plan.name}`, textStartX, top + 4, { lineBreak: false });

    // Timestamp right-aligned on the same baseline. Pin Europe/Berlin so
    // the print reflects the user's local time even when the container
    // TZ env isn't set (defensive — the Dockerfile already sets it).
    const stamp = new Date().toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'Europe/Berlin',
    });
    doc.font('Helvetica').fontSize(9).fillColor('#999')
      .text(stamp, left, top + 4, { width, align: 'right' });

    // Thin separator under the header
    doc.save().moveTo(left, top + 26).lineTo(left + width, top + 26)
      .lineWidth(0.5).strokeColor('#d4d4d8').stroke().restore();

    // Move the content cursor below the header.
    doc.y = top + 36;
    doc.fillColor('#000');
  }

  // -----------------------------------------------------------------------
  //  Layout
  // -----------------------------------------------------------------------

  private renderPlan(doc: PDFKit.PDFDocument, plan: ShiftPlan): void {
    // The page header (drawPageHeader) already shows the plan name and
    // stamp, so the body starts directly with the table.

    // Collect every unique shift slot (date + startTime + endTime), sort
    // chronologically. These become the table columns.
    const slotMap = new Map<string, { date: string; startTime: string; endTime: string }>();
    for (const job of plan.jobs ?? []) {
      for (const shift of job.shifts ?? []) {
        const key = `${this.dateOnly(shift.date)}|${shift.startTime}|${shift.endTime}`;
        if (!slotMap.has(key)) {
          slotMap.set(key, {
            date: this.dateOnly(shift.date),
            startTime: shift.startTime,
            endTime: shift.endTime,
          });
        }
      }
    }
    const slots = Array.from(slotMap.values()).sort(
      (a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime),
    );

    if (slots.length === 0 || (plan.jobs?.length ?? 0) === 0) {
      doc.fontSize(11).font('Helvetica-Oblique').fillColor('#666')
        .text('Keine Schichten oder Arbeiten vorhanden.');
      return;
    }

    // Sort jobs by sortOrder for stable rows.
    const jobs = [...(plan.jobs ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);

    // Sizing — A4 landscape with 36pt margins ≈ 770pt usable width.
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const jobColWidth = 110; // generous for typical job names
    const minSlotColWidth = 90;
    const maxSlotsPerPage = Math.max(
      1,
      Math.floor((pageWidth - jobColWidth) / minSlotColWidth),
    );

    // Page the slot list so wide events still fit.
    for (let pageStart = 0; pageStart < slots.length; pageStart += maxSlotsPerPage) {
      if (pageStart > 0) doc.addPage();
      const pageSlots = slots.slice(pageStart, pageStart + maxSlotsPerPage);
      const slotColWidth = (pageWidth - jobColWidth) / pageSlots.length;
      this.renderTable(doc, plan, jobs, pageSlots, jobColWidth, slotColWidth);
    }
  }

  private renderTable(
    doc: PDFKit.PDFDocument,
    plan: ShiftPlan,
    jobs: ShiftPlan['jobs'],
    slots: Array<{ date: string; startTime: string; endTime: string }>,
    jobColWidth: number,
    slotColWidth: number,
  ): void {
    const left = doc.page.margins.left;
    const headerHeight = 36;
    let y = doc.y;

    // --- Header rows: dates (spanning) + times --------------------------
    // Group consecutive slots that share a date so we can draw the date
    // label once across all its time columns.
    type DateGroup = { date: string; spanStart: number; spanEnd: number };
    const dateGroups: DateGroup[] = [];
    for (let i = 0; i < slots.length; i++) {
      const last = dateGroups[dateGroups.length - 1];
      if (last && last.date === slots[i].date) {
        last.spanEnd = i;
      } else {
        dateGroups.push({ date: slots[i].date, spanStart: i, spanEnd: i });
      }
    }

    doc.save().rect(left, y, jobColWidth + slots.length * slotColWidth, headerHeight)
      .fill('#f4f4f5').restore().fillColor('#111');

    // Job-column header
    doc.fontSize(8).font('Helvetica-Bold')
      .text('Arbeit', left + 6, y + 6, { width: jobColWidth - 12 });

    // Date band
    for (const g of dateGroups) {
      const x = left + jobColWidth + g.spanStart * slotColWidth;
      const w = (g.spanEnd - g.spanStart + 1) * slotColWidth;
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#111')
        .text(this.formatDateHuman(g.date), x + 4, y + 4, { width: w - 8, align: 'center' });
    }

    // Time row underneath the date band
    for (let i = 0; i < slots.length; i++) {
      const x = left + jobColWidth + i * slotColWidth;
      doc.fontSize(8).font('Helvetica').fillColor('#444')
        .text(
          `${slots[i].startTime}–${slots[i].endTime}`,
          x + 4, y + 22,
          { width: slotColWidth - 8, align: 'center' },
        );
    }

    // Header bottom border
    doc.save().moveTo(left, y + headerHeight)
      .lineTo(left + jobColWidth + slots.length * slotColWidth, y + headerHeight)
      .lineWidth(0.5).strokeColor('#bbb').stroke().restore();

    y += headerHeight;

    // --- Body rows ------------------------------------------------------
    const rowMinHeight = 28;
    const bottomMargin = doc.page.height - doc.page.margins.bottom - 30;

    for (const job of jobs ?? []) {
      // Compute each cell's content first so the row matches the tallest,
      // and so we know which cells to highlight (full = light green).
      type Cell = { text: string; isFull: boolean; hasShift: boolean };
      const cells: Cell[] = [];
      for (const slot of slots) {
        const shift = (job.shifts ?? []).find(
          (s) =>
            this.dateOnly(s.date) === slot.date &&
            s.startTime === slot.startTime &&
            s.endTime === slot.endTime,
        );
        if (!shift) {
          cells.push({ text: '—', isFull: false, hasShift: false });
          continue;
        }
        const confirmed = (shift.registrations ?? []).filter(
          (r) => r.status === ShiftRegistrationStatus.CONFIRMED,
        );
        const isFull = confirmed.length >= shift.requiredWorkers;
        const text = confirmed.length === 0
          ? `(0/${shift.requiredWorkers})`
          : `(${confirmed.length}/${shift.requiredWorkers})\n${confirmed.map((r) => r.name).join('\n')}`;
        cells.push({ text, isFull, hasShift: true });
      }

      doc.fontSize(8).font('Helvetica');
      let rowHeight = rowMinHeight;
      for (let i = 0; i < slots.length; i++) {
        const h = doc.heightOfString(cells[i].text, { width: slotColWidth - 8 });
        if (h + 10 > rowHeight) rowHeight = h + 10;
      }
      // Job column height
      const jobHeight = doc.heightOfString(job.name, { width: jobColWidth - 12 }) + 10;
      if (jobHeight > rowHeight) rowHeight = jobHeight;

      // Page-break if this row wouldn't fit. addPage() triggers the
      // pageAdded listener which already draws the brand header and sets
      // doc.y to just below it, so we read from doc.y instead of resetting
      // to margins.top (that would put the row under the brand header).
      if (y + rowHeight > bottomMargin) {
        doc.addPage();
        y = doc.y;
        this.repeatHeader(doc, slots, jobColWidth, slotColWidth, y);
        y += headerHeight;
      }

      // Draw the row
      doc.save().rect(left, y, jobColWidth + slots.length * slotColWidth, rowHeight)
        .strokeColor('#e5e7eb').lineWidth(0.5).stroke().restore();

      // Job-color stripe
      doc.save().rect(left, y, 4, rowHeight).fill(job.color || '#888').restore();

      // Job name
      doc.fillColor('#111').fontSize(9).font('Helvetica-Bold')
        .text(job.name, left + 10, y + 5, { width: jobColWidth - 14 });

      // Cells
      for (let i = 0; i < slots.length; i++) {
        const x = left + jobColWidth + i * slotColWidth;
        const cell = cells[i];
        // Light-green wash for fully-booked shifts so the admin can see at
        // a glance which slots are already covered.
        if (cell.isFull) {
          doc.save().rect(x + 0.5, y + 0.5, slotColWidth - 1, rowHeight - 1)
            .fill('#d1fae5').restore();
        }
        doc.save().moveTo(x, y).lineTo(x, y + rowHeight)
          .strokeColor('#eef0f3').lineWidth(0.5).stroke().restore();
        doc.fillColor(!cell.hasShift ? '#aaa' : cell.isFull ? '#065f46' : '#111')
          .fontSize(8).font('Helvetica')
          .text(cell.text, x + 4, y + 5, { width: slotColWidth - 8 });
      }

      y += rowHeight;
    }
  }

  private repeatHeader(
    doc: PDFKit.PDFDocument,
    slots: Array<{ date: string; startTime: string; endTime: string }>,
    jobColWidth: number,
    slotColWidth: number,
    y: number,
  ): void {
    const left = doc.page.margins.left;
    const headerHeight = 36;
    doc.save().rect(left, y, jobColWidth + slots.length * slotColWidth, headerHeight)
      .fill('#f4f4f5').restore().fillColor('#111');
    doc.fontSize(8).font('Helvetica-Bold')
      .text('Arbeit', left + 6, y + 6, { width: jobColWidth - 12 });
    // Re-draw the date + time bands; the grouping logic from renderTable is
    // duplicated here, but on a continuation page so it's worth keeping
    // self-contained.
    let groupDate: string | null = null;
    let groupStart = 0;
    for (let i = 0; i <= slots.length; i++) {
      const isLast = i === slots.length;
      const currentDate = isLast ? null : slots[i].date;
      if (groupDate && currentDate !== groupDate) {
        const x = left + jobColWidth + groupStart * slotColWidth;
        const w = (i - groupStart) * slotColWidth;
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#111')
          .text(this.formatDateHuman(groupDate), x + 4, y + 4, { width: w - 8, align: 'center' });
        groupDate = null;
      }
      if (!groupDate && currentDate) { groupDate = currentDate; groupStart = i; }
    }
    for (let i = 0; i < slots.length; i++) {
      const x = left + jobColWidth + i * slotColWidth;
      doc.fontSize(8).font('Helvetica').fillColor('#444')
        .text(
          `${slots[i].startTime}–${slots[i].endTime}`,
          x + 4, y + 22,
          { width: slotColWidth - 8, align: 'center' },
        );
    }
    doc.save().moveTo(left, y + headerHeight)
      .lineTo(left + jobColWidth + slots.length * slotColWidth, y + headerHeight)
      .lineWidth(0.5).strokeColor('#bbb').stroke().restore();
  }

  // -----------------------------------------------------------------------
  //  Helpers
  // -----------------------------------------------------------------------

  /** Normalize Date | ISO-string to YYYY-MM-DD for stable grouping. */
  private dateOnly(d: Date | string): string {
    const s = typeof d === 'string' ? d : d.toISOString();
    return s.slice(0, 10);
  }

  /** Stylized human label: 'Sa 30.05.2026' */
  private formatDateHuman(d: string): string {
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleDateString('de-DE', {
      weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
    });
  }
}

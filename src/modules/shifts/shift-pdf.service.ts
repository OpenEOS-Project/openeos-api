import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { ShiftPlan, ShiftRegistrationStatus } from '../../database/entities';

@Injectable()
export class ShiftPdfService {
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

      try {
        this.renderPlan(doc, plan);
      } catch (err) {
        reject(err as Error);
        return;
      }

      doc.end();
    });
  }

  // -----------------------------------------------------------------------
  //  Layout
  // -----------------------------------------------------------------------

  private renderPlan(doc: PDFKit.PDFDocument, plan: ShiftPlan): void {
    // Title block
    doc
      .fontSize(16)
      .font('Helvetica-Bold')
      .fillColor('#111')
      .text(plan.name, { align: 'left' });
    doc
      .moveDown(0.2)
      .fontSize(9)
      .font('Helvetica')
      .fillColor('#666')
      .text(
        `Stand: ${new Date().toLocaleString('de-DE', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        })}`,
      );
    doc.moveDown(0.6).fillColor('#000');

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

    // Footer on the last page.
    doc.fontSize(8).font('Helvetica').fillColor('#999')
      .text(`OpenEOS · ${plan.name}`, doc.page.margins.left, doc.page.height - 24, {
        width: pageWidth, align: 'center',
      });
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
      // Compute each cell's height first so the row matches the tallest.
      const cellTexts: string[] = [];
      for (const slot of slots) {
        const shift = (job.shifts ?? []).find(
          (s) =>
            this.dateOnly(s.date) === slot.date &&
            s.startTime === slot.startTime &&
            s.endTime === slot.endTime,
        );
        if (!shift) {
          cellTexts.push('—');
          continue;
        }
        const confirmed = (shift.registrations ?? []).filter(
          (r) => r.status === ShiftRegistrationStatus.CONFIRMED,
        );
        if (confirmed.length === 0) {
          cellTexts.push(`(0/${shift.requiredWorkers})`);
        } else {
          const names = confirmed.map((r) => r.name).join('\n');
          cellTexts.push(`(${confirmed.length}/${shift.requiredWorkers})\n${names}`);
        }
      }

      doc.fontSize(8).font('Helvetica');
      let rowHeight = rowMinHeight;
      for (let i = 0; i < slots.length; i++) {
        const h = doc.heightOfString(cellTexts[i], { width: slotColWidth - 8 });
        if (h + 10 > rowHeight) rowHeight = h + 10;
      }
      // Job column height
      const jobHeight = doc.heightOfString(job.name, { width: jobColWidth - 12 }) + 10;
      if (jobHeight > rowHeight) rowHeight = jobHeight;

      // Page-break if this row wouldn't fit.
      if (y + rowHeight > bottomMargin) {
        doc.addPage();
        y = doc.page.margins.top;
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
        doc.save().moveTo(x, y).lineTo(x, y + rowHeight)
          .strokeColor('#eef0f3').lineWidth(0.5).stroke().restore();
        const text = cellTexts[i];
        doc.fillColor(text === '—' ? '#aaa' : '#111')
          .fontSize(8).font('Helvetica')
          .text(text, x + 4, y + 5, { width: slotColWidth - 8 });
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

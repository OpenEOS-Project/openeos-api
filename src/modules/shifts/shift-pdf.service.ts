import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { ShiftPlan, ShiftRegistrationStatus } from '../../database/entities';

@Injectable()
export class ShiftPdfService {
  /**
   * Generates a PDF document for a shift plan
   * Returns a Buffer containing the PDF data
   */
  async generateShiftPlanPdf(plan: ShiftPlan): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: plan.name,
          Author: 'OpenEOS',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      doc
        .fontSize(24)
        .font('Helvetica-Bold')
        .text(plan.name, { align: 'center' });

      if (plan.description) {
        doc
          .moveDown(0.5)
          .fontSize(12)
          .font('Helvetica')
          .fillColor('#666666')
          .text(plan.description, { align: 'center' });
      }

      doc.moveDown(1);
      doc.fillColor('#000000');

      // Sort jobs by sortOrder
      const jobs = [...(plan.jobs || [])].sort((a, b) => a.sortOrder - b.sortOrder);

      for (const job of jobs) {
        // Job header with color
        doc
          .fontSize(16)
          .font('Helvetica-Bold')
          .fillColor(job.color || '#333333')
          .text(job.name);

        if (job.description) {
          doc
            .fontSize(10)
            .font('Helvetica')
            .fillColor('#666666')
            .text(job.description);
        }

        doc.moveDown(0.5);
        doc.fillColor('#000000');

        // Sort shifts by date and time
        const shifts = [...(job.shifts || [])].sort((a, b) => {
          const dateA = new Date(a.date).getTime();
          const dateB = new Date(b.date).getTime();
          if (dateA !== dateB) return dateA - dateB;
          return a.startTime.localeCompare(b.startTime);
        });

        if (shifts.length === 0) {
          doc
            .fontSize(10)
            .font('Helvetica-Oblique')
            .fillColor('#999999')
            .text('Keine Schichten definiert');
          doc.fillColor('#000000');
        } else {
          for (const shift of shifts) {
            // Shift header line
            const shiftDate = this.formatDate(shift.date);
            const shiftLine = `${shiftDate}, ${shift.startTime} - ${shift.endTime}`;

            // Count confirmed registrations
            const confirmedRegs = (shift.registrations || []).filter(
              (r) => r.status === ShiftRegistrationStatus.CONFIRMED,
            );

            doc
              .fontSize(11)
              .font('Helvetica-Bold')
              .text(shiftLine, { continued: true })
              .font('Helvetica')
              .text(` (${confirmedRegs.length}/${shift.requiredWorkers} Helfer)`);

            // List helpers
            if (confirmedRegs.length > 0) {
              doc.moveDown(0.3);
              for (const reg of confirmedRegs) {
                let helperText = `  • ${reg.name}`;
                if (reg.email) {
                  helperText += ` (${reg.email})`;
                }
                if (reg.phone) {
                  helperText += ` - ${reg.phone}`;
                }
                doc.fontSize(10).font('Helvetica').text(helperText);
              }
            } else {
              doc
                .fontSize(10)
                .font('Helvetica-Oblique')
                .fillColor('#999999')
                .text('  Noch keine Helfer angemeldet');
              doc.fillColor('#000000');
            }

            doc.moveDown(0.5);
          }
        }

        doc.moveDown(0.5);

        // Add page break if needed (check remaining space)
        if (doc.y > 700) {
          doc.addPage();
        }
      }

      // Footer with generation timestamp
      const now = new Date();
      const timestamp = now.toLocaleString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      doc
        .moveDown(2)
        .fontSize(9)
        .font('Helvetica')
        .fillColor('#999999')
        .text(`Erstellt am ${timestamp} mit OpenEOS`, { align: 'center' });

      doc.end();
    });
  }

  private formatDate(dateInput: Date | string): string {
    const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    };
    return date.toLocaleDateString('de-DE', options);
  }
}

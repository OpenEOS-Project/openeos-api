import { escapeHtml } from '../email/email-template';
import type { ReceiptBlock } from './receipt-blocks';

/**
 * HTML eines Belegs fuer die Mail (Tabellen, Inline-Stile — wie die
 * uebrigen Mails). Der QR-Code der TSE haengt als Bild an (`cid`), die
 * Angaben darunter stehen zusaetzlich als Text.
 */
const FONT = 'Arial, Helvetica, sans-serif';
const MONO = "'Courier New', Courier, monospace";

export function blocksToHtml(
  blocks: ReceiptBlock[],
  qrCid?: (value: string) => string | null,
): string {
  const rows = blocks.map((b) => {
    switch (b.type) {
      case 'banner':
        return `<tr><td colspan="2" align="center" style="background:#14180f;color:#ffffff;font-family:${FONT};font-size:13px;font-weight:bold;padding:6px 8px;letter-spacing:1px">${escapeHtml(b.text)}</td></tr>`;
      case 'heading':
        return `<tr><td colspan="2" align="center" style="font-family:${FONT};font-size:20px;font-weight:bold;color:#14180f;padding:10px 0 2px">${escapeHtml(b.text)}</td></tr>`;
      case 'title':
        return `<tr><td colspan="2" align="center" style="font-family:${FONT};font-size:17px;font-weight:bold;color:#14180f;padding:10px 0 6px;letter-spacing:1px">${escapeHtml(b.text)}</td></tr>`;
      case 'center':
        return `<tr><td colspan="2" align="center" style="font-family:${FONT};font-size:13px;color:${b.muted ? '#6b7068' : '#14180f'};padding:1px 0">${escapeHtml(b.text)}</td></tr>`;
      case 'text':
        return `<tr><td colspan="2" style="font-family:${FONT};font-size:14px;color:${b.muted ? '#6b7068' : '#14180f'};${b.bold ? 'font-weight:bold;' : ''}padding:2px 0">${escapeHtml(b.text)}</td></tr>`;
      case 'note':
        return `<tr><td colspan="2" style="font-family:${FONT};font-size:12px;line-height:1.5;color:#6b7068;padding:4px 0">${escapeHtml(b.text)}</td></tr>`;
      case 'row':
        return `<tr><td style="font-family:${FONT};font-size:14px;color:#14180f;${b.bold ? 'font-weight:bold;font-size:16px;' : ''}padding:2px 8px 2px 0">${escapeHtml(b.label)}</td><td align="right" style="font-family:${FONT};font-size:14px;color:#14180f;${b.bold ? 'font-weight:bold;font-size:16px;' : ''}padding:2px 0;white-space:nowrap">${escapeHtml(b.value)}</td></tr>`;
      case 'item':
        return `<tr><td style="font-family:${FONT};font-size:14px;color:#14180f;padding:2px 8px 2px 0">${escapeHtml(b.qty)} ${escapeHtml(b.name)}</td><td align="right" style="font-family:${FONT};font-size:14px;color:#14180f;padding:2px 0;white-space:nowrap">${escapeHtml(b.amount)}</td></tr>`;
      case 'rule':
        return `<tr><td colspan="2" style="padding:6px 0"><div style="border-top:${b.double ? '3px double' : '1px solid'} #14180f;height:0;line-height:0;font-size:0">&nbsp;</div></td></tr>`;
      case 'mono':
        return `<tr><td colspan="2" style="font-family:${FONT};font-size:12px;color:#6b7068;padding:3px 0 0">${b.label ? `${escapeHtml(b.label)}:` : ''}<div style="font-family:${MONO};font-size:11px;color:#14180f;word-break:break-all">${escapeHtml(b.text)}</div></td></tr>`;
      case 'qr': {
        const cid = qrCid?.(b.value);
        if (!cid) return '';
        return `<tr><td colspan="2" align="center" style="padding:8px 0"><img src="cid:${escapeHtml(cid)}" width="140" height="140" alt="QR-Code der TSE" style="display:block;width:140px;height:140px;border:0" />${b.caption ? `<div style="font-family:${FONT};font-size:11px;color:#6b7068">${escapeHtml(b.caption)}</div>` : ''}</td></tr>`;
      }
      case 'fill': {
        const lines = Array.from(
          { length: b.lines },
          () =>
            `<div style="border-bottom:1px dashed #14180f;height:24px"></div>`,
        ).join('');
        return `<tr><td colspan="2" style="font-family:${FONT};font-size:13px;color:#14180f;padding:8px 0 2px">${escapeHtml(b.label)}:${lines}</td></tr>`;
      }
    }
  });
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;max-width:420px;margin:0 auto">${rows.join('')}</table>`;
}
